use crate::{
    mongo::Mongo,
    pg,
    transport::{self, Io},
};
use futures::lock::Mutex;
use std::pin::Pin;
use tokio_util::compat::FuturesAsyncReadCompatExt;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

#[wasm_bindgen]
pub struct PgConn {
    client: Option<tokio_postgres::Client>,
}

#[wasm_bindgen]
impl PgConn {
    pub async fn connect(
        relay_url: String,
        relay_token: String,
        host: String,
        port: u16,
        user: String,
        password: String,
        database: String,
    ) -> Result<PgConn, String> {
        let io = transport::open(&relay_url, &relay_token, &host, port).await?;
        let (client, connection) = pg::connect(io.compat(), &user, &password, &database).await?;
        // A dropped connection shows up as an error on the next query.
        spawn_local(async move {
            let _ = connection.await;
        });
        Ok(PgConn {
            client: Some(client),
        })
    }

    pub async fn query(&self, sql: String) -> Result<String, String> {
        let client = self.client.as_ref().ok_or("connection closed")?;
        pg::query(client, &sql).await
    }

    pub fn close(&mut self) {
        self.client = None;
    }
}

#[wasm_bindgen]
pub struct MongoConn {
    conn: Option<Mutex<Mongo<Pin<Box<dyn Io>>>>>,
}

#[wasm_bindgen]
impl MongoConn {
    pub async fn connect(
        relay_url: String,
        relay_token: String,
        host: String,
        port: u16,
        user: String,
        password: String,
        auth_db: String,
    ) -> Result<MongoConn, String> {
        let io = transport::open(&relay_url, &relay_token, &host, port).await?;
        let conn = Mongo::connect(io, &user, &password, &auth_db).await?;
        Ok(MongoConn {
            conn: Some(Mutex::new(conn)),
        })
    }

    #[wasm_bindgen(js_name = runCommand)]
    pub async fn run_command(&self, db: String, cmd_json: String) -> Result<String, String> {
        let conn = self.conn.as_ref().ok_or("connection closed")?;
        conn.lock().await.run_json(&db, &cmd_json).await
    }

    pub fn close(&mut self) {
        self.conn = None;
    }
}
