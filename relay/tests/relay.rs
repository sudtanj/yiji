use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;
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
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let config = Config::new(TOKEN, allow, "*").unwrap();
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
