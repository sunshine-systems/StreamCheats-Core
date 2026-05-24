//! Firmware flashing via `teensy_loader_cli` (SC-13 + SC-14).
//!
//! Owns the subprocess lifecycle for a Teensy firmware flash:
//!
//!   1. Caller provides a resolved `teensy_loader_cli.exe` path —
//!      acquisition is owned by [`super::loader`] (SC-14: downloaded to
//!      `<data_dir>/bin/` on demand).
//!   2. Spawn it as `teensy_loader_cli -mmcu=<mcu> -w -v <hex_path>`.
//!   3. Stream stdout/stderr line-by-line into the daemon's `tracing`
//!      log stream (where the Logs page consumes them) AND into the
//!      shared phase/log_tail mirror so the UI stepper modal can show
//!      what the loader is currently doing.
//!   4. Block on exit. Exit code 0 → success. Anything else → failure
//!      with the captured stderr surfaced back to the caller.
//!
//! Phase tracking (Updates restructure):
//!   The orchestrator passes a `FlashControl` handle holding the shared
//!   `State` mutex, a cancel signal, and a kill-switch. We pattern-match
//!   stdout lines to advance `FlashPhase` through Starting → WaitingForDevice
//!   → Programming → Booting. If we're stuck in WaitingForDevice for
//!   60s with no further progress, OR if the user POSTs cancel_flash,
//!   we kill the subprocess. The orchestrator (super::FirmwareUpdater)
//!   owns the final state transitions — this module is the dumb
//!   subprocess wrapper plus the line-by-line phase parser.
//!
//! The orchestrator in [`super`] owns the state transitions
//! (`Ready`/`Available` → `Flashing` → `UpToDate`/`Failed`), the
//! single-flight guard, AND the loader-resolve preflight.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use thiserror::Error;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Mutex, Notify};
use tokio::time::Instant;
use tracing::{info, warn};

use super::{FlashPhase, State};

/// Dev-only env override. When set + the file exists + `--help` runs,
/// [`super::loader::resolve_loader`] returns that path verbatim. Kept
/// as a back door for developers who want to point the daemon at a
/// custom-built `teensy_loader_cli.exe` without dropping it in the
/// cache directory.
pub const LOADER_ENV: &str = "STREAMCHEATS_TEENSY_LOADER_PATH";

/// MCU flag value for Teensy 4.1. The firmware repo's `boards.txt`
/// pins `teensy-4.1` to the i.MX RT 1062 — the same MCU `teensy_loader_cli`
/// expects under the name `imxrt1062`. Future boards land in
/// [`mcu_for`].
const MCU_TEENSY_4_1: &str = "imxrt1062";

/// How long we'll sit in `WaitingForDevice` before assuming the user
/// isn't going to press the button. After this window we kill the
/// subprocess and surface a `wait_for_device_timeout` error — the UI
/// shows a "Didn't see a button press" message with a Retry button.
pub const WAIT_FOR_DEVICE_TIMEOUT: Duration = Duration::from_secs(60);

/// Cap on `State::Flashing::log_tail`. ~20 lines is enough for the
/// stepper modal to show recent loader output without ballooning the
/// state snapshot the `/api/firmware/status` poll returns every second.
pub const LOG_TAIL_CAP: usize = 20;

/// Substring matches we look for on stdout to advance the phase.
/// Verified against teensy_loader_cli 2.3 by running an end-to-end
/// flash; see CLAUDE.md "Captured flash lifecycle" for the full
/// sequence.
const PAT_WAITING: &str = "Waiting for Teensy device";
const PAT_FOUND: &str = "Found HalfKay Bootloader";
const PAT_BOOTING: &str = "Booting";

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
    /// Subprocess sat in `WaitingForDevice` for [`WAIT_FOR_DEVICE_TIMEOUT`]
    /// without ever transitioning to `Programming` — we killed it.
    #[error("timed out waiting for the user to press the button")]
    WaitForDeviceTimeout,
    /// Caller invoked the `Notify` on `FlashControl::cancel` (the
    /// `POST /api/firmware/cancel_flash` endpoint).
    #[error("flash was cancelled by the user")]
    Cancelled,
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

/// Control handle the orchestrator passes into [`run_flash`]. Provides
/// shared write access to the `State::Flashing` mirror (so we can bump
/// `phase` + `log_tail` as we parse stdout) plus a cancellation
/// `Notify` the cancel-flash route fires.
pub struct FlashControl {
    /// Shared updater state — we mutate the `Flashing` variant in place
    /// to keep `version` / `hex_path` / `started_at` intact while
    /// bumping `phase` and pushing into `log_tail`.
    pub state: Arc<Mutex<State>>,
    /// Fired by `POST /api/firmware/cancel_flash`. We treat it as a
    /// kill-switch: kill the subprocess immediately and return
    /// `FlashError::Cancelled` so the orchestrator can transition to
    /// `Failed { error: "user_cancelled", ... }`.
    pub cancel: Arc<Notify>,
}

