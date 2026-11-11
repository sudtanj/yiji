use crate::scram;
use base64::{engine::general_purpose::STANDARD, Engine};
use bson::{doc, spec::BinarySubtype, Binary, Bson, Document};
use futures::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use std::fmt::Display;

const OP_MSG: i32 = 2013;
const HEADER_LEN: usize = 16;
// Header, flag bits, section kind and the shortest BSON document (5 bytes).
const MIN_MESSAGE: usize = HEADER_LEN + 4 + 1 + 5;
const MAX_MESSAGE: usize = 64 * 1024 * 1024;
const CHECKSUM_PRESENT: u32 = 1;

type Result<T> = std::result::Result<T, String>;

fn fmt_err(e: impl Display) -> String {
    e.to_string()
}

pub struct Mongo<S> {
    io: S,
    request_id: i32,
}

impl<S: AsyncRead + AsyncWrite + Unpin> Mongo<S> {
    /// Runs the `hello` handshake, then SCRAM-SHA-256 against `auth_db` unless `user` is empty.
    pub async fn connect(io: S, user: &str, password: &str, auth_db: &str) -> Result<Self> {
        let mut conn = Mongo { io, request_id: 0 };
        let hello = doc! {
            "hello": 1,
            "client": {
                "driver": { "name": "yiji", "version": env!("CARGO_PKG_VERSION") },
                "os": { "type": "unknown" },
            },
        };
        conn.run_command("admin", hello).await?;
        if !user.is_empty() {
            conn.authenticate(user, password, auth_db).await?;
        }
        Ok(conn)
    }

    /// `cmd_json` and the returned reply are relaxed Extended JSON.
    pub async fn run_json(&mut self, db: &str, cmd_json: &str) -> Result<String> {
        // Deserializing straight into Document turns {"$oid":..}, {"$date":..} etc. into typed BSON.
        let cmd: Document = serde_json::from_str(cmd_json).map_err(fmt_err)?;
        let reply = self.run_command(db, cmd).await?;
        Ok(Bson::Document(reply).into_relaxed_extjson().to_string())
    }

    /// Fails with the server's `errmsg` when the reply's `ok` is not 1.
    pub async fn run_command(&mut self, db: &str, mut cmd: Document) -> Result<Document> {
        cmd.insert("$db", db);
        self.request_id = self.request_id.wrapping_add(1);
        let request_id = self.request_id;
        let message = encode(request_id, &cmd)?;
        self.io.write_all(&message).await.map_err(fmt_err)?;
        self.io.flush().await.map_err(fmt_err)?;

        let mut len = [0u8; 4];
        self.io.read_exact(&mut len).await.map_err(fmt_err)?;
        let total = i32::from_le_bytes(len);
        let total = usize::try_from(total)
            .ok()
            .filter(|n| (MIN_MESSAGE..=MAX_MESSAGE).contains(n))
            .ok_or_else(|| format!("bad message length {total}"))?;
        let mut buf = vec![0u8; total];
        buf[..4].copy_from_slice(&len);
        self.io.read_exact(&mut buf[4..]).await.map_err(fmt_err)?;

        let (response_to, reply) = decode(&buf)?;
        if response_to != request_id {
            return Err(format!(
                "reply to request {response_to}, expected {request_id}"
            ));
        }
        if !is_ok(&reply) {
            return Err(reply
                .get_str("errmsg")
                .unwrap_or("command failed")
                .to_string());
        }
        Ok(reply)
    }

    async fn authenticate(&mut self, user: &str, password: &str, auth_db: &str) -> Result<()> {
        let mut raw = [0u8; 18];
        getrandom::fill(&mut raw).map_err(fmt_err)?;
        let nonce = STANDARD.encode(raw);
        let bare = scram::client_first_bare(user, &nonce);
        let start = doc! {
            "saslStart": 1,
            "mechanism": "SCRAM-SHA-256",
            "payload": binary(format!("n,,{bare}").into_bytes()),
            "autoAuthorize": 1,
            "options": { "skipEmptyExchange": true },
        };
        let reply = self.run_command(auth_db, start).await?;
        let conversation_id = reply
            .get("conversationId")
            .cloned()
            .ok_or("saslStart reply has no conversationId")?;
        let server_first = payload_str(&reply)?.to_owned();
        let (client_final, server_signature) =
            scram::client_final(password, &bare, &server_first, &nonce)?;

        let mut cont = doc! {
            "saslContinue": 1,
            "conversationId": conversation_id,
            "payload": binary(client_final.into_bytes()),
        };
        let mut reply = self.run_command(auth_db, cont.clone()).await?;
        scram::verify_server(payload_str(&reply)?, &server_signature)?;
        if !is_done(&reply) {
            cont.insert("payload", binary(Vec::new()));
            reply = self.run_command(auth_db, cont).await?;
            if !is_done(&reply) {
                return Err("SCRAM conversation did not finish".to_string());
            }
        }
        Ok(())
    }
}

