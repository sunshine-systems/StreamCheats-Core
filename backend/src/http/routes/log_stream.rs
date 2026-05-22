//! `GET /logs/stream` — WebSocket endpoint that fans live tracing
//! events out to renderer clients.
//!
//! Protocol:
//!
//! 1. On connect, the server immediately sends every event currently
//!    in the ring buffer as a sequence of JSON text frames (oldest
//!    first) so the renderer can backfill recent history.
//! 2. After the snapshot drain, the server subscribes to the broadcast
//!    channel and forwards each new `LogEvent` as a JSON text frame.
//! 3. If the broadcast receiver lags (server outpaced this client's
//!    drain), the server sends a `{"type":"lagged","count":N}` text
//!    frame so the UI can render a "dropped N" indicator and the
//!    receiver resumes from the now-current position.
//! 4. A client message (any opcode) ends the session — the simplest
//!    "client wants to disconnect" signal compatible with browser WS
//!    APIs.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;
use tracing::{debug, warn};

use crate::http::state::AppState;
use crate::services::log_stream::{LogEvent, LogStreamHandles};

pub async fn handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    // Snapshot the ring on the request task BEFORE handing off to the
    // upgrade future, so the new client never misses an event that
    // arrives between the upgrade and the first push.
    let handles = match state.log_stream.clone() {
        Some(h) => h,
        None => {
            // Log streaming disabled — politely reject the upgrade
            // with a 503 instead of accepting and immediately closing.
            return Response::builder()
                .status(503)
                .body(axum::body::Body::from("log streaming not enabled"))
                .expect("static response builder");
        }
    };

    ws.on_upgrade(move |socket| handle_socket(socket, handles))
}

async fn handle_socket(socket: WebSocket, handles: LogStreamHandles) {
    let (mut sender, mut receiver) = socket.split();

    // Subscribe BEFORE snapshotting so any events that race between
    // those two steps still land in the broadcast — they may be
    // duplicated in the snapshot, which is fine (the UI can dedupe
    // by (ts, line) if it cares; otherwise the cost is one extra row).
    let mut rx = handles.broadcaster.subscribe();

    let snapshot = handles.ring.snapshot();
    for event in snapshot {
        if let Err(e) = send_event(&mut sender, &event).await {
            debug!("log stream: client disconnected during snapshot: {}", e);
            return;
        }
    }

    loop {
        tokio::select! {
            // Client message — any frame ends the session.
            client_msg = receiver.next() => {
                match client_msg {
                    Some(Ok(Message::Close(_))) | None => {
                        debug!("log stream: client closed connection");
                        return;
                    }
                    Some(Err(e)) => {
                        debug!("log stream: client read error: {}", e);
                        return;
                    }
                    // Any other frame (ping/pong/text) — keep going. We
                    // don't currently honor client commands but they
                    // don't end the session.
                    Some(Ok(_)) => {}
                }
            }
            // Live broadcast.
            recv = rx.recv() => {
                match recv {
                    Ok(event) => {
                        if let Err(e) = send_event(&mut sender, &event).await {
                            debug!("log stream: client disconnected: {}", e);
                            return;
                        }
                    }
                    Err(RecvError::Lagged(n)) => {
                        let frame = json!({
                            "type": "lagged",
                            "count": n,
                        });
                        let text = serde_json::to_string(&frame)
                            .unwrap_or_else(|_| String::from("{\"type\":\"lagged\"}"));
                        if let Err(e) = sender.send(Message::Text(text)).await {
                            debug!("log stream: client disconnected on lag notice: {}", e);
                            return;
                        }
                    }
                    Err(RecvError::Closed) => {
                        warn!("log stream: broadcast channel closed unexpectedly");
                        return;
                    }
                }
            }
        }
    }
}

async fn send_event<S>(sender: &mut S, event: &LogEvent) -> Result<(), axum::Error>
where
    S: SinkExt<Message, Error = axum::Error> + Unpin,
{
    let text = match serde_json::to_string(event) {
        Ok(t) => t,
        Err(e) => {
            warn!("log stream: serialize failed: {}", e);
            return Ok(()); // skip this event but keep the connection
        }
    };
    sender.send(Message::Text(text)).await
}
