//! `/api/updates/*` and `/api/settings/experimental_builds` routes.
//!
//! Handler shape mirrors the other route modules: extract the shared
//! [`AppState`], call into the updater orchestrator, translate the
//! result into JSON. The polling loop runs in the background — these
//! handlers are all cheap.

use std::sync::atomic::Ordering;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use tracing::{info, warn};

use crate::http::state::AppState;
use crate::util::settings::set_experimental_builds;

/// `GET /api/updates/status` — snapshot of the current updater state.
pub async fn status(State(state): State<AppState>) -> Json<serde_json::Value> {
    let snap = state.updater.snapshot().await;
    Json(json!({
        "state": snap,
        "experimental_builds": state.updater.experimental(),
    }))
}

/// `POST /api/updates/check` — kick off an immediate check. Returns
/// the new state after the check completes.
pub async fn check(State(state): State<AppState>) -> Json<serde_json::Value> {
    state.updater.check_once().await;
    let snap = state.updater.snapshot().await;
    Json(json!({"state": snap}))
}

/// `POST /api/updates/download` — start downloading the available
/// installer. Returns 202 (Accepted) on dispatch.
pub async fn download(State(state): State<AppState>) -> (StatusCode, Json<serde_json::Value>) {
    match state.updater.start_download().await {
        Ok(()) => (StatusCode::ACCEPTED, Json(json!({"ok": true}))),
        Err(e) => (
            StatusCode::CONFLICT,
            Json(json!({"ok": false, "error": e})),
        ),
    }
}

/// `POST /api/updates/install` — launch the downloaded installer and
/// signal the daemon to exit so the installer can replace files on disk.
pub async fn install(State(state): State<AppState>) -> (StatusCode, Json<serde_json::Value>) {
    match state.updater.install_now().await {
        Ok(path) => {
            info!("updater: installer launched ({}) — signalling daemon shutdown", path.display());
            // Brief delay before flipping `running` so this HTTP
            // response makes it back to the client before the server
            // begins tearing down.
            let running = state.running.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                running.store(false, Ordering::SeqCst);
            });
            (
                StatusCode::OK,
                Json(json!({"ok": true, "installer_path": path.to_string_lossy()})),
            )
        }
        Err(e) => {
            warn!("updater: install failed: {}", e);
            (
                StatusCode::CONFLICT,
                Json(json!({"ok": false, "error": e})),
            )
        }
    }
}

#[derive(Deserialize)]
pub struct ExperimentalBuildsBody {
    pub enabled: bool,
}

/// `POST /api/settings/experimental_builds` — toggle the nightly
/// channel. Persists to `config.json` and updates the live updater
/// flag.
pub async fn set_experimental(
    State(state): State<AppState>,
    Json(body): Json<ExperimentalBuildsBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    state.updater.set_experimental(body.enabled);
    // Mirror to the firmware updater so the nightly channel filter
    // stays consistent across both surfaces.
    state.firmware.set_experimental(body.enabled);
    match set_experimental_builds(&state.cwd, body.enabled) {
        Ok(()) => {
            info!(
                "settings: experimental_builds set to {} (persisted to config.json)",
                body.enabled
            );
            (
                StatusCode::OK,
                Json(json!({"ok": true, "enabled": body.enabled})),
            )
        }
        Err(e) => {
            warn!("settings: persist experimental_builds failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "ok": false,
                    "enabled": body.enabled,
                    "error": format!("persist failed: {}", e),
                })),
            )
        }
    }
}
