//! Axum route table. Routes are thin — every handler delegates to a
//! `services::*` orchestrator and translates the result into an HTTP
//! response.
//!
//! In addition to the JSON API surface (`/health`, `/bug-report`,
//! `/logs/stream`), this router optionally serves the bundled Next.js
//! static export when the `STREAMCHEATS_FRONTEND_DIR` env var points at a
//! readable directory. That makes the Electron renderer load
//! everything — UI HTML, `_next/*` assets, and the `/logs/stream`
//! WebSocket — from the same origin, sidestepping CORS preflight on
//! the WS upgrade and the asset-URL resolution quirks of `file://`.

pub mod bug_report;
pub mod health;
pub mod log_stream;
pub mod updates;

use std::path::{Path, PathBuf};

use axum::routing::{get, post};
use axum::Router;
use tower_http::services::{ServeDir, ServeFile};
use tracing::{info, warn};

use crate::http::state::AppState;

/// Env var Electron sets (and the standalone daemon optionally
/// honors) to point at the directory containing the static
/// `index.html` + `_next/` tree produced by `next build` + `next
/// export`. When unset, the daemon still serves the API; `/` just
/// returns a short text message so CLI launches aren't confusing.
pub const FRONTEND_DIR_ENV: &str = "STREAMCHEATS_FRONTEND_DIR";

/// Resolve the frontend dir from the environment, returning `Some`
/// only if it exists AND contains an `index.html`. Anything else
/// (missing var, missing dir, missing index) is logged as a warning
/// and treated as "no frontend bundled."
fn resolve_frontend_dir() -> Option<PathBuf> {
    let raw = std::env::var(FRONTEND_DIR_ENV).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let dir = PathBuf::from(trimmed);
    if !dir.is_dir() {
        warn!(
            "http: {}={} is not a directory — frontend disabled",
            FRONTEND_DIR_ENV,
            dir.display()
        );
        return None;
    }
    let index = dir.join("index.html");
    if !index.is_file() {
        warn!(
            "http: {} ({}) has no index.html — frontend disabled",
            FRONTEND_DIR_ENV,
            dir.display()
        );
        return None;
    }
    Some(dir)
}

/// Compose all routes into the final Router, ready to hand to axum.
pub fn build_router(state: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(health::handler))
        .route("/bug-report", post(bug_report::handler))
        .route("/logs/stream", get(log_stream::handler))
        .route("/api/updates/status", get(updates::status))
        .route("/api/updates/check", post(updates::check))
        .route("/api/updates/download", post(updates::download))
        .route("/api/updates/install", post(updates::install))
        .route(
            "/api/settings/experimental_builds",
            post(updates::set_experimental),
        )
        .with_state(state);

    match resolve_frontend_dir() {
        Some(dir) => {
            info!("http: serving frontend from {}", dir.display());
            api.fallback_service(build_static_service(&dir))
        }
        None => api.fallback(root_fallback_message),
    }
}

/// Build the static-file service that backs the frontend routes.
///
/// `append_index_html_on_directories(true)` resolves a request for
/// `/logs/` to `/logs/index.html` — exactly the directory-index
/// behaviour `file://` does NOT do and that broke sub-routes when we
/// loaded the static export via the file scheme. `.fallback(...)`
/// catches the remaining unknown paths (e.g. a hypothetical
/// `/settings/` route we haven't built yet, or a hard refresh on a
/// client-side route) and serves the root `index.html` so the SPA
/// router can take over.
fn build_static_service(dir: &Path) -> ServeDir<ServeFile> {
    ServeDir::new(dir)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(dir.join("index.html")))
}

/// Default `/` handler when no frontend is bundled. Plain text so a
/// curl from the command line is obviously informative instead of
/// landing on a 404.
async fn root_fallback_message() -> &'static str {
    "StreamCheats Core daemon — frontend not bundled in this build"
}
