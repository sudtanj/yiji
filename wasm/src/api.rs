use crate::{
    mongo::Mongo,
    pg,
    transport::{self, Io},
};
use futures::lock::Mutex;
use std::{cell::RefCell, pin::Pin, rc::Rc};
use tokio_util::compat::FuturesAsyncReadCompatExt;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

#[wasm_bindgen]
pub struct PgConn {
    client: RefCell<Option<Rc<tokio_postgres::Client>>>,
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
            client: RefCell::new(Some(Rc::new(client))),
        })
    }

    pub async fn query(&self, sql: String) -> Result<String, String> {
        let client = self.client.borrow().clone().ok_or("connection closed")?;
        pg::query(&client, &sql).await
    }

    pub fn close(&self) {
        self.client.borrow_mut().take();
    }
}

type Session = Mutex<Mongo<Pin<Box<dyn Io>>>>;

#[wasm_bindgen]
pub struct MongoConn {
    conn: RefCell<Option<Rc<Session>>>,
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
            conn: RefCell::new(Some(Rc::new(Mutex::new(conn)))),
        })
    }

    #[wasm_bindgen(js_name = runCommand)]
    pub async fn run_command(&self, db: String, cmd_json: String) -> Result<String, String> {
        let conn = self.conn.borrow().clone().ok_or("connection closed")?;
        conn.lock().await.run_json(&db, &cmd_json).await
    }

    pub fn close(&self) {
        self.conn.borrow_mut().take();
    }
}
