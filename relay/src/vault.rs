use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const TURSO_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_ERROR_LEN: usize = 200;
const BAD_RESPONSE: &str = "bad turso response";

const CREATE_TABLE: &str = "CREATE TABLE IF NOT EXISTS connections \
    (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)";
const LIST: &str = "SELECT id, data, updated_at FROM connections";
const PUT: &str = "INSERT INTO connections (id, data, updated_at) VALUES (?, ?, ?) \
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at";
const CREATE: &str = "INSERT INTO connections (id, data, updated_at) VALUES (?, ?, ?) \
    ON CONFLICT(id) DO NOTHING";
const REMOVE: &str = "DELETE FROM connections WHERE id = ?";

#[derive(Deserialize, Serialize)]
struct Row {
    id: String,
    data: String,
    updated_at: i64,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Request {
    List,
    Put { row: Row },
    Create { row: Row },
    Remove { id: String },
}

/// The encrypted connection list, stored in Turso (or sqld) over its HTTP pipeline API.
pub struct Vault {
    client: Client,
    endpoint: String,
    token: String,
    ready: AtomicBool,
}

impl Vault {
    /// `url` is `https://` or `libsql://` (mapped to `https://`); `token` may be empty.
    pub fn new(url: &str, token: &str) -> Result<Self, &'static str> {
        let endpoint = format!("{}/v2/pipeline", normalize_url(url)?);
        let client = Client::builder()
            .timeout(TURSO_TIMEOUT)
            .build()
            .map_err(|_| "cannot build HTTP client")?;
        Ok(Self {
            client,
            endpoint,
            token: token.trim().to_owned(),
            ready: AtomicBool::new(false),
        })
    }

    /// Answers one client request with one JSON reply; failures become `{"error":...}`.
    pub async fn handle(&self, text: &str) -> String {
        let reply = match serde_json::from_str::<Request>(text) {
            Ok(request) => self.run(&request).await,
            Err(_) => Err("bad request".to_owned()),
        };
        reply.unwrap_or_else(|e| json!({ "error": e })).to_string()
    }

    async fn run(&self, request: &Request) -> Result<Value, String> {
        if !self.ready.load(Ordering::Relaxed) {
            self.execute(CREATE_TABLE, Vec::new()).await?;
            self.ready.store(true, Ordering::Relaxed);
        }
        let (sql, args) = statement(request);
        let result = self.execute(sql, args).await?;
        Ok(match request {
            Request::List => json!({ "rows": parse_rows(&result)? }),
            _ => json!({}),
        })
    }

    async fn execute(&self, sql: &str, args: Vec<Value>) -> Result<Value, String> {
        let body = pipeline_body(sql, args);
        let mut request = self.client.post(&self.endpoint).json(&body);
        if !self.token.is_empty() {
            request = request.bearer_auth(&self.token);
        }
        let response = request.send().await.map_err(|e| {
            match e.is_timeout() {
                true => "turso timed out".to_owned(),
                false => "turso unreachable".to_owned(),
            }
        })?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("turso http {status}"));
        }
        let reply: Value = response.json().await.map_err(|_| BAD_RESPONSE.to_owned())?;
        parse_result(&reply)
    }
}

fn normalize_url(url: &str) -> Result<String, &'static str> {
    let url = url.trim().trim_end_matches('/');
    if let Some(rest) = url.strip_prefix("libsql://") {
        return Ok(format!("https://{rest}"));
    }
    let loopback = ["http://127.0.0.1", "http://localhost"].iter().any(|prefix| {
        url.strip_prefix(prefix).is_some_and(|rest| rest.is_empty() || rest.starts_with([':', '/']))
    });
    if url.starts_with("https://") || loopback {
        return Ok(url.to_owned());
    }
    Err("YIJI_TURSO_URL must start with https:// or libsql:// (http:// only for localhost)")
}

fn text_arg(value: &str) -> Value {
    json!({ "type": "text", "value": value })
}

fn integer_arg(value: i64) -> Value {
    json!({ "type": "integer", "value": value.to_string() })
}

fn row_args(row: &Row) -> Vec<Value> {
    vec![
        text_arg(&row.id),
        text_arg(&row.data),
        integer_arg(row.updated_at),
    ]
}

fn statement(request: &Request) -> (&'static str, Vec<Value>) {
    match request {
        Request::List => (LIST, Vec::new()),
        Request::Put { row } => (PUT, row_args(row)),
        Request::Create { row } => (CREATE, row_args(row)),
        Request::Remove { id } => (REMOVE, vec![text_arg(id)]),
    }
}

fn pipeline_body(sql: &str, args: Vec<Value>) -> Value {
    json!({ "requests": [
        { "type": "execute", "stmt": { "sql": sql, "args": args } },
        { "type": "close" },
    ] })
}

