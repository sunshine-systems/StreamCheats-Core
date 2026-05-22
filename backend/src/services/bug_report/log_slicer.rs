//! Tail the most recent ~5 minutes of the daily log file(s).
//!
//! `tracing-appender`'s default fmt prefixes every line with an ISO-8601
//! timestamp such as `2026-05-20T20:45:01.234567Z` AND names files by
//! the same UTC day boundary (`streamcheats.YYYY-MM-DD.log`). Both ends are
//! UTC, so this slicer is UTC throughout.
//!
//! Lines whose leading token is *not* a parseable timestamp (multi-line
//! spans, panic backtraces, etc.) are treated as continuations of the
//! prior line and included iff that prior line was included.
//!
//! Today's and yesterday's files (by UTC) are read because the 5-minute
//! window can straddle midnight; older files are never relevant.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, NaiveDate, Utc};

/// Width of the slice window.
pub const WINDOW: Duration = Duration::minutes(5);

/// Build the concatenated tail-slice bytes. Returns an empty Vec when
/// the log dir has no usable files (fresh install, file-logging just
/// enabled, etc.) — that's not an error; the consumer just sees an
/// empty `<pkg>_logs_last5min.log` entry (the orchestrator names it
/// from `env!("CARGO_PKG_NAME")` — see `mod.rs::build_bundle`).
///
/// `now` is the UTC instant the bug-report was requested. Using UTC
/// matches `tracing-appender`'s filename + per-line timestamp scheme
/// (both UTC by default in 0.2.x).
pub fn slice_last_window(logs_dir: &Path, now: DateTime<Utc>) -> std::io::Result<Vec<u8>> {
    let cutoff = now - WINDOW;
    let today = now.date_naive();
    let yesterday = today.pred_opt().unwrap_or(today);

    let mut out: Vec<u8> = Vec::with_capacity(8 * 1024);

    // Yesterday only if the window crosses midnight. The naive way
    // (always read it) wastes I/O during the 23h55m of the day where
    // it can't possibly contribute lines.
    if cutoff.date_naive() < today {
        if let Some(path) = log_path_for(logs_dir, yesterday) {
            append_window(&path, &cutoff, &mut out)?;
        }
    }

    if let Some(path) = log_path_for(logs_dir, today) {
        append_window(&path, &cutoff, &mut out)?;
    }

    Ok(out)
}

