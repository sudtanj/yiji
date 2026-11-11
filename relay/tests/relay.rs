use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error, Message};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use yiji_relay::{serve, Config};

const TOKEN: &str = "0123456789abcdef0123456789abcdef";

type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn start_echo() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                while let Ok(n) = socket.read(&mut buf).await {
                    if n == 0 || socket.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    port
}

async fn start_relay(allow: &str) -> String {
    start_relay_with(Config::new(TOKEN, allow, "*").unwrap()).await
}

async fn start_relay_with(config: Config) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    tokio::spawn(serve(listener, config));
    url
}

async fn hello(url: &str, token: &str, port: u16) -> Client {
    let (mut ws, _) = connect_async(url).await.unwrap();
    let frame = format!(r#"{{"token":"{token}","host":"127.0.0.1","port":{port}}}"#);
    ws.send(Message::text(frame)).await.unwrap();
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

#[tokio::test]
async fn relays_bytes_and_refuses_bad_requests() {
    let echo = start_echo().await;
    let url = start_relay(&format!("127.0.0.1:{echo}")).await;

    let mut ws = hello(&url, TOKEN, echo).await;
    assert_eq!(ws.next().await.unwrap().unwrap(), Message::text("ok"));
    ws.send(Message::binary(vec![1, 2, 3])).await.unwrap();
    assert_eq!(
        ws.next().await.unwrap().unwrap(),
        Message::binary(vec![1, 2, 3])
    );
    ws.send(Message::binary(vec![9; 100])).await.unwrap();
    assert_eq!(
        ws.next().await.unwrap().unwrap(),
        Message::binary(vec![9; 100])
    );

    expect_refusal(
        hello(&url, "x".repeat(32).as_str(), echo).await,
        "bad token",
    )
    .await;
    expect_refusal(hello(&url, TOKEN, echo + 1).await, "target not allowed").await;

    let (mut ws, _) = connect_async(url.as_str()).await.unwrap();
    ws.send(Message::text("not json")).await.unwrap();
    expect_refusal(ws, "bad hello").await;
}

async fn open(url: &str, port: u16) -> Client {
    let mut ws = hello(url, TOKEN, port).await;
    assert_eq!(ws.next().await.unwrap().unwrap(), Message::text("ok"));
    ws
}

#[tokio::test]
async fn refuses_unreachable_target() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let closed = listener.local_addr().unwrap().port();
    drop(listener);
    let url = start_relay(&format!("127.0.0.1:{closed}")).await;
    expect_refusal(hello(&url, TOKEN, closed).await, "connect failed").await;
}

#[tokio::test]
async fn text_after_ok_is_refused() {
    let echo = start_echo().await;
    let url = start_relay(&format!("127.0.0.1:{echo}")).await;
    let mut ws = open(&url, echo).await;
    ws.send(Message::text("hi")).await.unwrap();
    expect_refusal(ws, "binary only").await;
}

#[tokio::test]
async fn tcp_close_ends_websocket() {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = server.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (socket, _) = server.accept().await.unwrap();
        drop(socket);
    });
    let url = start_relay(&format!("127.0.0.1:{port}")).await;
    let mut ws = open(&url, port).await;
    let next = timeout(Duration::from_secs(5), ws.next()).await.unwrap();
    assert!(matches!(next, Some(Ok(Message::Close(_))) | None));
}

#[tokio::test]
async fn websocket_close_ends_tcp() {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = server.local_addr().unwrap().port();
    let (eof_tx, eof_rx) = oneshot::channel();
    tokio::spawn(async move {
        let (mut socket, _) = server.accept().await.unwrap();
        let mut buf = [0u8; 16];
        let n = socket.read(&mut buf).await.unwrap();
        eof_tx.send(n).unwrap();
    });
    let url = start_relay(&format!("127.0.0.1:{port}")).await;
    let mut ws = open(&url, port).await;
    ws.close(None).await.unwrap();
    let n = timeout(Duration::from_secs(5), eof_rx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn origin_must_be_allowed() {
    let echo = start_echo().await;
    let config = Config::new(TOKEN, &format!("127.0.0.1:{echo}"), "https://ok.example").unwrap();
    let url = start_relay_with(config).await;

    let with_origin = |origin: &'static str| {
        let mut request = url.as_str().into_client_request().unwrap();
        request
            .headers_mut()
            .insert("origin", HeaderValue::from_static(origin));
        request
    };
    for refused in [
        connect_async(with_origin("https://evil.example")).await,
        connect_async(url.as_str()).await,
    ] {
        match refused {
            Err(Error::Http(response)) => assert_eq!(response.status(), StatusCode::FORBIDDEN),
            other => panic!("expected 403, got {:?}", other.map(|_| ())),
        }
    }

    let (mut ws, _) = connect_async(with_origin("https://ok.example"))
        .await
        .unwrap();
    let frame = format!(r#"{{"token":"{TOKEN}","host":"127.0.0.1","port":{echo}}}"#);
    ws.send(Message::text(frame)).await.unwrap();
    assert_eq!(ws.next().await.unwrap().unwrap(), Message::text("ok"));
}

#[tokio::test]
async fn binary_hello_is_refused() {
    let url = start_relay("127.0.0.1:1").await;
    let (mut ws, _) = connect_async(url.as_str()).await.unwrap();
    ws.send(Message::binary(vec![1])).await.unwrap();
    expect_refusal(ws, "bad hello").await;
}

#[tokio::test]
async fn oversized_hello_is_not_accepted() {
    let echo = start_echo().await;
    let url = start_relay(&format!("127.0.0.1:{echo}")).await;
    let mut ws = hello(&url, &"a".repeat(5000), echo).await;
    match timeout(Duration::from_secs(5), ws.next()).await.unwrap() {
        Some(Ok(Message::Text(text))) => panic!("relay answered {text}"),
        Some(Ok(Message::Close(Some(frame)))) => assert_ne!(frame.reason.as_str(), "bad token"),
        _ => {}
    }
}

#[tokio::test]
async fn message_over_16_mib_closes_connection() {
    let echo = start_echo().await;
    let url = start_relay(&format!("127.0.0.1:{echo}")).await;
    let mut ws = open(&url, echo).await;
    let _ = ws
        .send(Message::binary(vec![0; 16 * 1024 * 1024 + 1]))
        .await;
    let next = timeout(Duration::from_secs(10), ws.next()).await.unwrap();
    assert!(!matches!(next, Some(Ok(Message::Binary(_)))));
}

#[tokio::test]
async fn idle_connection_is_closed() {
    let echo = start_echo().await;
    let mut config = Config::new(TOKEN, &format!("127.0.0.1:{echo}"), "*").unwrap();
    config.idle = Duration::from_millis(300);
    let url = start_relay_with(config).await;
    let mut ws = open(&url, echo).await;
    let next = timeout(Duration::from_secs(5), ws.next()).await.unwrap();
    assert!(matches!(next, Some(Ok(Message::Close(_))) | None));
}

#[tokio::test]
async fn pending_cap_holds_back_new_connections() {
    let echo = start_echo().await;
    let mut config = Config::new(TOKEN, &format!("127.0.0.1:{echo}"), "*").unwrap();
    config.max_pending = 1;
    let url = start_relay_with(config).await;

    let (first, _) = connect_async(url.as_str()).await.unwrap();
    let blocked = timeout(Duration::from_millis(500), connect_async(url.as_str())).await;
    assert!(
        blocked.is_err(),
        "a second client was served while one is pending"
    );

    drop(first);
    timeout(Duration::from_secs(5), open(&url, echo))
        .await
        .unwrap();
}
