//! Firmware asset filename parser.
//!
//! Teensy firmware release assets follow:
//!
//! * Stable: `streamcheats_<board>_rel-<MAJOR>.<MINOR>.hex`
//!   e.g. `streamcheats_teensy-4.1_rel-5.17.hex`
//! * Nightly: `streamcheats_<board>_rel-<MAJOR>.<MINOR>-<commit>.hex`
//!   e.g. `streamcheats_teensy-4.1_rel-5.17-ca8298b.hex`
//!
//! Version is MAJOR.MINOR only — there is no patch component. Nightly
//! is distinguished from stable purely by the `-<7-char hex commit>`
//! suffix after the version. The `board` segment is read straight from
//! the filename so future boards land without code changes.

use std::fmt;

/// Parsed components of a firmware asset filename.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFilename {
    /// Board identifier as it appears in the filename (e.g.
    /// `teensy-4.1`). The daemon does not interpret this — it's surfaced
    /// to the UI verbatim so future boards work without code edits.
    pub board: String,
    /// `MAJOR.MINOR` version pair.
    pub version: FirmwareVersion,
    /// `Stable` when no commit suffix; `Nightly` when present.
    pub channel: FirmwareChannel,
    /// 7-char commit SHA for nightlies; `None` for stable.
    pub commit: Option<String>,
}

impl ParsedFilename {
    /// Display form for the UI / API responses — the part of the
    /// filename users see ("rel-5.17" or "rel-5.17-ca8298b").
    pub fn display_version(&self) -> String {
        match &self.commit {
            Some(c) => format!("rel-{}-{}", self.version, c),
            None => format!("rel-{}", self.version),
        }
    }
}

/// MAJOR.MINOR firmware version. Patch-less by design — the firmware
/// repo only versions on those two axes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FirmwareVersion {
    pub major: u32,
    pub minor: u32,
}

impl fmt::Display for FirmwareVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.major, self.minor)
    }
}

impl FirmwareVersion {
    /// Parse a bare `MAJOR.MINOR` string (no `rel-` prefix).
    pub fn parse(s: &str) -> Option<Self> {
        let (maj, min) = s.split_once('.')?;
        let major: u32 = maj.parse().ok()?;
        let minor: u32 = min.parse().ok()?;
        Some(Self { major, minor })
    }
}

/// Firmware release channel. Mirrors the software updater's two-channel
/// model so the UI can use one mental model across both surfaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirmwareChannel {
    Stable,
    Nightly,
}

impl FirmwareChannel {
    /// Lowercase wire form for JSON responses.
    pub fn as_str(self) -> &'static str {
        match self {
            FirmwareChannel::Stable => "stable",
            FirmwareChannel::Nightly => "nightly",
        }
    }
}

/// Try to parse a firmware asset filename. Returns `None` for any name
/// that doesn't conform — those are filtered out by the orchestrator
/// rather than surfaced as an error, on the assumption that release
/// assets may include checksum files, source archives, etc. that just
/// aren't of interest to the updater.
pub fn parse(filename: &str) -> Option<ParsedFilename> {
    // Strip extension. Anything that isn't `.hex` (case-insensitive)
    // is not a firmware image.
    let stem = strip_hex_ext(filename)?;

    // Expect: streamcheats_<board>_rel-<rest>
    let after_prefix = stem.strip_prefix("streamcheats_")?;
    // Split on `_rel-` because the board itself contains a hyphen
    // (`teensy-4.1`), so we can't naively split on `_` or `-`.
    let (board, version_part) = after_prefix.split_once("_rel-")?;
    if board.is_empty() || version_part.is_empty() {
        return None;
    }

    // version_part is either `MAJOR.MINOR` or `MAJOR.MINOR-<commit>`.
    let (version_str, commit) = match version_part.split_once('-') {
        Some((v, c)) if is_short_sha(c) => (v, Some(c.to_lowercase())),
        Some(_) => return None, // suffix present but not a valid short SHA
        None => (version_part, None),
    };

    let version = FirmwareVersion::parse(version_str)?;
    let channel = if commit.is_some() {
        FirmwareChannel::Nightly
    } else {
        FirmwareChannel::Stable
    };

    Some(ParsedFilename {
        board: board.to_string(),
        version,
        channel,
        commit,
    })
}

