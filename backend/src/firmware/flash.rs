//! Firmware flashing via `teensy_loader_cli` (SC-13).
//!
//! Owns the subprocess lifecycle for a Teensy firmware flash:
//!
//!   1. Resolve the `teensy_loader_cli.exe` binary path (env override
//!      first, then `<exe_dir>/vendor/teensy_loader_cli.exe`, then a
//!      few well-known dev locations under the repo).
//!   2. Spawn it as `teensy_loader_cli -mmcu=<mcu> -w -v <hex_path>`.
//!   3. Stream stdout/stderr line-by-line into the daemon's `tracing`
//!      log stream (where the Logs page consumes them).
//!   4. Block on exit. Exit code 0 → success. Anything else → failure
//!      with the captured stderr surfaced back to the caller.
//!
//! The orchestrator in [`super`] owns the state transitions
//! (`Ready`/`Available` → `Flashing` → `UpToDate`/`Failed`) and the
//! single-flight guard. This module is the dumb subprocess wrapper.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use thiserror::Error;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tracing::{info, warn};

/// Env var that lets the Electron shell (or a developer) point the
/// daemon at a non-default `teensy_loader_cli.exe`. Highest priority in
/// [`resolve_loader_path`].
pub const LOADER_ENV: &str = "STREAMCHEATS_TEENSY_LOADER_PATH";

/// File name we look for in every fallback location.
const LOADER_BIN: &str = "teensy_loader_cli.exe";

/// MCU flag value for Teensy 4.1. The firmware repo's `boards.txt`
/// pins `teensy-4.1` to the i.MX RT 1062 — the same MCU `teensy_loader_cli`
/// expects under the name `imxrt1062`. Future boards land in
/// [`mcu_for`].
const MCU_TEENSY_4_1: &str = "imxrt1062";

/// Map a parsed board id (as it appears in firmware asset filenames —
/// see [`super::filename::ParsedFilename::board`]) to the MCU flag
/// value [`teensy_loader_cli`] wants. Returns `None` for unrecognised
/// boards so callers can fail loudly rather than guess.
pub fn mcu_for(board: &str) -> Option<&'static str> {
    match board {
        "teensy-4.1" => Some(MCU_TEENSY_4_1),
        _ => None,
    }
}

/// Errors that can come out of a flash attempt.
#[derive(Debug, Error)]
pub enum FlashError {
    /// We couldn't find a `teensy_loader_cli.exe` to run. This is the
    /// "binary not bundled" path the UI surfaces verbatim — see
    /// the SC-13 PR body for the rationale.
    #[error("teensy_loader_cli binary not found (set {LOADER_ENV} or drop teensy_loader_cli.exe under backend/vendor/)")]
    BinaryMissing,
    /// We knew the binary path but `spawn` failed at the OS level.
    #[error("could not spawn teensy_loader_cli: {0}")]
    Spawn(String),
    /// The subprocess exited non-zero. `stderr` carries whatever the
    /// loader said on its way out (useful for "no Teensy connected" etc).
    #[error("teensy_loader_cli exited with code {code}: {stderr}")]
    NonZero { code: i32, stderr: String },
    /// The hex file doesn't exist / isn't readable / isn't a `.hex`.
    #[error("hex file invalid: {0}")]
    InvalidHex(String),
}

/// Locate the `teensy_loader_cli.exe` binary. Resolution order:
///   1. `STREAMCHEATS_TEENSY_LOADER_PATH` env var (set by Electron at
///      spawn from `process.resourcesPath`).
///   2. `<current_exe_dir>/vendor/teensy_loader_cli.exe` (packaged
///      sibling layout — useful when the daemon is started directly).
///   3. `<current_exe_dir>/teensy_loader_cli.exe` (electron-builder
///      drops `extraResources` next to the daemon binary in
///      `process.resourcesPath`).
///   4. `<cwd>/vendor/teensy_loader_cli.exe` then
///      `<cwd>/../backend/vendor/teensy_loader_cli.exe` (dev paths).
pub fn resolve_loader_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var(LOADER_ENV) {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let a = dir.join("vendor").join(LOADER_BIN);
            if a.is_file() {
                return Some(a);
            }
            let b = dir.join(LOADER_BIN);
            if b.is_file() {
                return Some(b);
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let candidates = [
            cwd.join("vendor").join(LOADER_BIN),
            cwd.join("backend").join("vendor").join(LOADER_BIN),
            cwd.join("..")
                .join("backend")
                .join("vendor")
                .join(LOADER_BIN),
        ];
        for c in candidates.iter() {
            if c.is_file() {
                return Some(c.clone());
            }
        }
    }
    None
}

