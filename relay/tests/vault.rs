use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use yiji_relay::{serve, Config};

const TOKEN: &str = "0123456789abcdef0123456789abcdef";
const TURSO_TOKEN: &str = "fake-turso-token-4f9c1e";
const LIST: &str = r#"{"op":"list"}"#;
const REPLY_TIMEOUT: Duration = Duration::from_secs(40);

type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// The sqld the CI job starts. Real-sqld tests are `#[ignore]` and fail loudly without it.
fn libsql_url() -> String {
    let url = std::env::var("YIJI_LIBSQL_URL").expect("YIJI_LIBSQL_URL must point to a sqld");
    assert!(!url.is_empty(), "YIJI_LIBSQL_URL is empty");
    url
}

/// Row ids and prefixes are unique per test run because sqld state is shared between tests.
fn unique(name: &str) -> String {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{name}-{nanos}-{n}/")
}

async fn start_relay_with(config: Config) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    tokio::spawn(serve(listener, config));
    url
}

async fn vault_relay(turso_url: &str, turso_token: &str) -> String {
    start_relay_with(Config::with_vault(TOKEN, "", "*", turso_url, turso_token).unwrap()).await
}

async fn send_hello(url: &str, hello: &Value) -> Client {
    let (mut ws, _) = connect_async(url).await.unwrap();
    ws.send(Message::text(hello.to_string())).await.unwrap();
    ws
}

async fn vault_hello(url: &str, token: &str) -> Client {
    send_hello(url, &json!({ "token": token, "vault": true })).await
}

async fn open_vault(url: &str) -> Client {
    let mut ws = vault_hello(url, TOKEN).await;
    assert_eq!(ws.next().await.unwrap().unwrap(), Message::text("ok"));
    ws
}

async fn expect_refusal(mut ws: Client, reason: &str) {
    match ws.next().await {
        Some(Ok(Message::Close(Some(frame)))) => {
            assert_eq!(frame.code, CloseCode::Policy);
            assert_eq!(frame.reason.as_str(), reason);
        }
        other => panic!("expected close, got {other:?}"),
    }
}

async fn call(ws: &mut Client, request: &str) -> Value {
    ws.send(Message::text(request)).await.unwrap();
    match timeout(REPLY_TIMEOUT, ws.next()).await.expect("no reply from the relay") {
        Some(Ok(Message::Text(text))) => serde_json::from_str(&text).unwrap(),
        other => panic!("expected a text reply, got {other:?}"),
    }
}

fn row(id: &str, data: &str, updated_at: i64) -> Value {
    json!({ "id": id, "data": data, "updated_at": updated_at })
}

fn with_row(op: &str, row: &Value) -> String {
    json!({ "op": op, "row": row }).to_string()
}

fn remove(id: &str) -> String {
    json!({ "op": "remove", "id": id }).to_string()
}

/// This test's rows from a `list` reply, ordered by id.
fn mine(listing: &Value, prefix: &str) -> Vec<Value> {
    let rows = listing["rows"].as_array().expect("list reply has rows");
    let mut rows: Vec<Value> = rows
        .iter()
        .filter(|row| row["id"].as_str().is_some_and(|id| id.starts_with(prefix)))
        .cloned()
        .collect();
    rows.sort_by_key(|row| row["id"].as_str().unwrap().to_owned());
    rows
}

#[tokio::test]
#[ignore = "needs YIJI_LIBSQL_URL"]
async fn vault_round_trip_against_libsql() {
    let relay = vault_relay(&libsql_url(), "").await;
    let prefix = unique("round-trip");
    let (a, b) = (format!("{prefix}a"), format!("{prefix}b"));
    let mut ws = open_vault(&relay).await;

    assert!(mine(&call(&mut ws, LIST).await, &prefix).is_empty());

    let first = row(&a, "one", 1);
    assert_eq!(call(&mut ws, &with_row("create", &first)).await, json!({}));
    assert_eq!(mine(&call(&mut ws, LIST).await, &prefix), [first.clone()]);

    let ignored = row(&a, "two", 2);
    assert_eq!(call(&mut ws, &with_row("create", &ignored)).await, json!({}));
    assert_eq!(mine(&call(&mut ws, LIST).await, &prefix), [first]);

    let replaced = row(&a, "three", 3);
    assert_eq!(call(&mut ws, &with_row("put", &replaced)).await, json!({}));
    assert_eq!(mine(&call(&mut ws, LIST).await, &prefix), [replaced.clone()]);

    let awkward = "q'\"; DROP TABLE connections;-- \u{e9}\u{4e2d}\n";
    let second = row(&b, awkward, 1_700_000_000_000);
    assert_eq!(call(&mut ws, &with_row("put", &second)).await, json!({}));
    let listed = mine(&call(&mut ws, LIST).await, &prefix);
    assert_eq!(listed, [replaced.clone(), second.clone()]);
    assert!(listed[1]["updated_at"].is_i64(), "updated_at must stay an integer");

    let mut other = open_vault(&relay).await;
    assert_eq!(mine(&call(&mut other, LIST).await, &prefix), [replaced, second.clone()]);

    assert_eq!(call(&mut ws, &remove(&a)).await, json!({}));
    assert_eq!(mine(&call(&mut ws, LIST).await, &prefix), [second]);
    assert_eq!(call(&mut ws, &remove(&a)).await, json!({}));
    assert_eq!(call(&mut ws, &remove(&b)).await, json!({}));
    assert!(mine(&call(&mut ws, LIST).await, &prefix).is_empty());
}

