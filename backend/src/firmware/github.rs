//! Firmware GitHub Releases client.
//!
//! Same shape as [`crate::updater::github`] but pointed at a configurable
//! firmware repo (defaults to `sunshine-systems/Firmware-Teensy-4.1`).
//! Each release's assets are run through [`super::filename::parse`];
//! releases with no firmware asset at all are skipped by the
//! orchestrator, but the raw release set returned here is preserved so
//! downstream filtering can be specific about *why* a release was
//! dropped.

use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::Deserialize;

/// Default GitHub API base. Overridable in tests via [`fetch_releases`]'s
/// `api_base` arg so wiremock can stand in.
pub const DEFAULT_API_BASE: &str = "https://api.github.com";

/// Connection + read timeout. Matches the software updater: keeps the
/// "check now" button responsive.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Minimal projection of the GitHub release object — we only deserialise
/// the fields the firmware updater actually reads. Unknown fields are
/// silently dropped by serde so future API additions don't break us.
#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    /// GitHub release tag (e.g. `rel-5.17`). Currently unread by the
    /// orchestrator — the asset filename is the source of truth for
    /// version + channel — but kept on the struct so debug surfaces
    /// can show it.
    #[allow(dead_code)]
    pub tag_name: String,
    #[serde(default)]
    pub html_url: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    /// GitHub's `prerelease` flag. The firmware module ultimately uses
    /// the asset filename's commit suffix to classify channel, not this
    /// flag, but we keep it on the struct so debug surfaces can show it.
    #[allow(dead_code)]
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub assets: Vec<Asset>,
}

/// Single release asset.
#[derive(Debug, Clone, Deserialize)]
pub struct Asset {
    pub name: String,
    pub browser_download_url: String,
    #[serde(default)]
    pub size: u64,
}

/// Fetch the most recent ~30 releases from `<owner>/<repo>`. Returns the
/// deserialised list on HTTP success.
pub async fn fetch_releases(
    client: &reqwest::Client,
    api_base: &str,
    repo: &str,
) -> Result<Vec<Release>> {
    let path = format!("/repos/{}/releases", repo);
    let url = format!("{}{}", api_base.trim_end_matches('/'), path);
    let resp = client
        .get(&url)
        .timeout(REQUEST_TIMEOUT)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!(
            "GitHub releases API returned HTTP {}: {}",
            status,
            body.chars().take(200).collect::<String>()
        ));
    }

    let releases: Vec<Release> = resp.json().await?;
    Ok(releases)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_deserialises_with_minimal_fields() {
        let json = r#"{
            "tag_name": "rel-5.17",
            "html_url": "https://github.com/sunshine-systems/Firmware-Teensy-4.1/releases/tag/rel-5.17",
            "published_at": "2026-05-20T12:00:00Z",
            "prerelease": false,
            "draft": false,
            "assets": [
                {
                    "name": "streamcheats_teensy-4.1_rel-5.17.hex",
                    "browser_download_url": "https://example.invalid/firmware.hex",
                    "size": 524288
                }
            ]
        }"#;
        let r: Release = serde_json::from_str(json).unwrap();
        assert_eq!(r.tag_name, "rel-5.17");
        assert_eq!(r.assets.len(), 1);
        assert_eq!(r.assets[0].name, "streamcheats_teensy-4.1_rel-5.17.hex");
    }

    #[test]
    fn release_tolerates_missing_optional_fields() {
        let r: Release = serde_json::from_str(r#"{"tag_name": "rel-5.17"}"#).unwrap();
        assert_eq!(r.tag_name, "rel-5.17");
        assert!(r.assets.is_empty());
        assert!(r.published_at.is_none());
    }
}
