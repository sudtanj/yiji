use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use subtle::ConstantTimeEq;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio::time::{sleep, timeout, Instant};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_hdr_async_with_config, WebSocketStream};

const MIN_TOKEN_LEN: usize = 32;
const STEP_TIMEOUT: Duration = Duration::from_secs(10);
const READ_BUF: usize = 16 * 1024;
const DEFAULT_MAX_CONN: usize = 64;
const DEFAULT_IDLE: Duration = Duration::from_secs(30 * 60);
// ponytail: 16 MiB per message/frame. Mongo allows 48 MB messages but drivers chunk below that.
const MAX_MESSAGE: usize = 16 * 1024 * 1024;

const BAD_TOKEN: &str = "bad token";
const NOT_ALLOWED: &str = "target not allowed";
const CONNECT_FAILED: &str = "connect failed";
const BAD_HELLO: &str = "bad hello";
const BINARY_ONLY: &str = "binary only";

pub struct Config {
    token: String,
    allow: HashSet<String>,
    origins: HashSet<String>,
    /// Connections served at once; further clients wait in the accept backlog.
    pub max_conn: usize,
    /// Close a relayed connection after this long without data in either direction.
    pub idle: Duration,
}

impl Config {
    /// `allow` and `origins` are comma-separated. Empty `origins` accepts any Origin.
    pub fn new(token: &str, allow: &str, origins: &str) -> Result<Self, &'static str> {
        if token.chars().count() < MIN_TOKEN_LEN {
            return Err("YIJI_TOKEN must be at least 32 characters");
        }
        let allow = split_list(allow);
        if allow.is_empty() {
            return Err("YIJI_ALLOW must list at least one host:port");
        }
        Ok(Self {
            token: token.to_owned(),
            allow,
            origins: split_list(origins),
            max_conn: DEFAULT_MAX_CONN,
            idle: DEFAULT_IDLE,
        })
    }

    fn token_matches(&self, token: &str) -> bool {
        self.token.as_bytes().ct_eq(token.as_bytes()).into()
    }

    fn allows(&self, host: &str, port: u16) -> bool {
        self.allow.contains(&format!("{host}:{port}"))
    }
}

fn split_list(list: &str) -> HashSet<String> {
    list.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

#[derive(Deserialize)]
struct Hello {
    token: String,
    host: String,
    port: u16,
}

fn parse_hello(text: &str) -> Result<Hello, &'static str> {
    serde_json::from_str(text).map_err(|_| BAD_HELLO)
}