#[tokio::test]
#[ignore = "needs YIJI_LIBSQL_URL"]
async fn bad_requests_get_an_error_and_the_socket_stays_usable() {
    let relay = vault_relay(&libsql_url(), "").await;
    let mut ws = open_vault(&relay).await;
    let bad = [
        "not json",
        "",
        "[]",
        "{}",
        r#"{"op":"drop"}"#,
        r#"{"op":"LIST"}"#,
        r#"{"op":"put"}"#,
        r#"{"op":"remove","id":5}"#,
        r#"{"op":"put","row":{"id":"x","data":"d","updated_at":"1"}}"#,
        r#"{"op":"put","row":{"id":"x","data":"d"}}"#,
    ];
    for text in bad {
        let reply = call(&mut ws, text).await;
        assert_eq!(reply, json!({ "error": "bad request" }), "{text:?}");
        let listing = call(&mut ws, LIST).await;
        assert!(listing["rows"].is_array(), "list after {text:?}: {listing}");
    }
}

#[tokio::test]
async fn unreachable_turso_answers_an_error_and_keeps_the_socket() {
    let relay = vault_relay("http://127.0.0.1:1", TURSO_TOKEN).await;
    let mut ws = open_vault(&relay).await;
    let put = with_row("put", &row("a", "d", 1));
    for request in [LIST, put.as_str(), LIST] {
        let reply = call(&mut ws, request).await;
        assert_eq!(reply, json!({ "error": "turso unreachable" }));
        assert!(!reply.to_string().contains(TURSO_TOKEN));
    }
}

#[tokio::test]
async fn bad_token_closes_the_vault_hello() {
    let relay = vault_relay("http://127.0.0.1:1", "").await;
    expect_refusal(vault_hello(&relay, &"x".repeat(32)).await, "bad token").await;
    expect_refusal(vault_hello(&relay, "").await, "bad token").await;
}

#[tokio::test]
async fn vault_hello_without_turso_is_refused() {
    let relay = start_relay_with(Config::new(TOKEN, "127.0.0.1:1", "*").unwrap()).await;
    expect_refusal(vault_hello(&relay, TOKEN).await, "vault not configured").await;
}

#[tokio::test]
async fn vault_only_relay_refuses_tcp_targets() {
    let relay = vault_relay("http://127.0.0.1:1", "").await;
    let hello = json!({ "token": TOKEN, "host": "127.0.0.1", "port": 1 });
    expect_refusal(send_hello(&relay, &hello).await, "target not allowed").await;
}

async fn read_http_request(socket: &mut TcpStream) -> String {
    let mut data = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = socket.read(&mut buf).await.unwrap();
        data.extend_from_slice(&buf[..n]);
        let text = String::from_utf8_lossy(&data);
        let complete = text.split_once("\r\n\r\n").is_some_and(|(head, body)| {
            let head = head.to_ascii_lowercase();
            let length = head.lines().find_map(|line| {
                line.strip_prefix("content-length: ")?.trim().parse::<usize>().ok()
            });
            body.len() >= length.unwrap_or(0)
        });
        if complete || n == 0 {
            return text.into_owned();
        }
    }
}

/// A stand-in for Turso's HTTP pipeline endpoint: answers every POST the same way and records
/// the raw requests.
async fn fake_turso(status: &'static str, body: String) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let log = Arc::new(Mutex::new(Vec::new()));
    let seen = log.clone();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            seen.lock().unwrap().push(request);
            let reply = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\n\
                 content-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(reply.as_bytes()).await;
        }
    });
    (url, log)
}