fn binary(bytes: Vec<u8>) -> Bson {
    Bson::Binary(Binary {
        subtype: BinarySubtype::Generic,
        bytes,
    })
}

fn payload_str(reply: &Document) -> Result<&str> {
    match reply.get("payload") {
        Some(Bson::Binary(b)) => std::str::from_utf8(&b.bytes).map_err(fmt_err),
        _ => Err("reply has no SCRAM payload".to_string()),
    }
}

fn is_done(reply: &Document) -> bool {
    reply.get_bool("done").unwrap_or(false)
}

fn is_ok(reply: &Document) -> bool {
    match reply.get("ok") {
        Some(Bson::Double(v)) => *v == 1.0,
        Some(Bson::Int32(v)) => *v == 1,
        Some(Bson::Int64(v)) => *v == 1,
        _ => false,
    }
}

/// OP_MSG with no flags and a single kind-0 body section.
fn encode(request_id: i32, body: &Document) -> Result<Vec<u8>> {
    let mut buf = vec![0u8; HEADER_LEN];
    buf.extend_from_slice(&0u32.to_le_bytes());
    buf.push(0);
    body.to_writer(&mut buf).map_err(fmt_err)?;
    let len = i32::try_from(buf.len()).map_err(fmt_err)?;
    buf[0..4].copy_from_slice(&len.to_le_bytes());
    buf[4..8].copy_from_slice(&request_id.to_le_bytes());
    // responseTo (bytes 8..12) stays 0 for requests.
    buf[12..16].copy_from_slice(&OP_MSG.to_le_bytes());
    Ok(buf)
}

/// Returns `responseTo` and the kind-0 body of a complete OP_MSG.
fn decode(msg: &[u8]) -> Result<(i32, Document)> {
    if msg.len() < MIN_MESSAGE {
        return Err("message too short".to_string());
    }
    let word = |at: usize| [msg[at], msg[at + 1], msg[at + 2], msg[at + 3]];
    if usize::try_from(i32::from_le_bytes(word(0))).ok() != Some(msg.len()) {
        return Err("message length does not match header".to_string());
    }
    let opcode = i32::from_le_bytes(word(12));
    if opcode != OP_MSG {
        return Err(format!("unexpected opcode {opcode}"));
    }
    if msg[HEADER_LEN + 4] != 0 {
        return Err("unsupported OP_MSG section kind".to_string());
    }
    let flags = u32::from_le_bytes(word(HEADER_LEN));
    let end = if flags & CHECKSUM_PRESENT != 0 {
        msg.len() - 4
    } else {
        msg.len()
    };
    let body = Document::from_reader(&msg[HEADER_LEN + 5..end]).map_err(fmt_err)?;
    Ok((i32::from_le_bytes(word(8)), body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_msg_round_trip() {
        let cmd = doc! { "find": "users", "limit": 200, "$db": "app" };
        let msg = encode(7, &cmd).unwrap();
        assert_eq!(
            i32::from_le_bytes(msg[0..4].try_into().unwrap()) as usize,
            msg.len()
        );
        assert_eq!(i32::from_le_bytes(msg[4..8].try_into().unwrap()), 7);
        assert_eq!(i32::from_le_bytes(msg[12..16].try_into().unwrap()), 2013);
        assert_eq!(msg[20], 0);
        let (response_to, decoded) = decode(&msg).unwrap();
        assert_eq!(response_to, 0);
        assert_eq!(decoded, cmd);
    }

    #[test]
    fn decode_rejects_bad_length_and_opcode() {
        let mut msg = encode(1, &doc! { "ping": 1 }).unwrap();
        msg[12] = 0xd5;
        assert!(decode(&msg).is_err());
        msg[12] = 0xdd;
        msg.push(0);
        assert!(decode(&msg).is_err());
    }

    #[test]
    fn extended_json_input_becomes_typed_bson() {
        let cmd: Document = serde_json::from_str(
            r#"{"find":"c","filter":{"_id":{"$oid":"507f1f77bcf86cd799439011"},"t":{"$date":"2024-01-02T03:04:05Z"}}}"#,
        )
        .unwrap();
        assert_eq!(cmd.keys().next().unwrap(), "find");
        let filter = cmd.get_document("filter").unwrap();
        assert!(matches!(filter.get("_id"), Some(Bson::ObjectId(_))));
        assert!(matches!(filter.get("t"), Some(Bson::DateTime(_))));
    }

    #[test]
    fn ok_accepts_numeric_types() {
        assert!(is_ok(&doc! { "ok": 1.0 }));
        assert!(is_ok(&doc! { "ok": 1 }));
        assert!(!is_ok(&doc! { "ok": 0.0 }));
        assert!(!is_ok(&doc! {}));
    }
}
