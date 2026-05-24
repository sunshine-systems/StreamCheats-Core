//! Resolution of the bundled `teensy_loader_cli.exe`.
//!
//! The binary is now shipped inside the installer (see
//! `electron/package.json`'s `extraResources` rule + `backend/vendor/`).
//! Electron sets `STREAMCHEATS_TEENSY_LOADER_PATH` before spawning the
//! daemon in both dev and packaged modes — see `electron/main.js` — so
//! the daemon's only job here is to read the env var, verify the file
//! exists, and probe it once with `--help` to make sure the binary
//! actually runs on this machine.
//!
//! This replaces the SC-14 download-to-AppData flow: the binary is
//! always present after install, so the "fetch on first flash" UX is
//! gone and `loader_ready` is just an existence check.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use thiserror::Error;
use tokio::process::Command;

use super::flash::LOADER_ENV;

/// How long the `--help` probe is allowed to take. The loader prints a
/// usage banner and exits immediately on every platform; if it doesn't,
/// something is wrong with the binary (corrupt copy, wrong arch).
const HELP_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Errors from [`resolve_loader`].
#[derive(Debug, Error)]
pub enum LoaderError {
    /// `STREAMCHEATS_TEENSY_LOADER_PATH` is unset / empty, OR the file
    /// it points to doesn't exist. With a correct install this never
    /// fires — electron sets the env var to the bundled binary in both
    /// dev and packaged modes.
    #[error("teensy_loader_cli.exe not found — reinstall StreamCheats Core")]
    NotFound,
    /// The binary exists but `--help` didn't exit cleanly — likely
    /// wrong architecture or a corrupt file.
    #[error("loader did not run cleanly: {0}")]
    NotRunnable(String),
}

/// Read the env override (`STREAMCHEATS_TEENSY_LOADER_PATH`). Trimmed,
/// empty rejected. Doesn't validate file existence — callers do that
/// as part of [`resolve_loader`].
fn env_override() -> Option<PathBuf> {
    let raw = std::env::var(LOADER_ENV).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

/// Cheap synchronous existence check used by `GET /api/firmware/status`'s
/// `loader_ready` field. Doesn't run `--help` — that's reserved for the
/// resolve path so we're not shelling out on every status poll.
pub fn loader_present() -> bool {
    match env_override() {
        Some(p) => p.is_file(),
        None => false,
    }
}

/// Resolve a usable `teensy_loader_cli.exe` path. Reads the env override,
/// verifies the file exists, probes it with `--help`. Returns
/// `LoaderError::NotFound` if the env var is unset / missing, or
/// `NotRunnable` if the probe fails.
pub async fn resolve_loader() -> Result<PathBuf, LoaderError> {
    let p = env_override().ok_or(LoaderError::NotFound)?;
    if !p.is_file() {
        return Err(LoaderError::NotFound);
    }
    probe_loader(&p).await?;
    Ok(p)
}

/// Run `<loader> --help` with a short timeout. The loader prints its
/// usage and exits — that's a "this binary runs" signal, which is all
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resolve_errors_when_env_unset() {
        // Save + clear the env var for this test so we deterministically
        // hit the "unset" branch. Other tests in the suite don't read it
        // through this path, but be a good citizen and restore on exit.
        let prev = std::env::var(LOADER_ENV).ok();
        std::env::remove_var(LOADER_ENV);
        let err = resolve_loader().await.unwrap_err();
        if let Some(v) = prev {
            std::env::set_var(LOADER_ENV, v);
        }
        assert!(matches!(err, LoaderError::NotFound));
    }

    #[tokio::test]
    async fn resolve_errors_when_env_points_to_missing_file() {
        let prev = std::env::var(LOADER_ENV).ok();
        let bogus = std::env::temp_dir()
            .join(format!("sc-loader-missing-{}.exe", std::process::id()));
        let _ = std::fs::remove_file(&bogus);
        std::env::set_var(LOADER_ENV, bogus.as_os_str());
        let err = resolve_loader().await.unwrap_err();
        match prev {
            Some(v) => std::env::set_var(LOADER_ENV, v),
            None => std::env::remove_var(LOADER_ENV),
        }
        assert!(matches!(err, LoaderError::NotFound));
    }

    #[test]
    fn loader_present_false_when_env_unset() {
        let prev = std::env::var(LOADER_ENV).ok();
        std::env::remove_var(LOADER_ENV);
        let got = loader_present();
        if let Some(v) = prev {
            std::env::set_var(LOADER_ENV, v);
        }
        assert!(!got);
    }
}