/// Mutate the shared `State::Flashing` variant. Silently ignored if the
/// state has already transitioned away (e.g. cancellation raced the
/// final exit) — the orchestrator owns terminal transitions.
async fn with_flashing<F>(state: &Arc<Mutex<State>>, mut f: F)
where
    F: FnMut(&mut FlashPhase, &mut Vec<String>),
{
    let mut g = state.lock().await;
    if let State::Flashing {
        phase, log_tail, ..
    } = &mut *g
    {
        f(phase, log_tail);
    }
}

/// Push a line into the log_tail, dropping the oldest if we're at the cap.
fn push_log(log: &mut Vec<String>, line: String) {
    if log.len() >= LOG_TAIL_CAP {
        log.remove(0);
    }
    log.push(line);
}

/// Pattern-match a stdout/stderr line and return the new phase, if it
/// represents a transition. Returns `None` for "no change" so the caller
/// only takes the state lock when needed.
fn classify(line: &str) -> Option<FlashPhase> {
    if line.contains(PAT_WAITING) {
        Some(FlashPhase::WaitingForDevice)
    } else if line.contains(PAT_FOUND) {
        Some(FlashPhase::Programming)
    } else if line.contains(PAT_BOOTING) {
        Some(FlashPhase::Booting)
    } else {
        None
    }
}

/// Run a single flash attempt. Blocks (asynchronously) until the
/// loader process exits OR cancel is signalled OR we hit the
/// wait-for-device timeout. Stdout / stderr lines are forwarded to
/// `tracing` so they show up in the `/logs/stream` feed for the UI's
/// Logs page in real time, AND mirrored into the shared `State::Flashing`
/// `log_tail` so the stepper modal can render recent output inline.
///
/// Returns `Ok(())` on exit code 0, the appropriate [`FlashError`]
/// otherwise. The caller is responsible for state transitions and for
/// ensuring only one flash runs at a time — see
/// [`super::FirmwareUpdater::start_flash`].
pub async fn run_flash(
    loader: &Path,
    mcu: &str,
    hex_path: &Path,
    control: FlashControl,
) -> Result<(), FlashError> {
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
    let mut cmd = Command::new(loader);
    cmd.arg(format!("-mmcu={}", mcu))
        .arg("-w")
        .arg("-v")
        .arg(hex_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        // Kill the child if the FlashControl drop happens before we
        // explicitly wait — defensive; the normal path explicitly
        // kills on cancel/timeout below.
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| FlashError::Spawn(e.to_string()))?;

    // Pump stdout and stderr concurrently so neither pipe can block
    // the other. Both also feed the phase/log_tail mirror.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stdout_state = control.state.clone();
    let stdout_task = tokio::spawn(async move {
        if let Some(out) = stdout {
            let mut reader = BufReader::new(out).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                info!("teensy_loader_cli: {}", line);
                let next_phase = classify(&line);
                let line_clone = line.clone();
                with_flashing(&stdout_state, |phase, log_tail| {
                    push_log(log_tail, line_clone.clone());
                    if let Some(p) = next_phase {
                        if p != *phase {
                            *phase = p;
                        }
                    }
                })
                .await;
            }
        }
    });

    let stderr_state = control.state.clone();
    let stderr_task = tokio::spawn(async move {
        let mut collected = String::new();
        if let Some(err) = stderr {
            let mut reader = BufReader::new(err).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                warn!("teensy_loader_cli: {}", line);
                let next_phase = classify(&line);
                let line_clone = line.clone();
                with_flashing(&stderr_state, |phase, log_tail| {
                    push_log(log_tail, line_clone.clone());
                    if let Some(p) = next_phase {
                        if p != *phase {
                            *phase = p;
                        }
                    }
                })
                .await;
                if collected.len() < 4096 {
                    collected.push_str(&line);
                    collected.push('\n');
                }
            }
        }
        collected
    });

    // Concurrent wait loop: poll for child exit OR cancel signal OR
    // wait-for-device timeout. We need to take a child handle for
    // killing — `Child::id()` plus `start_kill()` together give us a
    // way to kill without consuming `child`.
    let outcome = wait_with_supervision(&mut child, &control).await;

    // Make sure the process is gone before we drain the pumps. If
    // wait_with_supervision returned an error, the child may still
    // be alive (we asked for a kill but didn't await it).
    let _ = child.kill().await;

    // Drain pump tasks so we don't leave them dangling.
    let _ = stdout_task.await;
    let stderr_buf = stderr_task.await.unwrap_or_default();

    match outcome {
        Ok(status) => {
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
        Err(e) => Err(e),
    }
}

