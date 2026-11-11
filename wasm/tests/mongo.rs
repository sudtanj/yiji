//! Runs only when YIJI_TEST_MONGO="host:port,user,password" is set. Auth database is admin.

use serde_json::Value;
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncReadCompatExt};
use yiji_wasm::mongo::Mongo;

async fn run(conn: &mut Mongo<Compat<TcpStream>>, db: &str, cmd: &str) -> Value {
    let reply = conn.run_json(db, cmd).await.unwrap();
    serde_json::from_str(&reply).unwrap()
}

#[tokio::test]
async fn auth_list_databases_and_find() {
    let Ok(target) = std::env::var("YIJI_TEST_MONGO") else {
        eprintln!("YIJI_TEST_MONGO not set, skipping");
        return;
    };
    let parts: Vec<&str> = target.split(',').collect();
    let [addr, user, password] = parts[..] else {
        panic!("YIJI_TEST_MONGO must be host:port,user,password");
    };

    let stream = TcpStream::connect(addr).await.unwrap();
    let mut conn = Mongo::connect(stream.compat(), user, password, "admin")
        .await
        .unwrap();

    let reply = run(&mut conn, "admin", r#"{"listDatabases":1}"#).await;
    assert!(reply["databases"].is_array());

    let db = "yiji_test";
    run(
        &mut conn,
        db,
        r#"{"delete":"items","deletes":[{"q":{},"limit":0}]}"#,
    )
    .await;
    run(
        &mut conn,
        db,
        r#"{"insert":"items","documents":[{"_id":{"$oid":"507f1f77bcf86cd799439011"},"a":1}]}"#,
    )
    .await;
    let reply = run(&mut conn, db, r#"{"find":"items","filter":{}}"#).await;
    assert_eq!(reply["cursor"]["firstBatch"][0]["a"], 1);

    // An untyped string id would match nothing; only a real ObjectId finds the document.
    let by_id = r#"{"find":"items","filter":{"_id":{"$oid":"507f1f77bcf86cd799439011"}}}"#;
    let reply = run(&mut conn, db, by_id).await;
    assert_eq!(reply["cursor"]["firstBatch"].as_array().unwrap().len(), 1);
    assert_eq!(
        reply["cursor"]["firstBatch"][0]["_id"]["$oid"],
        "507f1f77bcf86cd799439011"
    );

    let failed = conn.run_json(db, r#"{"noSuchCommand":1}"#).await;
    assert!(failed.unwrap_err().contains("no such command"));

    let stream = TcpStream::connect(addr).await.unwrap();
    let wrong = Mongo::connect(stream.compat(), user, "wrong-password", "admin").await;
    assert!(wrong.is_err());
}
