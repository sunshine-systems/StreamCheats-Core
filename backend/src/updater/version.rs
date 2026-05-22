//! Version comparison helpers for the updater.
//!
//! Release tags coming back from GitHub take two shapes:
//!
//! * stable: `vX.Y.Z` — no pre-release tag.
//! * nightly: `vX.Y.Z-nightly.YYYYMMDD[.N]` — pre-release tag starts
//!   with `nightly`.
//!
//! [`Channel::classify`] inspects the parsed [`semver::Version`] and
//! returns whether the version belongs to the stable or experimental
//! (nightly) channel. [`is_newer`] is the single comparison used by
//! [`super::mod`] to decide whether a release should be offered to the
//! user — strict `>` semver, so identical versions never trigger an
//! update prompt.

use semver::Version;

/// Release channel a [`Version`] belongs to. Determined entirely by the
/// pre-release tag — the major/minor/patch numbers don't move the needle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    /// No pre-release tag (or a non-`nightly` one). Eligible for every
    /// user.
    Stable,
    /// Pre-release tag starting with the literal `nightly` (case-
    /// insensitive). Only offered to users who toggled
    /// `experimental_builds`.
    Nightly,
}

impl Channel {
    /// Classify a parsed version. Empty pre-release → stable. Any
    /// pre-release tag whose first segment begins with `nightly` (case-
    /// insensitive) → nightly. Anything else (e.g. `-rc.1`) is treated
    /// as nightly today — we have no other channels yet, so the
    /// conservative call is "don't surface non-stable pre-releases to
    /// users who didn't opt in."
    pub fn classify(v: &Version) -> Channel {
        if v.pre.is_empty() {
            Channel::Stable
        } else {
            Channel::Nightly
        }
    }
}

/// Strip a leading `v`/`V` from a tag string so `semver::Version::parse`
/// accepts it. GitHub release tags are `vX.Y.Z` by convention but the
/// semver crate insists on the bare form.
pub fn strip_v_prefix(tag: &str) -> &str {
    tag.strip_prefix('v')
        .or_else(|| tag.strip_prefix('V'))
        .unwrap_or(tag)
}

/// Parse a `vX.Y.Z[-pre]` string into a [`Version`]. Returns the
/// underlying semver error verbatim so the caller can surface it to the
/// user.
pub fn parse_tag(tag: &str) -> Result<Version, semver::Error> {
    Version::parse(strip_v_prefix(tag))
}

/// Returns `true` iff `candidate` is strictly newer than `installed`.
/// Equal versions return `false` — we never offer a downgrade or a
/// reinstall.
pub fn is_newer(candidate: &Version, installed: &Version) -> bool {
    candidate > installed
}

/// Filter helper: should this `candidate` be offered to a user whose
/// `experimental_builds` setting is `experimental`? Stable versions
/// are always eligible; nightlies are only eligible when the toggle is on.
pub fn channel_allowed(candidate: &Version, experimental: bool) -> bool {
    match Channel::classify(candidate) {
        Channel::Stable => true,
        Channel::Nightly => experimental,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_prefix_handles_v_and_bare() {
        assert_eq!(strip_v_prefix("v1.2.3"), "1.2.3");
        assert_eq!(strip_v_prefix("V1.2.3"), "1.2.3");
        assert_eq!(strip_v_prefix("1.2.3"), "1.2.3");
    }

    #[test]
    fn parses_stable_tag() {
        let v = parse_tag("v0.6.2").unwrap();
        assert_eq!(v.major, 0);
        assert_eq!(v.minor, 6);
        assert_eq!(v.patch, 2);
        assert!(v.pre.is_empty());
        assert_eq!(Channel::classify(&v), Channel::Stable);
    }

    #[test]
    fn parses_nightly_tag() {
        let v = parse_tag("v0.7.0-nightly.20260522").unwrap();
        assert_eq!(v.major, 0);
        assert_eq!(v.minor, 7);
        assert_eq!(v.patch, 0);
        assert!(!v.pre.is_empty());
        assert_eq!(Channel::classify(&v), Channel::Nightly);
    }

    #[test]
    fn parses_dotted_nightly_tag() {
        let v = parse_tag("v0.7.0-nightly.20260522.3").unwrap();
        assert_eq!(Channel::classify(&v), Channel::Nightly);
    }

    #[test]
    fn newer_basic() {
        let installed = parse_tag("v0.6.2").unwrap();
        let cand = parse_tag("v0.6.3").unwrap();
        assert!(is_newer(&cand, &installed));
        assert!(!is_newer(&installed, &cand));
        assert!(!is_newer(&installed, &installed));
    }

    #[test]
    fn nightly_compares_against_stable_per_semver() {
        // Per semver, a pre-release of a higher base version is
        // considered *less* than the corresponding stable release at the
        // SAME base version (`0.7.0-nightly.*` < `0.7.0`) but greater
        // than the previous stable (`0.7.0-nightly.*` > `0.6.99`).
        // That matches user intent: a 0.7.0 nightly should still be
        // offered to a 0.6.2 user when they've opted in.
        let installed = parse_tag("v0.6.2").unwrap();
        let nightly = parse_tag("v0.7.0-nightly.20260522").unwrap();
        assert!(is_newer(&nightly, &installed));

        let stable_070 = parse_tag("v0.7.0").unwrap();
        assert!(is_newer(&stable_070, &nightly));
    }

    #[test]
    fn channel_filter_excludes_nightly_when_off() {
        let nightly = parse_tag("v0.7.0-nightly.20260522").unwrap();
        let stable = parse_tag("v0.7.0").unwrap();

        assert!(!channel_allowed(&nightly, false));
        assert!(channel_allowed(&nightly, true));
        assert!(channel_allowed(&stable, false));
        assert!(channel_allowed(&stable, true));
    }

    #[test]
    fn channel_filter_picks_highest_eligible() {
        // Simulating the "pick newest version the user is eligible for"
        // loop the orchestrator runs after pulling /releases.
        let installed = parse_tag("v0.6.2").unwrap();
        let candidates = ["v0.6.3", "v0.7.0-nightly.20260601", "v0.7.0-nightly.20260522"]
            .iter()
            .map(|t| parse_tag(t).unwrap())
            .collect::<Vec<_>>();

        // Stable-only: highest eligible is v0.6.3.
        let best_stable = candidates
            .iter()
            .filter(|v| channel_allowed(v, false))
            .max()
            .unwrap();
        assert_eq!(best_stable.to_string(), "0.6.3");
        assert!(is_newer(best_stable, &installed));

        // Experimental: highest eligible is the newer nightly.
        let best_exp = candidates
            .iter()
            .filter(|v| channel_allowed(v, true))
            .max()
            .unwrap();
        assert_eq!(best_exp.to_string(), "0.7.0-nightly.20260601");
    }
}
