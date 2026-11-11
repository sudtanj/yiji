mod vault;

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use subtle::ConstantTimeEq;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::{sleep, timeout, timeout_at, Instant};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_hdr_async_with_config, WebSocketStream};
use vault::Vault;

const MIN_TOKEN_LEN: usize = 32;
const STEP_TIMEOUT: Duration = Duration::from_secs(5);
const READ_BUF: usize = 16 * 1024;
const DEFAULT_MAX_CONN: usize = 64;
const DEFAULT_MAX_PENDING: usize = 16;
const HELLO_LIMIT: usize = 4 * 1024;
const VAULT_MAX_REQUEST: usize = 1024 * 1024;
const DEFAULT_IDLE: Duration = Duration::from_secs(30 * 60);
// ponytail: 16 MiB per message/frame. Mongo allows 48 MB messages but drivers chunk below that.
const MAX_MESSAGE: usize = 16 * 1024 * 1024;

const BAD_TOKEN: &str = "bad token";
const NOT_ALLOWED: &str = "target not allowed";
const CONNECT_FAILED: &str = "connect failed";
const BAD_HELLO: &str = "bad hello";
const BINARY_ONLY: &str = "binary only";
const NO_VAULT: &str = "vault not configured";

pub struct Config {
    token: String,
    allow: HashSet<String>,
    origins: HashSet<String>,
    vault: Option<Vault>,
    /// Connections served at once; further clients wait in the accept backlog.
    pub max_conn: usize,
    /// Connections that have not yet passed the token and allowlist checks.
    pub max_pending: usize,
    /// Close a relayed connection after this long without data in either direction.
    pub idle: Duration,
}

impl Config {
    /// `allow` and `origins` are comma-separated. `origins` must be set; `*` accepts any Origin.
    pub fn new(token: &str, allow: &str, origins: &str) -> Result<Self, &'static str> {
        Self::with_vault(token, allow, origins, "", "")
    }

    /// Like `new`, plus the Turso vault when `turso_url` is not empty. Then `allow` may be empty.
    pub fn with_vault(
        token: &str,
        allow: &str,
        origins: &str,
        turso_url: &str,
        turso_token: &str,
    ) -> Result<Self, &'static str> {
        if token.chars().count() < MIN_TOKEN_LEN {
            return Err("YIJI_TOKEN must be at least 32 characters");
        }
        let allow = split_list(allow);
        let turso_url = turso_url.trim();
        if allow.is_empty() && turso_url.is_empty() {
            return Err("YIJI_ALLOW must list at least one host:port, or set YIJI_TURSO_URL");
        }
        let vault = if turso_url.is_empty() {
            None
        } else {
            Some(Vault::new(turso_url, turso_token)?)
        };
        let origins = split_list(origins);
        if origins.is_empty() {
            return Err("YIJI_ORIGINS must be set; use * to allow any origin");
        }
        Ok(Self {
            token: token.to_owned(),
            allow,
            origins,
            vault,
            max_conn: DEFAULT_MAX_CONN,
            max_pending: DEFAULT_MAX_PENDING,
            idle: DEFAULT_IDLE,
        })
    }

    // ponytail: ct_eq returns early on a length mismatch, so the token length leaks.
    // Compare fixed-length hashes of both sides if that ever matters.
    fn token_matches(&self, token: &str) -> bool {
        self.token.as_bytes().ct_eq(token.as_bytes()).into()
    }

    fn allows(&self, host: &str, port: u16) -> bool {
        self.allow.contains(&format!("{host}:{port}"))
    }

    fn admits(&self, target: &Target) -> Result<(), &'static str> {
        match target {
            Target::Tcp { host, port } if !self.allows(host, *port) => Err(NOT_ALLOWED),
            Target::Vault if self.vault.is_none() => Err(NO_VAULT),
            _ => Ok(()),
        }
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
struct RawHello {
    token: String,
    #[serde(default)]
    vault: bool,
    host: Option<String>,
    port: Option<u16>,
}

