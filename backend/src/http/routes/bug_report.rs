//! `POST /bug-report` — assemble a diagnostic zip and stream it back to
//! the caller.
//!
//! Handler stays thin: delegate to [`crate::services::bug_report::build_bundle`],
//! then map the result onto either a 200-with-zip or a 400-with-JSON.
//! All filesystem / encoding work lives in the service layer.

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use tracing::info;

use crate::http::state::AppState;
use crate::services::bug_report::{build_bundle, BugReportError};

pub async fn handler(State(state): State<AppState>) -> Response {
    // The orchestrator is synchronous (filesystem reads + zip encoding
    // — no awaits). Run it on the blocking pool so a heavy log slice
    // doesn't tie up an axum worker thread.
    let result = tokio::task::spawn_blocking(move || build_bundle(&state)).await;

    let bundle = match result {
        Ok(Ok(bundle)) => bundle,
        Ok(Err(BugReportError::FileLoggingDisabled)) => {
            info!("bug report: rejected (file logging disabled)");
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "file_logging_disabled"})),
            )
                .into_response();
        }
        Ok(Err(e)) => {
            tracing::warn!("bug report: build failed: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "bug_report_failed", "detail": e.to_string()})),
            )
                .into_response();
        }
        Err(join_err) => {
            tracing::warn!("bug report: blocking task panicked: {}", join_err);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "internal_error"})),
            )
                .into_response();
        }
    };

    info!(
        "bug report: emitted {} entries totaling {} bytes",
        bundle.entry_count,
        bundle.bytes.len()
    );

    let disposition = format!("attachment; filename=\"{}\"", bundle.filename);
    let mut resp = Response::new(Body::from(bundle.bytes));
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    h.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition)
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    *resp.status_mut() = StatusCode::OK;
    resp
}