/// Extracts `results[0].response.result`, or the error message Turso reported.
fn parse_result(body: &Value) -> Result<Value, String> {
    let first = body.pointer("/results/0").ok_or(BAD_RESPONSE)?;
    match first.get("type").and_then(Value::as_str) {
        Some("ok") => match first.pointer("/response/result") {
            Some(result) => Ok(result.clone()),
            None => Err(BAD_RESPONSE.into()),
        },
        Some("error") => {
            let message = first.pointer("/error/message").and_then(Value::as_str);
            let message = message.unwrap_or("turso error");
            Err(message.chars().take(MAX_ERROR_LEN).collect())
        }
        _ => Err(BAD_RESPONSE.into()),
    }
}

fn parse_rows(result: &Value) -> Result<Vec<Row>, String> {
    let rows = result.get("rows").and_then(Value::as_array);
    let rows = rows.ok_or(BAD_RESPONSE)?;
    let parsed = rows.iter().map(parse_row).collect::<Option<Vec<_>>>();
    parsed.ok_or_else(|| BAD_RESPONSE.to_owned())
}

fn parse_row(row: &Value) -> Option<Row> {
    let [id, data, updated_at] = row.as_array()?.as_slice() else {
        return None;
    };
    let cell = |cell: &Value| cell.get("value")?.as_str().map(str::to_owned);
    Some(Row {
        id: cell(id)?,
        data: cell(data)?,
        updated_at: cell(updated_at)?.parse().ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_forms() {
        assert_eq!(normalize_url("libsql://db.turso.io").unwrap(), "https://db.turso.io");
        assert_eq!(normalize_url(" https://db.turso.io/ ").unwrap(), "https://db.turso.io");
        assert!(normalize_url("ftp://x").is_err());
        assert!(normalize_url("http://127.0.0.1:8080").is_ok());
        assert!(normalize_url("http://localhost.evil.com").is_err());
        assert!(normalize_url("http://db.example.com").is_err());
        assert!(normalize_url("").is_err());
    }

    fn request(text: &str) -> Request {
        serde_json::from_str(text).unwrap()
    }

    const ROW: &str = r#"{"id":"a","data":"d","updated_at":7}"#;

    #[test]
    fn requests_map_to_fixed_statements() {
        let (sql, args) = statement(&request(&format!(r#"{{"op":"put","row":{ROW}}}"#)));
        assert_eq!(sql, PUT);
        assert_eq!(
            Value::Array(args),
            json!([
                {"type":"text","value":"a"},
                {"type":"text","value":"d"},
                {"type":"integer","value":"7"},
            ])
        );
        let create = request(&format!(r#"{{"op":"create","row":{ROW}}}"#));
        assert_eq!(statement(&create).0, CREATE);
        let remove = request(r#"{"op":"remove","id":"a"}"#);
        assert_eq!(statement(&remove), (REMOVE, vec![text_arg("a")]));
        assert_eq!(statement(&request(r#"{"op":"list"}"#)), (LIST, Vec::new()));
    }

    #[test]
    fn rejects_unknown_or_malformed_requests() {
        for text in ["", "{}", r#"{"op":"drop"}"#, r#"{"op":"put"}"#, r#"{"op":"remove"}"#] {
            assert!(serde_json::from_str::<Request>(text).is_err(), "{text}");
        }
    }

    #[test]
    fn pipeline_body_shape() {
        let body = pipeline_body("SELECT 1", vec![text_arg("x")]);
        assert_eq!(body["requests"][0]["stmt"]["sql"], "SELECT 1");
        assert_eq!(body["requests"][0]["stmt"]["args"][0]["value"], "x");
        assert_eq!(body["requests"][1]["type"], "close");
    }

    #[test]
    fn list_response_maps_to_rows() {
        let body = json!({"results":[{"type":"ok","response":{"type":"execute","result":{
            "cols":[],
            "rows":[[
                {"type":"text","value":"a"},
                {"type":"text","value":"d"},
                {"type":"integer","value":"123"},
            ]]}}},{"type":"ok","response":{"type":"close"}}]});
        let rows = parse_rows(&parse_result(&body).unwrap()).unwrap();
        assert_eq!(
            serde_json::to_value(rows).unwrap(),
            json!([{"id":"a","data":"d","updated_at":123}])
        );
    }

    #[test]
    fn turso_errors_surface_as_messages() {
        let body = json!({"results":[{"type":"error","error":{"message":"no such table"}}]});
        assert_eq!(parse_result(&body).unwrap_err(), "no such table");
        assert!(parse_result(&json!({})).is_err());
        assert!(parse_rows(&json!({"rows":[[{"type":"text","value":"a"}]]})).is_err());
    }
}