enum Target {
    Tcp { host: String, port: u16 },
    Vault,
}

struct Hello {
    token: String,
    target: Target,
}

fn parse_hello(text: &str) -> Result<Hello, &'static str> {
    let raw: RawHello = serde_json::from_str(text).map_err(|_| BAD_HELLO)?;
    let target = match (raw.vault, raw.host, raw.port) {
        (true, _, _) => Target::Vault,
        (false, Some(host), Some(port)) => Target::Tcp { host, port },
        _ => return Err(BAD_HELLO),
    };
    Ok(Hello {
        token: raw.token,
        target,
    })
}

pub async fn serve(listener: TcpListener, config: Config) {
    let slots = Arc::new(Semaphore::new(config.max_conn));
    let pending_slots = Arc::new(Semaphore::new(config.max_pending));
    let config = Arc::new(config);
    loop {
        // Take both slots before accepting so excess clients queue in the kernel backlog.
        let Ok(permit) = slots.clone().acquire_owned().await else {
            return;
        };
        let Ok(pending) = pending_slots.clone().acquire_owned().await else {
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
            match connection(stream, peer, pending, &config).await {
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
    pending: OwnedSemaphorePermit,
    config: &Config,
) -> Result<(), &'static str> {
    // Latency matters more than packing for database round trips; failure is harmless.
    let _ = stream.set_nodelay(true);
    // tungstenite fixes the callback error type.
    #[allow(clippy::result_large_err)]
    let check_origin = |request: &Request, response: Response| {
        let allowed = config.origins.contains("*")
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
    let hello_limits = WebSocketConfig::default()
        .max_message_size(Some(HELLO_LIMIT))
        .max_frame_size(Some(HELLO_LIMIT));
    let handshake = accept_hdr_async_with_config(stream, check_origin, Some(hello_limits));
    let mut ws = timeout(STEP_TIMEOUT, handshake)
        .await
        .map_err(|_| "handshake timed out")?
        .map_err(|_| "handshake failed")?;

    let hello = match timeout(STEP_TIMEOUT, ws.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => parse_hello(&text),
        _ => Err(BAD_HELLO),
    };
    let hello = hello.and_then(|hello| {
        if !config.token_matches(&hello.token) {
            return Err(BAD_TOKEN);
        }
        config.admits(&hello.target)?;
        Ok(hello)
    });
    let hello = match hello {
        Ok(hello) => hello,
        Err(reason) => return Err(reject(&mut ws, reason).await),
    };
    drop(pending);
    let max_message = match hello.target {
        Target::Vault => VAULT_MAX_REQUEST,
        Target::Tcp { .. } => MAX_MESSAGE,
    };
    // WebSocketStream has no set_config, so rebuild it with the large limits. Bytes tungstenite
    // read ahead are lost, so clients must wait for `ok` before sending data.
    let relay_limits = WebSocketConfig::default()
        .max_message_size(Some(max_message))
        .max_frame_size(Some(max_message));
    let mut ws =
        WebSocketStream::from_raw_socket(ws.into_inner(), Role::Server, Some(relay_limits)).await;

    let (host, port) = match hello.target {
        Target::Tcp { host, port } => (host, port),
        Target::Vault => {
            let Some(vault) = &config.vault else {
                return Err(reject(&mut ws, NO_VAULT).await);
            };
            return serve_vault(ws, vault, peer, config.idle).await;
        }
    };
    let target = (host.as_str(), port);
    let mut tcp = match timeout(STEP_TIMEOUT, TcpStream::connect(target)).await {
        Ok(Ok(tcp)) => tcp,
        _ => return Err(reject(&mut ws, CONNECT_FAILED).await),
    };
    let _ = tcp.set_nodelay(true);
    if ws.send(Message::text("ok")).await.is_err() {
        return Ok(());
    }
    eprintln!("{peer} open -> {host}:{port}");

    let mut buf = [0u8; READ_BUF];
    let mut refusal = None;
    let idle = sleep(config.idle);
    tokio::pin!(idle);
    loop {
        tokio::select! {
            frame = ws.next() => match frame {
                Some(Ok(Message::Binary(bytes))) => {
                    if !matches!(timeout(config.idle, tcp.write_all(&bytes)).await, Ok(Ok(()))) {
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
                    let frame = Message::binary(buf[..n].to_vec());
                    if !matches!(timeout(config.idle, ws.send(frame)).await, Ok(Ok(()))) {
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

/// One text request in, one text reply out, until the client leaves or sits idle.
async fn serve_vault(
    mut ws: WebSocketStream<TcpStream>,
    vault: &Vault,
    peer: SocketAddr,
    idle: Duration,
) -> Result<(), &'static str> {
    if ws.send(Message::text("ok")).await.is_err() {
        return Ok(());
    }
    eprintln!("{peer} open -> vault");
    let mut deadline = Instant::now() + idle;
    loop {
        match timeout_at(deadline, ws.next()).await {
            Ok(Some(Ok(Message::Text(request)))) => {
                deadline = Instant::now() + idle;
                let reply = vault.handle(&request).await;
                if ws.send(Message::text(reply)).await.is_err() {
                    return Ok(());
                }
            }
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => {}
            _ => break,
        }
    }
    let _ = timeout(STEP_TIMEOUT, ws.close(None)).await;
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
        assert_eq!(hello.token, "t");
        assert!(matches!(
            hello.target,
            Target::Tcp { ref host, port: 5432 } if host == "db.lan"
        ));
    }

    #[test]
    fn vault_hello_parses() {
        let hello = parse_hello(r#"{"token":"t","vault":true}"#).unwrap();
        assert!(matches!(hello.target, Target::Vault));
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
        assert!(Config::new("short", "db.lan:5432", "*").is_err());
        assert!(Config::new(TOKEN, "", "*").is_err());
        assert!(Config::new(TOKEN, " , ", "*").is_err());
        assert!(Config::new(TOKEN, "a:1", "").is_err());
    }

    #[test]
    fn allowlist_is_exact() {
        let config = Config::new(TOKEN, "db.lan:5432, 10.0.0.5:27017", "*").unwrap();
        assert!(config.allows("db.lan", 5432));
        assert!(config.allows("10.0.0.5", 27017));
        assert!(!config.allows("db.lan", 5433));
        assert!(!config.allows("DB.lan", 5432));
        assert!(!config.allows("db.lan:5432", 5432));
    }

    #[test]
    fn hello_without_target_is_malformed() {
        for text in [r#"{"token":"t"}"#, r#"{"token":"t","vault":false}"#] {
            assert_eq!(parse_hello(text).err(), Some(BAD_HELLO), "{text}");
        }
    }

    #[test]
    fn vault_only_config() {
        let url = "libsql://db.turso.io";
        assert!(Config::with_vault(TOKEN, "", "*", url, "").is_ok());
        assert!(Config::with_vault(TOKEN, "", "*", "", "").is_err());
        assert!(Config::with_vault(TOKEN, "a:1", "*", "", "").is_ok());
        assert!(Config::with_vault(TOKEN, "", "*", "ftp://x", "").is_err());
    }

    #[test]
    fn vault_hello_needs_vault() {
        let plain = Config::new(TOKEN, "a:1", "*").unwrap();
        assert_eq!(plain.admits(&Target::Vault), Err(NO_VAULT));
        let vault = Config::with_vault(TOKEN, "", "*", "https://db.turso.io", "").unwrap();
        assert_eq!(vault.admits(&Target::Vault), Ok(()));
        let tcp = Target::Tcp {
            host: "a".into(),
            port: 1,
        };
        assert_eq!(vault.admits(&tcp), Err(NOT_ALLOWED));
    }

    #[test]
    fn token_compare() {
        let config = Config::new(TOKEN, "a:1", "*").unwrap();
        assert!(config.token_matches(TOKEN));
        assert!(!config.token_matches(&TOKEN[1..]));
        assert!(!config.token_matches(""));
    }
}
