//! On-demand acquisition of `teensy_loader_cli.exe` (SC-14).
//!
//! Replaces SC-13's bundled-binary plan. The loader is downloaded to
//! `<data_dir>/bin/teensy_loader_cli.exe` on first flash and cached
//! there from then on. The download URL + expected SHA-256 are read
//! from `config.json`'s `firmware.loader_url` / `firmware.loader_sha256`
//! so the maintainer can swap hosting without a code change.
//!
//! Resolution order (see [`resolve_loader`]):
//!   1. `STREAMCHEATS_TEENSY_LOADER_PATH` env var (dev override) — if set,
//!      file exists, AND `--help` exits 0.
//!   2. Cached `<data_dir>/bin/teensy_loader_cli.exe` — if present AND
//!      `--help` exits 0.
//!   3. Otherwise: not present. The caller should invoke
//!      [`download_loader`] to fetch it, then re-resolve.
//!
//! The download is a streaming reqwest GET into a `.part` file, hashed
//! in-flight, with a final SHA-256 check + rename-into-place. Mirrors
//! the firmware-asset download in [`super::download`] — same crate
//! versions, same retry-on-mismatch posture (we just delete the partial
//! and surface an error; the user can retry from the UI).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tracing::{info, warn};

use super::flash::LOADER_ENV;

/// File name used inside `<data_dir>/bin/`. Constant so the cheap
/// status-side existence check (`<data_dir>/bin/<this>`.exists()) lines
/// up with what the download path writes.
pub const LOADER_BIN: &str = "teensy_loader_cli.exe";

/// How long the `--help` probe is allowed to take. The loader prints a
/// usage banner and exits immediately on every platform; if it doesn't,
/// something is wrong with the binary (corrupt download, wrong arch).
const HELP_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Errors from [`ensure_loader`] / [`download_loader`]. These map 1:1 to
/// the wire-form error codes returned by `POST /api/firmware/ensure_loader`.
#[derive(Debug, Error)]
pub enum LoaderError {
    /// `firmware.loader_url` is empty in `config.json`. This is the
    /// graceful-degradation path for nightlies that ship before the
    /// maintainer has hosted a Windows build of `teensy_loader_cli`.
    #[error("loader_url not configured — set firmware.loader_url in config.json")]
    UrlNotConfigured,
    /// Network / HTTP error while fetching the binary.
    #[error("network error: {0}")]
    Network(String),
    /// The download completed but the SHA-256 didn't match
    /// `firmware.loader_sha256`. The partial file is deleted before
    /// this is returned.
    #[error("sha256 mismatch: expected {expected}, got {got}")]
    Sha256Mismatch { expected: String, got: String },
    /// Writing the file to disk failed.
    #[error("io error: {0}")]
    Io(String),
    /// The downloaded binary exists but `--help` didn't exit cleanly —
    /// likely wrong architecture or corrupt download.
    #[error("loader did not run cleanly: {0}")]
    NotRunnable(String),
}

/// Cheap synchronous existence check used by `GET /api/firmware/status`'s
/// `loader_ready` field. Does NOT run `--help` — that's deliberately
/// reserved for [`probe_loader`] on the resolve path so we're not
/// shelling out on every status poll.
pub fn cached_loader_path(data_dir: &Path) -> PathBuf {
    data_dir.join("bin").join(LOADER_BIN)
}

/// Is there a cached loader on disk? (Existence only — see
/// [`cached_loader_path`] for the rationale.)
pub fn loader_present(data_dir: &Path) -> bool {
    cached_loader_path(data_dir).is_file()
}

/// Resolve a usable `teensy_loader_cli.exe` path. Walks: env override
/// (probed), cached AppData path (probed), then `Ok(None)` signalling
/// "needs download." Errors only on probe failures the caller can't
/// recover from (e.g. cached file exists but won't run — in that case
/// the caller should typically re-download).
pub async fn resolve_loader(data_dir: &Path) -> Result<Option<PathBuf>, LoaderError> {
    if let Some(p) = env_override() {
        if p.is_file() && probe_loader(&p).await.is_ok() {
            return Ok(Some(p));
        }
    }
    let cached = cached_loader_path(data_dir);
    if cached.is_file() && probe_loader(&cached).await.is_ok() {
        return Ok(Some(cached));
    }
    Ok(None)
}

