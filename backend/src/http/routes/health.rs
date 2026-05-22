//! `GET /health` — cheap readiness probe used by the Electron shell to
//! confirm the daemon is up before issuing any other request.

use std::time::Instant;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;

use crate::http::state::AppState;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub uptime_seconds: u64,
    pub version: &'static str,
}

pub async fn handler(State(state): State<AppState>) -> (StatusCode, Json<HealthResponse>) {
    let uptime = Instant::now()
        .saturating_duration_since(state.started_at)
        .as_secs();
    (
        StatusCode::OK,
        Json(HealthResponse {
            status: "ok",
            uptime_seconds: uptime,
            version: env!("CARGO_PKG_VERSION"),
        }),
    )
}
