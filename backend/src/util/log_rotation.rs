//! Background quota janitor for the daily-rotating file logger.
//!
//! [`spawn_quota_enforcer`] kicks off a long-lived thread that walks
//! `<logs_dir>/streamcheats*.log` every hour, sums the file sizes, and trims
//! the oldest by mtime until the total fits under [`QUOTA_BYTES`]. The
//! current day's file is always preserved — if it alone exceeds the
//! quota we log a warning rather than truncate live logs.
//!
//! The 1 GiB cap is intentionally hardcoded (see [`QUOTA_BYTES`]). The
//! janitor is only spawned when `enable_file_logging` is true, so when
//! the feature is off this module is dead weight at runtime.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

use tracing::{info, warn};

/// 1 GiB total cap across all `streamcheats*.log` files in the logs dir.
/// Intentionally NOT user-configurable — the spec calls for a single
/// hardcoded ceiling so on-disk growth is predictable across installs.
pub const QUOTA_BYTES: u64 = 1024 * 1024 * 1024;

/// How often the janitor wakes up to recheck disk usage. The sweep is
/// cheap (one `read_dir` + per-file `metadata`) so an hour is plenty.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Mirror of `main::interruptible_sleep`. Duplicated rather than
/// extracted so this module stays self-contained — `main` already has
/// its own copy and we don't want to plumb a new shared util just for
/// one helper.
fn interruptible_sleep(total: Duration, running: &Arc<AtomicBool>) -> bool {
    let deadline = Instant::now() + total;
    while running.load(Ordering::SeqCst) {
        let now = Instant::now();
        if now >= deadline {
            return true;
        }
        thread::sleep((deadline - now).min(Duration::from_millis(100)));
    }
    false
}

/// Spawn the janitor thread. Returns its [`JoinHandle`] so `main` can
/// join it during graceful shutdown.
///
/// The thread runs one sweep immediately on start (catches stale files
/// from previous runs), then loops on [`SWEEP_INTERVAL`] until
/// `running` flips to `false`.
pub fn spawn_quota_enforcer(
    logs_dir: PathBuf,
    running: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        sweep(&logs_dir);
        while running.load(Ordering::SeqCst) {
            if !interruptible_sleep(SWEEP_INTERVAL, &running) {
                break;
            }
            sweep(&logs_dir);
        }
    })
}

/// One iteration of the quota check.
///
/// Enumerates every `streamcheats*.log` in `logs_dir`, sums sizes, and if the
/// total exceeds [`QUOTA_BYTES`] deletes the oldest entries by mtime
/// until the remainder fits. The newest file is always retained — the
/// daily rolling appender writes to the most-recently-modified file,
/// so skipping it guarantees we never delete the log we're currently
/// appending to.
fn sweep(logs_dir: &Path) {
    let mut entries = match collect_log_files(logs_dir) {
        Ok(v) => v,
        Err(e) => {
            warn!(
                "log rotation: could not enumerate {}: {}",
                logs_dir.display(),
                e
            );
            return;
        }
    };

    let total: u64 = entries.iter().map(|e| e.size).sum();
    if total <= QUOTA_BYTES {
        return;
    }

    // Newest mtime last; we never touch the last element (today's file).
    entries.sort_by_key(|e| e.mtime);

    if entries.len() < 2 {
        // Only one file and it's over quota by itself. The spec says
        // we must not delete the current day's file even in this case
        // — surface a warning so the operator notices.
        warn!(
            "log rotation: today's log file alone exceeds the 1 GiB quota \
             (size={} MiB) — leaving it untouched",
            total / (1024 * 1024)
        );
        return;
    }

    let mut remaining = total;
    // Drop the newest off the end so it's exempt from deletion, then
    // walk the rest oldest-first.
    let newest = entries.pop().expect("len >= 2 checked above");
    for entry in entries {
        if remaining <= QUOTA_BYTES {
            break;
        }
        match fs::remove_file(&entry.path) {
            Ok(()) => {
                info!(
                    "log rotation: deleted {} (freed {} MiB)",
                    entry.path.display(),
                    entry.size / (1024 * 1024)
                );
                remaining = remaining.saturating_sub(entry.size);
            }
            Err(e) => {
                warn!(
                    "log rotation: could not delete {}: {}",
                    entry.path.display(),
                    e
                );
            }
        }
    }

    if remaining > QUOTA_BYTES {
        // Everything but today's file is gone and we're still over.
        // Same warning path as the single-file case — log and move on.
        warn!(
            "log rotation: even after pruning, today's log file ({}) puts \
             total at {} MiB — quota is 1 GiB",
            newest.path.display(),
            remaining / (1024 * 1024)
        );
    }
}

struct LogEntry {
    path: PathBuf,
    size: u64,
    mtime: SystemTime,
}

fn collect_log_files(logs_dir: &Path) -> std::io::Result<Vec<LogEntry>> {
    let mut out = Vec::new();
    let rd = match fs::read_dir(logs_dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e),
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if !is_streamcheats_log(&path) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        out.push(LogEntry {
            path,
            size: meta.len(),
            mtime,
        });
    }
    Ok(out)
}

/// True for files matching `streamcheats*.log`. We match on filename only so
/// rogue files (e.g. `streamcheats.log.swp`) don't get swept.
fn is_streamcheats_log(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    name.starts_with("streamcheats") && name.ends_with(".log")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_streamcheats_log_filters_correctly() {
        assert!(is_streamcheats_log(Path::new("streamcheats.2025-01-01.log")));
        assert!(is_streamcheats_log(Path::new("/tmp/streamcheats.log")));
        assert!(is_streamcheats_log(Path::new("streamcheats-2025-01-01.log")));
        assert!(!is_streamcheats_log(Path::new("other.log")));
        assert!(!is_streamcheats_log(Path::new("streamcheats.log.bak")));
        assert!(!is_streamcheats_log(Path::new("streamcheats.2025-01-01.log.swp")));
    }
}
