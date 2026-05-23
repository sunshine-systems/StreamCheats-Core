//! `/api/experimental/*` routes — SC-8.
//!
//! Read-side: `registry` returns the static list of known APIs;
//! `status` snapshots the manager's current selection / enabled /
//! running state. Write-side: `set_active` flips the selection (only
//! valid while stopped), `enable` / `disable` start and stop the
//! listener and persist the result.
//!
//! Handlers are thin — all the real work lives in
//! [`crate::experimental::Manager`].

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use tracing::{info, warn};

use crate::experimental::{SetActiveError, REGISTRY};
use crate::http::state::AppState;

/// `GET /api/experimental/registry` — static list of known APIs.
pub async fn registry() -> Json<serde_json::Value> {
    Json(json!({ "apis": REGISTRY }))
}

/// `GET /api/experimental/status` — current selection + running state.
pub async fn status(State(state): State<AppState>) -> Json<serde_json::Value> {
    let snap = state.experimental.status();
    Json(serde_json::to_value(snap).unwrap_or_else(|_| json!({})))
}

#[derive(Deserialize)]
pub struct SetActiveBody {
    pub id: String,
}

/// `POST /api/experimental/set_active` — switch the selected API.
/// Returns 409 when a listener is currently running OR when the id is
/// unknown (per SC-8 the UI is expected to disable before changing the
/// selection).
pub async fn set_active(
    State(state): State<AppState>,
    Json(body): Json<SetActiveBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.experimental.set_active(&body.id) {
        Ok(()) => {
            info!("experimental: set_active({}) ok", body.id);
            (
                StatusCode::OK,
                Json(json!({ "ok": true, "status": state.experimental.status() })),
            )
        }
        Err(SetActiveError::Unknown) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "unknown_api" })),
        ),
        Err(SetActiveError::Running) => (
            StatusCode::CONFLICT,
            Json(json!({ "ok": false, "error": "listener_running" })),
        ),
    }
}

/// `POST /api/experimental/enable` — start the listener for the
/// currently-selected API.
pub async fn enable(State(state): State<AppState>) -> (StatusCode, Json<serde_json::Value>) {
    match state.experimental.enable() {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "status": state.experimental.status() })),
        ),
        Err(e) => {
            warn!("experimental: enable failed: {}", e);
            (
                StatusCode::CONFLICT,
                Json(json!({
                    "ok": false,
                    "error": e,
                    "status": state.experimental.status(),
                })),
            )
        }
    }
}

/// `POST /api/experimental/disable` — stop the listener.
pub async fn disable(State(state): State<AppState>) -> Json<serde_json::Value> {
    state.experimental.disable();
    Json(json!({ "ok": true, "status": state.experimental.status() }))
}
