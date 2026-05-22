//! Single-instance daemon helpers.
//!
//! The translator is intended to run as a singleton background service
//! discovered by the sibling Electron frontend. To make discovery
//! trivial (and to give the GUI a way to know which UDP port we bound,
//! since `0` is a valid `udp_port` meaning ephemeral) we publish two
//! files in [`std::env::temp_dir`]:
//!
//! * [`PID_FILE_NAME`] — our PID as decimal, no newline.
//! * [`PORT_FILE_NAME`] — the UDP port we successfully bound, no newline.
//!
//! On startup, [`takeover_if_running`] inspects the existing pid file
//! (if any) and — only after confirming the named process really is
//! another instance of this binary via [`sysinfo`] — terminates it and
//! waits for it to exit. Stale or non-matching pid files are silently
//! cleaned up. After binding the UDP socket the caller writes the
//! current PID and port via [`write_pid_and_port`]; on graceful
//! shutdown [`cleanup`] removes both files.
//!
//! Hard-kills (SIGKILL / TerminateProcess from outside) intentionally
//! leave the files behind — the next instance's takeover path treats
//! that as the stale case and proceeds.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System};
use tracing::{debug, error, info, warn};

/// Filename written to [`std::env::temp_dir`] holding our decimal PID.
pub const PID_FILE_NAME: &str = "streamcheats_core.pid";

/// Filename written to [`std::env::temp_dir`] holding our bound UDP port.
pub const PORT_FILE_NAME: &str = "streamcheats_core.port";

/// Filename written to [`std::env::temp_dir`] holding our bound HTTP
/// (bug-report / health) port. Published separately from
/// [`PORT_FILE_NAME`] so the Electron frontend can read the HTTP port
/// without confusing it with the UDP listener.
pub const HTTP_PORT_FILE_NAME: &str = "streamcheats_core.http_port";

/// Substring we require in a process image name before we'll terminate
/// it on takeover. Matches the binary's package name from `Cargo.toml`.
/// On Windows the image name is `streamcheats_core.exe`; on other
/// platforms it's `streamcheats_core`. The substring catches both.
const PROCESS_NAME_NEEDLE: &str = "streamcheats_core";

/// How long to wait for a prior instance to exit after asking it to.
const TAKEOVER_TIMEOUT: Duration = Duration::from_secs(3);

/// Poll cadence while waiting for the prior instance to exit.
const TAKEOVER_POLL: Duration = Duration::from_millis(100);

/// Absolute path of the PID file.
pub fn pid_path() -> PathBuf {
    std::env::temp_dir().join(PID_FILE_NAME)
}

/// Absolute path of the port file.
pub fn port_path() -> PathBuf {
    std::env::temp_dir().join(PORT_FILE_NAME)
}

/// Absolute path of the HTTP-port file.
pub fn http_port_path() -> PathBuf {
    std::env::temp_dir().join(HTTP_PORT_FILE_NAME)
}

/// Outcome bubbled up by [`takeover_if_running`] so the caller can log
/// or exit accordingly.
pub enum TakeoverOutcome {
    /// No prior instance (or only stale files); safe to proceed.
    Clear,
    /// Found a prior instance and successfully terminated it.
    Killed { pid: u32 },
    /// Found a prior instance but it refused to exit within
    /// [`TAKEOVER_TIMEOUT`]. Caller should abort startup rather than
    /// race for the UDP port.
    Stuck { pid: u32 },
}