pub async fn serve(listener: TcpListener, config: Config) {
    let slots = Arc::new(Semaphore::new(config.max_conn));
    let config = Arc::new(config);
    loop {
        // Take the slot before accepting so excess clients queue in the kernel backlog.
        let Ok(permit) = slots.clone().acquire_owned().await else {
            return;
        };
        let (stream, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                // EMFILE and friends: back off instead of spinning.
                eprintln!("accept failed: {e}");
                sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let config = config.clone();
        tokio::spawn(async move {
            match connection(stream, peer, &config).await {
                Ok(()) => eprintln!("{peer} closed"),
                Err(reason) => eprintln!("{peer} refused: {reason}"),
            }
            drop(permit);
        });
    }
}

async fn connection(
    stream: TcpStream,
    peer: SocketAddr,
    config: &Config,
) -> Result<(), &'static str> {
    // Latency matters more than packing for database round trips; failure is harmless.
    let _ = stream.set_nodelay(true);
    // tungstenite fixes the callback error type.
    #[allow(clippy::result_large_err)]
    let check_origin = |request: &Request, response: Response| {
        let allowed = config.origins.is_empty()
            || request
                .headers()
                .get("origin")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|origin| config.origins.contains(origin));
        if allowed {
            Ok(response)
        } else {
            let mut refusal = ErrorResponse::new(Some("origin not allowed".into()));
            *refusal.status_mut() = StatusCode::FORBIDDEN;
            Err(refusal)
        }
    };
    let limits = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let handshake = accept_hdr_async_with_config(stream, check_origin, Some(limits));
    let mut ws = timeout(STEP_TIMEOUT, handshake)
        .await
        .map_err(|_| "handshake timed out")?
        .map_err(|_| "handshake failed")?;

    let hello = match timeout(STEP_TIMEOUT, ws.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => parse_hello(&text),
        _ => Err(BAD_HELLO),
    };
    let hello = match hello {
        Ok(hello) if !config.token_matches(&hello.token) => Err(BAD_TOKEN),
        Ok(hello) if !config.allows(&hello.host, hello.port) => Err(NOT_ALLOWED),
        other => other,
    };
    let hello = match hello {
        Ok(hello) => hello,
        Err(reason) => return Err(reject(&mut ws, reason).await),
    };

    let target = (hello.host.as_str(), hello.port);
    let mut tcp = match timeout(STEP_TIMEOUT, TcpStream::connect(target)).await {
        Ok(Ok(tcp)) => tcp,
        _ => return Err(reject(&mut ws, CONNECT_FAILED).await),
    };
    let _ = tcp.set_nodelay(true);
    if ws.send(Message::text("ok")).await.is_err() {
        return Ok(());
    }
    eprintln!("{peer} open -> {}:{}", hello.host, hello.port);

    let mut buf = [0u8; READ_BUF];
    let mut refusal = None;
    let idle = sleep(config.idle);
    tokio::pin!(idle);
    loop {
        tokio::select! {
            frame = ws.next() => match frame {
                Some(Ok(Message::Binary(bytes))) => {
                    if tcp.write_all(&bytes).await.is_err() {
                        break;
                    }
                    idle.as_mut().reset(Instant::now() + config.idle);
                }
                // tungstenite queues the pong reply itself.
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                Some(Ok(Message::Text(_))) => {
                    refusal = Some(BINARY_ONLY);
                    break;
                }
                _ => break,
            },
            read = tcp.read(&mut buf) => match read {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ws.send(Message::binary(buf[..n].to_vec())).await.is_err() {
                        break;
                    }
                    idle.as_mut().reset(Instant::now() + config.idle);
                }
            },
            () = &mut idle => break,
        }
    }
    match refusal {
        Some(reason) => {
            reject(&mut ws, reason).await;
        }
        // The peer may already be gone; nothing to do if the close frame fails.
        None => {
            let _ = timeout(STEP_TIMEOUT, ws.close(None)).await;
        }
    }
    Ok(())
}

async fn reject(ws: &mut WebSocketStream<TcpStream>, reason: &'static str) -> &'static str {
    let frame = CloseFrame {
        code: CloseCode::Policy,
        reason: reason.into(),
    };
    let _ = timeout(STEP_TIMEOUT, ws.close(Some(frame))).await;
    reason
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn hello_parses() {
        let hello = parse_hello(r#"{"token":"t","host":"db.lan","port":5432}"#).unwrap();
        assert_eq!(
            (hello.token.as_str(), hello.host.as_str(), hello.port),
            ("t", "db.lan", 5432)
        );
    }

    #[test]
    fn hello_rejects_malformed() {
        let bad = [
            "",
            "ok",
            r#"{"token":"t","host":"h"}"#,
            r#"{"token":"t","host":"h","port":70000}"#,
        ];
        for text in bad {
            assert_eq!(parse_hello(text).err(), Some(BAD_HELLO), "{text}");
        }
    }

    #[test]
    fn config_refuses_weak_setup() {
        assert!(Config::new("short", "db.lan:5432", "").is_err());
        assert!(Config::new(TOKEN, "", "").is_err());
        assert!(Config::new(TOKEN, " , ", "").is_err());
    }

    #[test]
    fn allowlist_is_exact() {
        let config = Config::new(TOKEN, "db.lan:5432, 10.0.0.5:27017", "").unwrap();
        assert!(config.allows("db.lan", 5432));
        assert!(config.allows("10.0.0.5", 27017));
        assert!(!config.allows("db.lan", 5433));
        assert!(!config.allows("DB.lan", 5432));
        assert!(!config.allows("db.lan:5432", 5432));
    }

    #[test]
    fn token_compare() {
        let config = Config::new(TOKEN, "a:1", "").unwrap();
        assert!(config.token_matches(TOKEN));
        assert!(!config.token_matches(&TOKEN[1..]));
        assert!(!config.token_matches(""));
    }
}
