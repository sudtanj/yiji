//! Runs only when YIJI_TEST_PG="host:port,user,password,database" is set.

use serde_json::{json, Value};
use yiji_wasm::pg;

async fn run(client: &tokio_postgres::Client, sql: &str) -> Value {
    let reply = pg::query(client, sql).await.unwrap();
    serde_json::from_str(&reply).unwrap()
}

#[tokio::test]
async fn simple_query_against_postgres() {
    let Ok(target) = std::env::var("YIJI_TEST_PG") else {
        eprintln!("YIJI_TEST_PG not set, skipping");
        return;
    };
    let parts: Vec<&str> = target.split(',').collect();
    let [addr, user, password, database] = parts[..] else {
        panic!("YIJI_TEST_PG must be host:port,user,password,database");
    };

    let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let (client, connection) = pg::connect(stream, user, password, database)
        .await
        .unwrap();
    tokio::spawn(connection);

    let reply = run(&client, "select 1 as n, null as missing").await;
    assert_eq!(reply["columns"][0]["name"], "n");
    assert_eq!(reply["rows"], json!([["1", null]]));

    let reply = run(
        &client,
        "create temp table t(i int); insert into t values (1),(2); select i from t order by i",
    )
    .await;
    assert_eq!(reply["rows"], json!([["1"], ["2"]]));

    let failed = pg::query(&client, "select * from no_such_table").await;
    assert!(failed.is_err());
}