/// Inspect the pid file in [`std::env::temp_dir`]. If it names a live
/// process whose image matches [`PROCESS_NAME_NEEDLE`], terminate it
/// and wait up to [`TAKEOVER_TIMEOUT`] for it to exit. In every
/// non-stuck outcome the stale pid + port files are removed before
/// returning so the caller starts from a clean slate.
pub fn takeover_if_running() -> TakeoverOutcome {
    let pid_file = pid_path();
    let port_file = port_path();

    let Ok(contents) = fs::read_to_string(&pid_file) else {
        // No pid file (or unreadable). Best-effort cleanup of a
        // possible orphan port file, then we're done.
        let _ = fs::remove_file(&port_file);
        return TakeoverOutcome::Clear;
    };

    let Ok(prev_pid_raw) = contents.trim().parse::<u32>() else {
        warn!(
            "daemon: pid file {} unparseable ({:?}); treating as stale",
            pid_file.display(),
            contents
        );
        let _ = fs::remove_file(&pid_file);
        let _ = fs::remove_file(&port_file);
        let _ = fs::remove_file(&http_port_path());
        return TakeoverOutcome::Clear;
    };

    let prev_pid = Pid::from_u32(prev_pid_raw);

    // Refresh just process metadata — that's all we look at, and it's
    // dramatically cheaper than the full system snapshot.
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[prev_pid]),
        true,
        ProcessRefreshKind::new(),
    );

    let Some(proc) = sys.process(prev_pid) else {
        // PID is dead → stale file. Clean both and proceed.
        debug!(
            "daemon: pid file named {} but no such process; removing stale files",
            prev_pid_raw
        );
        let _ = fs::remove_file(&pid_file);
        let _ = fs::remove_file(&port_file);
        let _ = fs::remove_file(&http_port_path());
        return TakeoverOutcome::Clear;
    };

    // Verify the image name before we kill anything. On Windows
    // `Process::name()` returns just the executable filename (e.g.
    // `streamcheats_core.exe`); doing a substring match catches
    // both the .exe and the bare unix name.
    let name = proc.name().to_string_lossy().to_lowercase();
    if !name.contains(PROCESS_NAME_NEEDLE) {
        warn!(
            "daemon: pid {} is alive but image name {:?} doesn't match {:?}; \
             treating pid file as stale (NOT killing unrelated process)",
            prev_pid_raw, name, PROCESS_NAME_NEEDLE
        );
        let _ = fs::remove_file(&pid_file);
        let _ = fs::remove_file(&port_file);
        let _ = fs::remove_file(&http_port_path());
        return TakeoverOutcome::Clear;
    }

    info!(
        "daemon: prior instance pid={} ({:?}) detected — terminating to take over",
        prev_pid_raw, name
    );
    // sysinfo's Signal::Kill maps to TerminateProcess on Windows and
    // SIGKILL on unix. Return value is `Some(true)` on success.
    let killed_ok = proc.kill_with(Signal::Kill).unwrap_or_else(|| {
        // No `Signal::Kill` mapping (very old kernels). Fall back.
        proc.kill()
    });
    if !killed_ok {
        error!(
            "daemon: TerminateProcess on pid {} returned failure",
            prev_pid_raw
        );
    }

    // Poll until the process is gone or we time out.
    let deadline = Instant::now() + TAKEOVER_TIMEOUT;
    loop {
        thread::sleep(TAKEOVER_POLL);
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[prev_pid]),
            true,
            ProcessRefreshKind::new(),
        );
        if sys.process(prev_pid).is_none() {
            info!("daemon: prior instance pid={} exited", prev_pid_raw);
            let _ = fs::remove_file(&pid_file);
            let _ = fs::remove_file(&port_file);
            let _ = fs::remove_file(&http_port_path());
            return TakeoverOutcome::Killed { pid: prev_pid_raw };
        }
        if Instant::now() >= deadline {
            return TakeoverOutcome::Stuck { pid: prev_pid_raw };
        }
    }
}

/// Atomically (`write to *.tmp` + `rename`) publish the PID and port to
/// the well-known files in [`std::env::temp_dir`]. Called immediately
/// after a successful UDP `bind()` so the published port is real.
pub fn write_pid_and_port(port: u16) -> std::io::Result<()> {
    let pid = std::process::id();
    write_atomic(&pid_path(), pid.to_string().as_bytes())?;
    write_atomic(&port_path(), port.to_string().as_bytes())?;
    Ok(())
}

/// Atomically publish the HTTP port. Called after the axum server has
/// successfully bound a TCP socket and learned the kernel-assigned
/// port via `local_addr()`. Separate from [`write_pid_and_port`] so
/// the two surfaces (UDP and HTTP) can be started independently.
pub fn write_http_port(port: u16) -> std::io::Result<()> {
    write_atomic(&http_port_path(), port.to_string().as_bytes())
}

/// Remove both temp files on graceful shutdown. Errors are logged at
/// debug only — they're expected after a hard kill and irrelevant to
/// the next instance, which re-checks via [`takeover_if_running`].
pub fn cleanup() {
    let pid_file = pid_path();
    let port_file = port_path();
    let http_port_file = http_port_path();
    if let Err(e) = fs::remove_file(&pid_file) {
        debug!(
            "daemon: cleanup remove_file({}) failed: {}",
            pid_file.display(),
            e
        );
    }
    if let Err(e) = fs::remove_file(&port_file) {
        debug!(
            "daemon: cleanup remove_file({}) failed: {}",
            port_file.display(),
            e
        );
    }
    if let Err(e) = fs::remove_file(&http_port_file) {
        debug!(
            "daemon: cleanup remove_file({}) failed: {}",
            http_port_file.display(),
            e
        );
    }
}

/// Write `bytes` to `final_path` atomically: first to a sibling
/// `<final_path>.tmp`, then `rename()` over the target. On Windows
/// `rename` over an existing file is allowed since Rust 1.5 on NTFS;
/// we remove a possible prior tmp file first to be safe in case a
/// crashed previous attempt left one behind.
fn write_atomic(final_path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp_path = final_path.to_path_buf();
    let tmp_name = match final_path.file_name() {
        Some(n) => {
            let mut s = n.to_os_string();
            s.push(".tmp");
            s
        }
        None => return Err(std::io::Error::other("daemon: temp path has no filename")),
    };
    tmp_path.set_file_name(tmp_name);

    // Clean up any leftover tmp from a crashed prior write.
    let _ = fs::remove_file(&tmp_path);

    {
        let mut f = fs::File::create(&tmp_path)?;
        f.write_all(bytes)?;
        f.flush()?;
    }
    fs::rename(&tmp_path, final_path)
}