fn pipeline_ok(rows: Value) -> String {
    json!({ "results": [
        { "type": "ok", "response": { "type": "execute", "result": { "cols": [], "rows": rows } } },
        { "type": "ok", "response": { "type": "close" } },
    ] })
    .to_string()
}

fn request_body(raw: &str) -> Value {
    serde_json::from_str(raw.split_once("\r\n\r\n").unwrap().1).unwrap()
}

#[tokio::test]
async fn turso_receives_fixed_sql_bound_arguments_and_the_bearer_token() {
    let cells = json!([[
        { "type": "text", "value": "a" },
        { "type": "text", "value": "d" },
        { "type": "integer", "value": "123" },
    ]]);
    let (turso, log) = fake_turso("200 OK", pipeline_ok(cells)).await;
    let relay = vault_relay(&turso, TURSO_TOKEN).await;
    let mut ws = open_vault(&relay).await;

    let listing = call(&mut ws, LIST).await;
    assert_eq!(listing, json!({ "rows": [row("a", "d", 123)] }));
    let injection = "x'); DROP TABLE connections;--";
    let put = with_row("put", &row(injection, injection, 5));
    assert_eq!(call(&mut ws, &put).await, json!({}));

    let seen = log.lock().unwrap().clone();
    assert_eq!(seen.len(), 3, "create table once, then one statement per request");
    for raw in &seen {
        let head = raw.to_ascii_lowercase();
        assert!(head.starts_with("post /v2/pipeline "), "{raw}");
        assert!(head.contains(&format!("authorization: bearer {TURSO_TOKEN}")), "{raw}");
    }
    let sql = |raw: &String| request_body(raw)["requests"][0]["stmt"]["sql"].to_string();
    assert!(sql(&seen[0]).contains("CREATE TABLE IF NOT EXISTS connections"));
    assert!(sql(&seen[1]).contains("SELECT id, data, updated_at FROM connections"));
    assert!(sql(&seen[2]).contains("INSERT INTO connections"));
    assert!(!sql(&seen[2]).contains("DROP"));
    let stmt = &request_body(&seen[2])["requests"][0]["stmt"];
    assert_eq!(
        stmt["args"],
        json!([
            { "type": "text", "value": injection },
            { "type": "text", "value": injection },
            { "type": "integer", "value": "5" },
        ])
    );
    assert_eq!(request_body(&seen[2])["requests"][1], json!({ "type": "close" }));
}

#[tokio::test]
async fn turso_http_failure_hides_the_response_body_and_token() {
    let body = format!("denied for {TURSO_TOKEN}");
    let (turso, log) = fake_turso("401 Unauthorized", body).await;
    let relay = vault_relay(&turso, TURSO_TOKEN).await;
    let mut ws = open_vault(&relay).await;
    for _ in 0..2 {
        let reply = call(&mut ws, LIST).await;
        assert_eq!(reply, json!({ "error": "turso http 401 Unauthorized" }));
    }
    let seen = log.lock().unwrap().clone();
    assert_eq!(seen.len(), 2, "table creation is retried until it succeeds");
}

#[tokio::test]
async fn turso_sql_error_is_relayed_and_truncated() {
    let message = "e".repeat(500);
    let body = json!({ "results": [{ "type": "error", "error": { "message": message } }] });
    let (turso, _) = fake_turso("200 OK", body.to_string()).await;
    let relay = vault_relay(&turso, TURSO_TOKEN).await;
    let mut ws = open_vault(&relay).await;
    let reply = call(&mut ws, LIST).await;
    assert_eq!(reply, json!({ "error": "e".repeat(200) }));
}

#[tokio::test]
async fn garbled_turso_replies_become_bad_turso_response() {
    for body in ["<html>oops</html>", "{}", r#"{"results":[{"type":"ok"}]}"#] {
        let (turso, _) = fake_turso("200 OK", body.to_owned()).await;
        let relay = vault_relay(&turso, "").await;
        let mut ws = open_vault(&relay).await;
        let reply = call(&mut ws, LIST).await;
        assert_eq!(reply, json!({ "error": "bad turso response" }), "{body}");
    }
}

#[tokio::test]
async fn list_rejects_rows_with_null_or_missing_cells() {
    let rows = json!([[
        { "type": "text", "value": "a" },
        { "type": "null" },
        { "type": "integer", "value": "1" },
    ]]);
    let (turso, _) = fake_turso("200 OK", pipeline_ok(rows)).await;
    let relay = vault_relay(&turso, "").await;
    let mut ws = open_vault(&relay).await;
    let reply = call(&mut ws, LIST).await;
    assert_eq!(reply, json!({ "error": "bad turso response" }));
}