/// Build `<logs_dir>/streamcheats.YYYY-MM-DD.log` if the file exists; `None`
/// otherwise.
fn log_path_for(logs_dir: &Path, date: NaiveDate) -> Option<PathBuf> {
    let name = format!("streamcheats.{}.log", date.format("%Y-%m-%d"));
    let p = logs_dir.join(name);
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

/// Append every line of `path` whose leading timestamp >= `cutoff` to
/// `out`. Lines with no parseable leading timestamp inherit the
/// inclusion decision of the prior line (which preserves multi-line
/// spans and panic backtraces).
fn append_window(
    path: &Path,
    cutoff: &DateTime<Utc>,
    out: &mut Vec<u8>,
) -> std::io::Result<()> {
    let raw = fs::read(path)?;
    let text = String::from_utf8_lossy(&raw);
    let mut prev_included = false;
    for line in text.split_inclusive('\n') {
        // Defense-in-depth: strip ANSI escapes. The file appender is
        // configured with `.with_ansi(false)` so this is a no-op in
        // practice — but a corrupt-on-disk file or future config
        // change shouldn't poison the bug report.
        let stripped = strip_ansi(line);
        let included = match parse_leading_timestamp(&stripped) {
            Some(ts) => ts >= *cutoff,
            None => prev_included,
        };
        if included {
            out.extend_from_slice(stripped.as_bytes());
        }
        prev_included = included;
    }
    Ok(())
}

/// Parse the leading whitespace-terminated token as an RFC-3339 / ISO
/// timestamp and return it in UTC. Returns `None` if the token isn't a
/// timestamp.
fn parse_leading_timestamp(line: &str) -> Option<DateTime<Utc>> {
    let token = line.split_ascii_whitespace().next()?;
    // The appender's default form has the `Z` suffix.
    if let Ok(utc) = DateTime::parse_from_rfc3339(token) {
        return Some(utc.with_timezone(&Utc));
    }
    // Fallback: `YYYY-MM-DDTHH:MM:SS.ffffff` with no zone suffix —
    // treat as UTC to stay consistent with the appender default.
    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(token, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(chrono::TimeZone::from_utc_datetime(&Utc, &naive));
    }
    None
}

/// Strip CSI ANSI escapes (the `\x1b[...m` family). Other escape
/// classes (OSC, RIS) are not used by tracing-subscriber so we don't
/// bother. Allocates only when an escape is actually found.
fn strip_ansi(s: &str) -> std::borrow::Cow<'_, str> {
    if !s.contains('\x1b') {
        return std::borrow::Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            // Skip until a final byte in 0x40..=0x7E (per ECMA-48).
            i += 2;
            while i < bytes.len() && !(0x40..=0x7E).contains(&bytes[i]) {
                i += 1;
            }
            i += 1; // skip the final byte too
            continue;
        }
        // Safe because we only entered the branch on ASCII 0x1b which is
        // a single byte; otherwise we pass the byte through, but to
        // preserve UTF-8 we need to push as a char. Walk by char_indices
        // for the slow path.
        let rest = std::str::from_utf8(&bytes[i..]).unwrap_or("");
        if let Some(c) = rest.chars().next() {
            out.push(c);
            i += c.len_utf8();
        } else {
            break;
        }
    }
    std::borrow::Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::SystemTime;

    fn tmpdir() -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "streamcheats_log_slicer_test_{}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&base).unwrap();
        base
    }

    /// Helper: write a log file for `date` with `body`.
    fn write_log(dir: &Path, date: NaiveDate, body: &str) {
        let p = dir.join(format!("streamcheats.{}.log", date.format("%Y-%m-%d")));
        let mut f = fs::File::create(&p).unwrap();
        f.write_all(body.as_bytes()).unwrap();
    }

    #[test]
    fn returns_empty_when_dir_missing_or_empty() {
        let dir = tmpdir();
        // dir exists but no files
        let out = slice_last_window(&dir, Utc::now()).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn includes_only_lines_in_window() {
        let dir = tmpdir();
        let now = Utc::now();
        let today = now.date_naive();

        let inside = (now - Duration::seconds(60))
            .to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
        let outside = (now - Duration::minutes(10))
            .to_rfc3339_opts(chrono::SecondsFormat::Micros, true);

        let body = format!(
            "{outside} INFO old line\n{inside} INFO recent line\n",
            outside = outside,
            inside = inside,
        );
        write_log(&dir, today, &body);

        let out = slice_last_window(&dir, now).unwrap();
        let s = String::from_utf8_lossy(&out);
        assert!(s.contains("recent line"), "expected recent line in: {s}");
        assert!(!s.contains("old line"), "old line must be excluded: {s}");
    }

    #[test]
    fn continuation_lines_inherit_inclusion() {
        let dir = tmpdir();
        let now = Utc::now();
        let today = now.date_naive();
        let inside = (now - Duration::seconds(30))
            .to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
        let outside = (now - Duration::minutes(15))
            .to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
        let body = format!(
            "{outside} INFO older span\n  continuation of older\n{inside} INFO newer span\n  continuation of newer\n",
            outside = outside,
            inside = inside,
        );
        write_log(&dir, today, &body);
        let out = slice_last_window(&dir, now).unwrap();
        let s = String::from_utf8_lossy(&out);
        assert!(s.contains("newer span"));
        assert!(s.contains("continuation of newer"));
        assert!(!s.contains("older span"));
        assert!(!s.contains("continuation of older"));
    }

    #[test]
    fn strips_ansi_escapes() {
        let s = "\x1b[2m2026-05-20T20:00:00Z\x1b[0m INFO hello\n";
        let stripped = strip_ansi(s);
        assert_eq!(&*stripped, "2026-05-20T20:00:00Z INFO hello\n");
    }

    #[test]
    fn parses_rfc3339_micros() {
        let line = "2026-05-20T20:45:01.234567Z INFO whatever";
        let ts = parse_leading_timestamp(line).expect("must parse");
        assert_eq!(ts.year(), 2026);
    }
}

// Pull these tiny re-exports in only under test so the surface stays
// minimal in release. `chrono::Datelike` is needed for `.year()`.
#[cfg(test)]
use chrono::Datelike;
