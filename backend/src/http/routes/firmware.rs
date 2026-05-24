//! `/api/firmware/*` routes — see SC-10 + SC-13.
//!
//! Read-side endpoints (`status`, `releases`) snapshot the firmware
//! updater's shared state. Write-side endpoints (`check`, `download`,
//! `flash`, `flash_local`) kick off background work and return 202 on
//! dispatch.
//!
//! Flash dispatch (SC-13): both `/flash` and `/flash_local` first
//! validate single-flight + path/version preconditions and return
//! 409 with a stable error code on rejection; otherwise they spawn
//! the background `teensy_loader_cli` task and return 202. If the
//! daemon can't find the `teensy_loader_cli.exe` binary at all (not
//! bundled in this build), the failure is reported via the state
//! machine's `Failed` transition with `binary_not_bundled`-shaped
//! text — the synchronous response is still 202 because resolving
//! the binary is a runtime concern inside the spawn.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use tracing::{info, warn};

use crate::firmware::device::InstalledFirmware;
use crate::http::state::AppState;


/// `GET /api/firmware/status` — installed version (from heartbeat) +
/// the current updater [`crate::firmware::State`] + the configured
/// repo + the board reported by the most-recently-seen release asset
/// (so the UI doesn't hard-code `teensy-4.1`).
pub async fn status(State(state): State<AppState>) -> Json<serde_json::Value> {
    let snap = state.firmware.snapshot().await;
    let releases = state.firmware.releases().await;
    let installed = state.firmware.installed.snapshot();

    let (installed_version, installed_channel) = match installed {
        InstalledFirmware::Known { version, .. } => (Some(format!("rel-{}", version)), "unknown"),
        InstalledFirmware::Unknown => (None, "unknown"),
    };
    let board = releases.first().map(|r| r.board.clone());

    // Cheap synchronous "is the bundled loader where we expect it?"
    // check. We do NOT shell out to `--help` on every status poll —
    // that's reserved for the resolve path inside `start_flash`.
    // With a correct install this is always true; surface it so the UI
    // can show a clear "please reinstall" error if it ever isn't.
    let loader_ready = state.firmware.loader_present();

    Json(json!({
        "state": snap,
        "installed_version": installed_version,
        // Channel of the installed firmware. Without the commit suffix
        // the device-reported version can't disambiguate stable vs.
        // nightly of the same major.minor — surface `"unknown"` until
        // the firmware exposes it explicitly (then SC-13 can refine).
        "channel": installed_channel,
        "repo": state.firmware.repo().await,
        "board": board,
        "auto_check": state.firmware.auto_check(),
        "experimental_builds": state.firmware.experimental(),
        // Existence-only check for the bundled loader. With a correct
        // install this is always true; the UI surfaces "Flash tool
        // missing — please reinstall" when it isn't.
        "loader_ready": loader_ready,
    }))
}

/// `GET /api/firmware/releases` — full list of releases (sorted newest
/// first by `published_at`). Filtering by channel / search is done by
/// the UI — the assumption is the list stays small enough not to need
/// server-side pagination for v1.
pub async fn releases(State(state): State<AppState>) -> Json<serde_json::Value> {
    let entries = state.firmware.releases().await;
    Json(json!({ "releases": entries }))
}

/// `POST /api/firmware/check` — kick off an immediate check. Returns
/// the new status snapshot.
pub async fn check(State(state): State<AppState>) -> Json<serde_json::Value> {
    state.firmware.check_once().await;
    let snap = state.firmware.snapshot().await;
    Json(json!({ "state": snap }))
}

#[derive(Deserialize)]
pub struct DownloadBody {
    pub version: String,
}

/// `POST /api/firmware/download` — start downloading a specific
/// release. Body: `{ "version": "rel-5.17" }`.
pub async fn download(
    State(state): State<AppState>,
    Json(body): Json<DownloadBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.firmware.start_download(&body.version).await {
        Ok(()) => {
            info!("firmware: download dispatched for {}", body.version);
            (StatusCode::ACCEPTED, Json(json!({ "ok": true })))
        }
        Err(e) => {
            warn!("firmware: download rejected: {}", e);
            (
                StatusCode::CONFLICT,
                Json(json!({ "ok": false, "error": e })),
            )
        }
    }
}

#[derive(Deserialize)]
pub struct FlashBody {
    pub version: String,
}

/// `POST /api/firmware/flash` — flash a specific previously-downloaded
/// release. Body: `{ "version": "rel-5.17" }`. The release must be in
/// `Ready` state for that exact version (i.e. user already hit
/// Download). Returns 202 on dispatch; 409 with `{ error: "..." }` on
/// rejection. Error codes mirror [`crate::firmware::FirmwareUpdater::start_flash`].
pub async fn flash(
    State(state): State<AppState>,
    Json(body): Json<FlashBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.firmware.start_flash(&body.version).await {
        Ok(()) => {
            info!("firmware: flash dispatched for {}", body.version);
            (StatusCode::ACCEPTED, Json(json!({ "ok": true })))
        }
        Err(e) => {
            warn!("firmware: flash rejected: {}", e);
            // Surface loader-not-available as 503 so the UI can show a
            // "please reinstall" message rather than treating it like a
            // transient conflict.
            let status = if e == "loader_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::CONFLICT
            };
            (status, Json(json!({ "ok": false, "error": e })))
        }
    }
}

#[derive(Deserialize)]
pub struct FlashLocalBody {
    pub hex_path: String,
}

/// `POST /api/firmware/flash_local` — flash an arbitrary local `.hex`
/// file. Body: `{ "hex_path": "C:\\absolute\\path\\to\\firmware.hex" }`.
/// Useful for downgrading to an older firmware not in the release
/// feed. Validation: file exists, `.hex` extension, non-empty. Same
/// single-flight semantics as `/flash`.
pub async fn flash_local(
    State(state): State<AppState>,
    Json(body): Json<FlashLocalBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let path = std::path::PathBuf::from(&body.hex_path);
    match state.firmware.start_flash_local(path).await {
        Ok(()) => {
            info!("firmware: flash_local dispatched for {}", body.hex_path);
            (StatusCode::ACCEPTED, Json(json!({ "ok": true })))
        }
        Err(e) => {
            warn!("firmware: flash_local rejected: {}", e);
            let status = if e == "loader_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::CONFLICT
            };
            (status, Json(json!({ "ok": false, "error": e })))
        }
    }
}

/// `POST /api/firmware/cancel_flash` — kill the in-flight flash. Returns
/// 202 `{ ok: true }` on dispatch (the supervision loop in
/// [`crate::firmware::flash::run_flash`] will kill the subprocess and
/// transition the state machine to `Failed { error: "user_cancelled", ... }`
/// shortly after). Returns 409 `{ ok: false, error: "not_flashing" }`
/// when nothing is in flight, so a stray button press doesn't silently
/// no-op.
pub async fn cancel_flash(
    State(state): State<AppState>,
) -> (StatusCode, Json<serde_json::Value>) {
    if state.firmware.cancel_flash().await {
        info!("firmware: cancel_flash signalled");
        (StatusCode::ACCEPTED, Json(json!({ "ok": true })))
    } else {
        (
            StatusCode::CONFLICT,
            Json(json!({ "ok": false, "error": "not_flashing" })),
        )
    }
}