/// Read the dev-only env override (`STREAMCHEATS_TEENSY_LOADER_PATH`).
/// Trimmed, empty rejected. Doesn't validate file existence — callers
/// do that as part of [`resolve_loader`].
fn env_override() -> Option<PathBuf> {
    let raw = std::env::var(LOADER_ENV).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

/// Run `<loader> --help` with a short timeout. The loader prints its
/// usage and exits non-zero (it treats `--help` as an error: "unknown
/// option") — that's still a "this binary runs" signal, which is all
/// we need. We treat ANY exit (zero or non-zero) within the timeout
/// window as success; only spawn errors and timeouts are fatal.
pub async fn probe_loader(path: &Path) -> Result<(), LoaderError> {
    let mut cmd = Command::new(path);
    cmd.arg("--help")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    let child = cmd
        .spawn()
        .map_err(|e| LoaderError::NotRunnable(format!("spawn: {}", e)))?;

    match tokio::time::timeout(HELP_PROBE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(LoaderError::NotRunnable(format!("wait: {}", e))),
        Err(_) => Err(LoaderError::NotRunnable(format!(
            "--help probe timed out after {:?}",
            HELP_PROBE_TIMEOUT
        ))),
    }
}

/// Download `teensy_loader_cli.exe` from `url`, verify SHA-256 against
/// `expected_sha256`, and atomically rename into `<data_dir>/bin/`.
/// Returns the final cached path on success. On any failure the
/// partial `.part` file is deleted so a retry starts clean.
///
/// The download is streamed to disk with the SHA computed in the same
/// pass — mirrors [`super::download::download_to_temp`]. We hold the
/// whole response in memory only for very small bodies; for an
/// expected-MB-sized teensy loader binary this is well-bounded.
pub async fn download_loader(
    client: &reqwest::Client,
    data_dir: &Path,
    url: &str,
    expected_sha256: Option<&str>,
) -> Result<PathBuf, LoaderError> {
    if url.trim().is_empty() {
        return Err(LoaderError::UrlNotConfigured);
    }

    let bin_dir = data_dir.join("bin");
    tokio::fs::create_dir_all(&bin_dir)
        .await
        .map_err(|e| LoaderError::Io(format!("create {}: {}", bin_dir.display(), e)))?;

    let final_path = bin_dir.join(LOADER_BIN);
    let mut part_path = final_path.as_os_str().to_owned();
    part_path.push(".part");
    let part_path = PathBuf::from(part_path);

    if part_path.exists() {
        let _ = tokio::fs::remove_file(&part_path).await;
    }

    info!("loader: downloading from {} -> {}", url, final_path.display());

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| LoaderError::Network(format!("GET {}: {}", url, e)))?;
    if !resp.status().is_success() {
        return Err(LoaderError::Network(format!("HTTP {}", resp.status())));
    }

    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| LoaderError::Io(format!("create {}: {}", part_path.display(), e)))?;
    let mut hasher = Sha256::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| LoaderError::Network(format!("read chunk: {}", e)))?;
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| LoaderError::Io(format!("write chunk: {}", e)))?;
    }
    file.flush()
        .await
        .map_err(|e| LoaderError::Io(format!("flush: {}", e)))?;
    drop(file);

    let digest = hasher.finalize();
    let got_sha: String = digest.iter().map(|b| format!("{:02x}", b)).collect();

    if let Some(expected) = expected_sha256.map(str::trim).filter(|s| !s.is_empty()) {
        if !got_sha.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(LoaderError::Sha256Mismatch {
                expected: expected.to_string(),
                got: got_sha,
            });
        }
    } else {
        warn!(
            "loader: no firmware.loader_sha256 configured — accepting binary unverified (sha256={})",
            got_sha
        );
    }

    if final_path.exists() {
        let _ = tokio::fs::remove_file(&final_path).await;
    }
    tokio::fs::rename(&part_path, &final_path)
        .await
        .map_err(|e| LoaderError::Io(format!("rename: {}", e)))?;

    // Probe so callers don't have to re-resolve to confirm runnability.
    probe_loader(&final_path).await?;

    info!(
        "loader: cached at {} (sha256={})",
        final_path.display(),
        got_sha
    );
    Ok(final_path)
}

/// Resolve OR download. Convenience for the `POST /api/firmware/ensure_loader`
/// endpoint and the pre-flight inside `start_flash`. Tries the resolver
/// first; if it's empty AND a URL is configured, downloads.
pub async fn ensure_loader(
    client: &reqwest::Client,
    data_dir: &Path,
    url: Option<&str>,
    expected_sha256: Option<&str>,
) -> Result<PathBuf, LoaderError> {
    if let Some(p) = resolve_loader(data_dir).await? {
        return Ok(p);
    }
    let url = url.map(str::trim).filter(|s| !s.is_empty());
    match url {
        Some(u) => download_loader(client, data_dir, u, expected_sha256).await,
        None => Err(LoaderError::UrlNotConfigured),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_path_lives_under_bin() {
        let p = cached_loader_path(Path::new("/tmp/data"));
        assert!(p.ends_with("bin/teensy_loader_cli.exe") || p.ends_with("bin\\teensy_loader_cli.exe"));
    }

    #[test]
    fn loader_present_false_when_missing() {
        let dir = std::env::temp_dir().join(format!(
            "sc14-loader-missing-{}",
            std::process::id()
        ));
        assert!(!loader_present(&dir));
    }

    #[tokio::test]
    async fn ensure_loader_errors_when_no_url_and_no_cache() {
        let dir = std::env::temp_dir().join(format!(
            "sc14-loader-no-url-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let client = reqwest::Client::new();
        let err = ensure_loader(&client, &dir, None, None).await.unwrap_err();
        assert!(matches!(err, LoaderError::UrlNotConfigured));
    }

    #[tokio::test]
    async fn download_errors_on_empty_url() {
        let dir = std::env::temp_dir().join(format!(
            "sc14-loader-empty-url-{}",
            std::process::id()
        ));
        let client = reqwest::Client::new();
        let err = download_loader(&client, &dir, "", None).await.unwrap_err();
        assert!(matches!(err, LoaderError::UrlNotConfigured));
    }
}