/// Validate a caller-supplied hex path: must exist, be a file, end in
/// `.hex` (case-insensitive), and be non-empty. Centralised so both
/// `/flash` (release-driven) and `/flash_local` (manual picker) share
/// the same gate.
pub fn validate_hex_path(path: &Path) -> Result<(), FlashError> {
    if !path.is_file() {
        return Err(FlashError::InvalidHex(format!(
            "{} does not exist or is not a file",
            path.display()
        )));
    }
    let ext_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("hex"))
        .unwrap_or(false);
    if !ext_ok {
        return Err(FlashError::InvalidHex(format!(
            "{} is not a .hex file",
            path.display()
        )));
    }
    match std::fs::metadata(path) {
        Ok(m) if m.len() == 0 => Err(FlashError::InvalidHex(format!(
            "{} is empty",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(e) => Err(FlashError::InvalidHex(format!("{}: {}", path.display(), e))),
    }
}

/// Run a single flash attempt. Blocks (asynchronously) until the
/// loader process exits. Stdout / stderr lines are forwarded to
/// `tracing` so they show up in the `/logs/stream` feed for the UI's
/// Logs page in real time.
///
/// Returns `Ok(())` on exit code 0, [`FlashError::NonZero`] otherwise.
/// The caller is responsible for state transitions and for ensuring
/// only one flash runs at a time — see [`super::FirmwareUpdater::start_flash`].
pub async fn run_flash(mcu: &str, hex_path: &Path) -> Result<(), FlashError> {
    let loader = resolve_loader_path().ok_or(FlashError::BinaryMissing)?;
    validate_hex_path(hex_path)?;

    info!(
        "firmware: spawning teensy_loader_cli loader={} mcu={} hex={}",
        loader.display(),
        mcu,
        hex_path.display()
    );

    // `teensy_loader_cli` flags:
    //   -mmcu=<id>  pin MCU type
    //   -w          wait for the bootloader (don't fail if it isn't there yet)
    //   -v          verbose (sends progress lines to stderr)
    let mut cmd = Command::new(&loader);
    cmd.arg(format!("-mmcu={}", mcu))
        .arg("-w")
        .arg("-v")
        .arg(hex_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    let mut child = cmd.spawn().map_err(|e| FlashError::Spawn(e.to_string()))?;

    // Pump stdout and stderr concurrently so neither pipe can block
    // the other. stderr is also collected into a buffer so we can hand
    // it back on failure for the UI to render.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stdout_task = tokio::spawn(async move {
        if let Some(out) = stdout {
            let mut reader = BufReader::new(out).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                info!("teensy_loader_cli: {}", line);
            }
        }
    });

    let stderr_task = tokio::spawn(async move {
        let mut collected = String::new();
        if let Some(err) = stderr {
            let mut reader = BufReader::new(err).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                warn!("teensy_loader_cli: {}", line);
                if collected.len() < 4096 {
                    collected.push_str(&line);
                    collected.push('\n');
                }
            }
        }
        collected
    });

    let status = child
        .wait()
        .await
        .map_err(|e| FlashError::Spawn(format!("wait failed: {}", e)))?;

    // Drain pump tasks so we don't leave them dangling.
    let _ = stdout_task.await;
    let stderr_buf = stderr_task.await.unwrap_or_default();

    if status.success() {
        info!("firmware: teensy_loader_cli completed successfully");
        Ok(())
    } else {
        let code = status.code().unwrap_or(-1);
        Err(FlashError::NonZero {
            code,
            stderr: stderr_buf.trim().to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn mcu_lookup_known_board() {
        assert_eq!(mcu_for("teensy-4.1"), Some("imxrt1062"));
    }

    #[test]
    fn mcu_lookup_unknown_board() {
        assert!(mcu_for("teensy-9.9").is_none());
    }

    #[test]
    fn validate_rejects_missing_file() {
        let p = std::env::temp_dir().join("sc13-does-not-exist.hex");
        let _ = std::fs::remove_file(&p);
        let err = validate_hex_path(&p).unwrap_err();
        assert!(matches!(err, FlashError::InvalidHex(_)));
    }

    #[test]
    fn validate_rejects_non_hex_extension() {
        let p = std::env::temp_dir().join("sc13-not-hex.bin");
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(b"x").unwrap();
        let err = validate_hex_path(&p).unwrap_err();
        let _ = std::fs::remove_file(&p);
        assert!(matches!(err, FlashError::InvalidHex(_)));
    }

    #[test]
    fn validate_rejects_empty_file() {
        let p = std::env::temp_dir().join("sc13-empty.hex");
        let _ = std::fs::File::create(&p).unwrap();
        let err = validate_hex_path(&p).unwrap_err();
        let _ = std::fs::remove_file(&p);
        assert!(matches!(err, FlashError::InvalidHex(_)));
    }

    #[test]
    fn validate_accepts_non_empty_hex() {
        let p = std::env::temp_dir().join("sc13-ok.hex");
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(b":00000001FF\n").unwrap();
        let r = validate_hex_path(&p);
        let _ = std::fs::remove_file(&p);
        assert!(r.is_ok());
    }

    #[test]
    fn resolve_returns_env_path_when_set() {
        // Use a temp file as a stand-in "binary".
        let p = std::env::temp_dir().join("sc13-fake-loader.exe");
        std::fs::File::create(&p).unwrap();
        std::env::set_var(LOADER_ENV, &p);
        let got = resolve_loader_path();
        std::env::remove_var(LOADER_ENV);
        let _ = std::fs::remove_file(&p);
        assert_eq!(got.as_deref(), Some(p.as_path()));
    }
}
