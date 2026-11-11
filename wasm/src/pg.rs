use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_postgres::{tls::NoTlsStream, Client, Config, Connection, NoTls, SimpleQueryMessage};

/// One simple-query protocol message, reduced to what the JSON mapping needs.
enum Msg {
    Columns(Vec<String>),
    Row(Vec<Option<String>>),
    Done(u64),
}

/// The caller must drive the returned `Connection` (spawn it) for the client to work.
pub async fn connect<S: AsyncRead + AsyncWrite + Unpin>(
    stream: S,
    user: &str,
    password: &str,
    database: &str,
) -> Result<(Client, Connection<S, NoTlsStream>), String> {
    let mut config = Config::new();
    config.user(user).password(password).dbname(database);
    config
        .connect_raw(stream, NoTls)
        .await
        .map_err(|e| e.to_string())
}

pub async fn query(client: &Client, sql: &str) -> Result<String, String> {
    let messages = client.simple_query(sql).await.map_err(|e| e.to_string())?;
    let mut msgs = Vec::new();
    for message in &messages {
        match message {
            SimpleQueryMessage::RowDescription(columns) => {
                msgs.push(Msg::Columns(
                    columns.iter().map(|c| c.name().to_owned()).collect(),
                ));
            }
            SimpleQueryMessage::Row(row) => {
                let mut values = Vec::with_capacity(row.len());
                for i in 0..row.len() {
                    let value = row.try_get(i).map_err(|e| e.to_string())?;
                    values.push(value.map(str::to_owned));
                }
                msgs.push(Msg::Row(values));
            }
            SimpleQueryMessage::CommandComplete(n) => msgs.push(Msg::Done(*n)),
            _ => {}
        }
    }
    Ok(to_json(msgs).to_string())
}

/// Result of the last statement that returned rows, else the row count of the last statement.
fn to_json(msgs: Vec<Msg>) -> Value {
    let mut current: Option<(Vec<String>, Vec<Vec<Option<String>>>)> = None;
    let mut last_rows = None;
    let mut affected = None;
    for msg in msgs {
        match msg {
            Msg::Columns(columns) => current = Some((columns, Vec::new())),
            Msg::Row(values) => {
                if let Some((_, rows)) = current.as_mut() {
                    rows.push(values);
                }
            }
            Msg::Done(n) => {
                affected = Some(n);
                if current.is_some() {
                    last_rows = current.take();
                }
            }
        }
    }
    match last_rows {
        // Simple query has no type OIDs, so every column is reported as text.
        Some((columns, rows)) => json!({
            "columns": columns.iter().map(|name| json!({ "name": name, "type": "text" })).collect::<Vec<_>>(),
            "rows": rows,
            "rowsAffected": null,
        }),
        None => json!({ "columns": [], "rows": [], "rowsAffected": affected }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn columns(names: &[&str]) -> Msg {
        Msg::Columns(names.iter().map(|n| n.to_string()).collect())
    }

    #[test]
    fn maps_rows_and_nulls_as_strings() {
        let json = to_json(vec![
            columns(&["id", "name"]),
            Msg::Row(vec![Some("1".into()), None]),
            Msg::Done(1),
        ]);
        assert_eq!(
            json,
            json!({
                "columns": [{"name": "id", "type": "text"}, {"name": "name", "type": "text"}],
                "rows": [["1", null]],
                "rowsAffected": null,
            })
        );
    }

    #[test]
    fn multi_statement_prefers_last_result_set() {
        let json = to_json(vec![
            Msg::Done(3),
            columns(&["i"]),
            Msg::Row(vec![Some("7".into())]),
            Msg::Done(1),
            Msg::Done(5),
        ]);
        assert_eq!(json["rows"], json!([["7"]]));
        assert_eq!(json["rowsAffected"], Value::Null);
    }

    #[test]
    fn without_rows_reports_last_row_count() {
        let json = to_json(vec![Msg::Done(2), Msg::Done(4)]);
        assert_eq!(
            json,
            json!({ "columns": [], "rows": [], "rowsAffected": 4 })
        );
    }

    #[test]
    fn empty_result_set_keeps_columns() {
        let json = to_json(vec![columns(&["id"]), Msg::Done(0)]);
        assert_eq!(json["columns"], json!([{"name": "id", "type": "text"}]));
        assert_eq!(json["rows"], json!([]));
    }
}
