use futures::{
    io::{AsyncRead, AsyncWrite},
    SinkExt, StreamExt,
};
use pharos::{Observable, ObserveConfig};
use std::pin::Pin;
use ws_stream_wasm::{WsEvent, WsMessage, WsMeta};

pub trait Io: AsyncRead + AsyncWrite {}
impl<T: AsyncRead + AsyncWrite> Io for T {}

/// Opens the relay WebSocket, performs the hello exchange and returns the raw byte stream.
pub async fn open(
    relay_url: &str,
    token: &str,
    host: &str,
    port: u16,
) -> Result<Pin<Box<dyn Io>>, String> {
    let (mut meta, mut ws) = WsMeta::connect(relay_url, None)
        .await
        .map_err(|e| e.to_string())?;
    let mut events = meta
        .observe(ObserveConfig::default())
        .await
        .map_err(|e| e.to_string())?;

    let hello = serde_json::json!({ "token": token, "host": host, "port": port });
    ws.send(WsMessage::Text(hello.to_string()))
        .await
        .map_err(|e| e.to_string())?;

    match ws.next().await {
        Some(WsMessage::Text(reply)) if reply == "ok" => Ok(Box::pin(ws.into_io())),
        Some(_) => Err("unexpected reply from relay".to_string()),
        None => {
            while let Some(event) = events.next().await {
                if let WsEvent::Closed(close) = event {
                    return Err(if close.reason.is_empty() {
                        format!("relay closed the connection ({})", close.code)
                    } else {
                        close.reason
                    });
                }
            }
            Err("relay closed the connection".to_string())
        }
    }
}