/// Case-insensitive `.hex` suffix strip. Returns the stem on match.
fn strip_hex_ext(filename: &str) -> Option<&str> {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".hex") {
        Some(&filename[..filename.len() - 4])
    } else {
        None
    }
}

/// Validate a git short SHA — exactly 7 lowercase hex characters. The
/// firmware repo standardises on 7 chars so anything else is treated as
/// a malformed filename rather than a strange-but-valid nightly.
fn is_short_sha(s: &str) -> bool {
    s.len() == 7 && s.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stable_teensy_4_1() {
        let p = parse("streamcheats_teensy-4.1_rel-5.17.hex").unwrap();
        assert_eq!(p.board, "teensy-4.1");
        assert_eq!(
            p.version,
            FirmwareVersion {
                major: 5,
                minor: 17
            }
        );
        assert_eq!(p.channel, FirmwareChannel::Stable);
        assert!(p.commit.is_none());
        assert_eq!(p.display_version(), "rel-5.17");
    }

    #[test]
    fn parses_nightly_teensy_4_1() {
        let p = parse("streamcheats_teensy-4.1_rel-5.17-ca8298b.hex").unwrap();
        assert_eq!(p.board, "teensy-4.1");
        assert_eq!(
            p.version,
            FirmwareVersion {
                major: 5,
                minor: 17
            }
        );
        assert_eq!(p.channel, FirmwareChannel::Nightly);
        assert_eq!(p.commit.as_deref(), Some("ca8298b"));
        assert_eq!(p.display_version(), "rel-5.17-ca8298b");
    }

    #[test]
    fn parses_future_board_without_code_change() {
        // The parser must not hard-code `teensy-4.1`. A hypothetical
        // future board lands cleanly.
        let p = parse("streamcheats_teensy-4.0_rel-6.0.hex").unwrap();
        assert_eq!(p.board, "teensy-4.0");
        assert_eq!(p.version, FirmwareVersion { major: 6, minor: 0 });
    }

    #[test]
    fn case_insensitive_extension() {
        assert!(parse("streamcheats_teensy-4.1_rel-5.17.HEX").is_some());
    }

    #[test]
    fn rejects_non_hex_extension() {
        assert!(parse("streamcheats_teensy-4.1_rel-5.17.zip").is_none());
        assert!(parse("checksums.txt").is_none());
    }

    #[test]
    fn rejects_missing_prefix() {
        assert!(parse("teensy-4.1_rel-5.17.hex").is_none());
    }

    #[test]
    fn rejects_missing_rel_segment() {
        assert!(parse("streamcheats_teensy-4.1_5.17.hex").is_none());
    }

    #[test]
    fn rejects_bad_version_numbers() {
        assert!(parse("streamcheats_teensy-4.1_rel-foo.bar.hex").is_none());
        assert!(parse("streamcheats_teensy-4.1_rel-5.hex").is_none());
    }

    #[test]
    fn rejects_bad_commit_suffix() {
        // Not 7 chars
        assert!(parse("streamcheats_teensy-4.1_rel-5.17-abc.hex").is_none());
        // Not hex
        assert!(parse("streamcheats_teensy-4.1_rel-5.17-zzzzzzz.hex").is_none());
    }

    #[test]
    fn version_ordering_is_natural() {
        let a = FirmwareVersion {
            major: 5,
            minor: 17,
        };
        let b = FirmwareVersion {
            major: 5,
            minor: 18,
        };
        let c = FirmwareVersion { major: 6, minor: 0 };
        assert!(a < b);
        assert!(b < c);
    }
}
