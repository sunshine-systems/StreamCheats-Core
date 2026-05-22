//! GitHub Releases API client.
//!
//! Fetches `/repos/<owner>/<repo>/releases`, deserialises just enough of
//! each release to drive the updater (tag, html_url, assets) and hands
//! the list back to the orchestrator. Unauthenticated — GitHub allows
//! 60 req/hr per IP for anonymous polling, which is plenty for our
//! ~4 calls/day cadence. On 403 the caller falls back to whatever it
//! last cached.
//!
//! A `User-Agent` header is set on every request — GitHub rejects
//! anonymous calls without one with HTTP 403.

use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::Deserialize;

/// GitHub API base for the StreamCheats Core repo. Hardcoded — the
/// updater only ever points at this one repo. Keep the path components
/// separate from the host so the host can be swapped in tests with a
/// mock server URL.
pub const RELEASES_PATH: &str = "/repos/sunshine-systems/streamcheats-core/releases";
pub const DEFAULT_API_BASE: &str = "https://api.github.com";

/// Connection + read timeout. GitHub's responses are tiny and fast;
/// the user-facing "check for updates" button feels broken if we hang
/// for the full 30 s reqwest default.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Minimal projection of the GitHub release object. We only deserialise
/// the fields the updater actually reads; serde silently drops the
/// rest, so future API additions don't break the parser.
#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub tag_name: String,
    /// Human-friendly release name; kept on the struct so future
    /// "what's new" UX can surface it but currently unused.
    #[allow(dead_code)]
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub html_url: Option<String>,
    /// GitHub's `prerelease` flag. The updater filters on the parsed
    /// semver pre-release tag instead (so a stable tag accidentally
    /// marked pre-release on the GH side still goes to the stable
    /// channel and vice-versa), but we keep this field so the JSON
    /// projection round-trips faithfully and future debug surfaces
    /// can show it.
    #[allow(dead_code)]
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub assets: Vec<Asset>,
}

/// A single asset attached to a release. `browser_download_url` is the
/// CDN-fronted URL we hand to the downloader; the rest is metadata.
#[derive(Debug, Clone, Deserialize)]
pub struct Asset {
    pub name: String,
    pub browser_download_url: String,
    #[serde(default)]
    pub size: u64,
}

/// Fetch the most recent ~30 releases (GitHub's default page size).
/// Returns the deserialised list on success.
pub async fn fetch_releases(client: &reqwest::Client, api_base: &str) -> Result<Vec<Release>> {
    let url = format!("{}{}", api_base.trim_end_matches('/'), RELEASES_PATH);
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

/// Build a reqwest client with the User-Agent header GitHub requires.
/// Centralised so download.rs and github.rs share the same identity.
pub fn build_client(user_agent: &str) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(user_agent)
        .build()
        .map_err(|e| anyhow!("could not build reqwest client: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_deserialises_with_minimal_fields() {
        let json = r#"{
            "tag_name": "v0.6.3",
            "name": "v0.6.3",
            "html_url": "https://github.com/sunshine-systems/streamcheats-core/releases/tag/v0.6.3",
            "prerelease": false,
            "draft": false,
            "assets": [
                {
                    "name": "StreamCheats Core Setup 0.6.3.exe",
                    "browser_download_url": "https://example.invalid/setup.exe",
                    "size": 12345
                }
            ]
        }"#;
        let r: Release = serde_json::from_str(json).unwrap();
        assert_eq!(r.tag_name, "v0.6.3");
        assert!(!r.prerelease);
        assert_eq!(r.assets.len(), 1);
        assert_eq!(r.assets[0].size, 12345);
    }

    #[test]
    fn release_tolerates_missing_optional_fields() {
        let json = r#"{"tag_name": "v0.6.3"}"#;
        let r: Release = serde_json::from_str(json).unwrap();
        assert_eq!(r.tag_name, "v0.6.3");
        assert!(r.assets.is_empty());
        assert!(r.html_url.is_none());
    }
}