/// Wait for the child to exit, but also honour the cancel signal AND
/// the wait-for-device timeout. The timeout only fires while we're
/// still in `WaitingForDevice` — once we transition to Programming /
/// Booting, programming is fast (~1.5s) and uninterruptible, so we
/// just wait for natural exit.
async fn wait_with_supervision(
    child: &mut tokio::process::Child,
    control: &FlashControl,
) -> Result<std::process::ExitStatus, FlashError> {
    let start = Instant::now();
    loop {
        // Check the current phase to decide whether the wait-for-device
        // timeout is in play. We re-read each iteration so a late
        // transition cancels the timeout cleanly.
        let in_wait_phase = matches!(
            *control.state.lock().await,
            State::Flashing {
                phase: FlashPhase::Starting | FlashPhase::WaitingForDevice,
                ..
            }
        );

        // Compute remaining time on the wait-for-device window. Once
        // we're past the wait phase we drop the timeout entirely.
        let remaining = if in_wait_phase {
            WAIT_FOR_DEVICE_TIMEOUT.checked_sub(start.elapsed())
        } else {
            None
        };

        // Select between: cancel signal, child exit, or the
        // wait-for-device deadline (when applicable).
        tokio::select! {
            biased;

            // Cancel: signalled by the cancel-flash route. Kill the
            // child and report Cancelled.
            _ = control.cancel.notified() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(FlashError::Cancelled);
            }

            // Wait-for-device timeout: only armed while we're still in
            // the wait phase. If it fires, kill and report.
            _ = async {
                match remaining {
                    Some(d) => tokio::time::sleep(d).await,
                    // Park forever — the other branches will resolve.
                    None => std::future::pending::<()>().await,
                }
            } => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(FlashError::WaitForDeviceTimeout);
            }

            // Periodic wake to re-evaluate `in_wait_phase` if it
            // changes (Programming starts mid-flight). 250ms is fast
            // enough not to extend the timeout meaningfully and slow
            // enough not to burn CPU.
            _ = tokio::time::sleep(Duration::from_millis(250)) => {
                // try_wait avoids blocking; if the process exited we
                // fall through to the exit-detection arm below.
                if let Ok(Some(status)) = child.try_wait() {
                    return Ok(status);
                }
                continue;
            }
        }
    }
}

/// Light wrapper preserved for callers / tests that don't care about
/// supervision (e.g. the existing flash_validate tests). Used to be
/// the public surface — kept for backwards compatibility within the
/// module's own test suite.
#[cfg(test)]
async fn run_flash_unsupervised(
    loader: &Path,
    mcu: &str,
    hex_path: &Path,
) -> Result<(), FlashError> {
    let state = Arc::new(Mutex::new(State::Flashing {
        version: "test".to_string(),
        hex_path: hex_path.to_string_lossy().to_string(),
        started_at: "0".to_string(),
        phase: FlashPhase::Starting,
        log_tail: Vec::new(),
    }));
    let cancel = Arc::new(Notify::new());
    let control = FlashControl {
        state,
        cancel,
    };
    let _ = tokio::time::timeout(
        Duration::from_secs(5),
        run_flash(loader, mcu, hex_path, control),
    )
    .await;
    Ok(())
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
    fn classify_recognises_waiting_line() {
        assert_eq!(
            classify("Waiting for Teensy device..."),
            Some(FlashPhase::WaitingForDevice)
        );
    }

    #[test]
    fn classify_recognises_found_line() {
        assert_eq!(
            classify("Found HalfKay Bootloader"),
            Some(FlashPhase::Programming)
        );
    }

    #[test]
    fn classify_recognises_booting_line() {
        assert_eq!(classify("Booting"), Some(FlashPhase::Booting));
    }

    #[test]
    fn classify_ignores_unrelated_lines() {
        assert!(classify("Programming...............").is_none());
        assert!(classify("Teensy Loader, Command Line, Version 2.3").is_none());
        assert!(classify("").is_none());
    }

    #[test]
    fn push_log_caps_at_limit() {
        let mut log = Vec::new();
        for i in 0..(LOG_TAIL_CAP + 5) {
            push_log(&mut log, format!("line {}", i));
        }
        assert_eq!(log.len(), LOG_TAIL_CAP);
        // Oldest dropped: we kept the last LOG_TAIL_CAP entries.
        assert_eq!(log.first().unwrap(), &format!("line {}", 5));
        assert_eq!(
            log.last().unwrap(),
            &format!("line {}", LOG_TAIL_CAP + 5 - 1)
        );
    }

    // Smoke: exercise the unsupervised wrapper compiles + can be
    // called without a real loader binary (it errors on spawn, which
    // is fine — we're checking the supervision plumbing compiles).
    #[tokio::test]
    async fn run_flash_unsupervised_smoke() {
        let p = std::env::temp_dir().join("sc-flash-smoke.hex");
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(b":00000001FF\n").unwrap();
        let loader = std::env::temp_dir().join("does-not-exist-loader.exe");
        let _ = run_flash_unsupervised(&loader, "imxrt1062", &p).await;
        let _ = std::fs::remove_file(&p);
    }
}
