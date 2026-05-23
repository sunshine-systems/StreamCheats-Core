//! Teensy firmware update orchestrator.
//!
//! Polls a configurable firmware GitHub repo for releases, classifies
//! each release's `.hex` asset by [`filename::parse`], filters by
//! channel + the user's `experimental_builds` setting, and exposes the
//! result via HTTP routes under `/api/firmware/*`.
//!
//! Mirrors [`crate::updater`] structurally — same `tokio::sync::Mutex<State>`
//! shape, same 6-hour poll cadence, same "leave a previous Available
//! visible if a follow-up check fails" policy. The installed-version
//! input differs: instead of reading the NSIS registry key, we consume
//! [`device::LastHeartbeat`] which the serial reader populates from the
//! firmware's `V: x.xx` reply lines.
//!
//! Flashing is intentionally not implemented here — see SC-13.

pub mod device;
pub mod download;
pub mod filename;
pub mod github;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};

use self::device::{InstalledFirmware, LastHeartbeat};
use self::download::{Downloaded, Progress};
use self::filename::{FirmwareChannel, FirmwareVersion, ParsedFilename};
use self::github::{Asset, Release};

/// Cadence between automatic firmware-release checks. Same 6h pattern
/// as the software updater — well below GitHub's anonymous quota and
/// deliberately "background, non-annoying."
pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Default firmware repo when `config.json` omits `firmware.repo`.
pub const DEFAULT_REPO: &str = "sunshine-systems/Teensy-Core-1.59.0";

/// Public-facing state machine. Serde-tagged so the `/api/firmware/status`
/// JSON shape is `{ "state": { "kind": "...", ... } }`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum State {
    /// No check has run yet.
    Idle,
    /// Last check succeeded — the device is already running the newest
    /// firmware the user is eligible for.
    UpToDate {
        installed: String,
        checked_at: String,
    },
    /// A newer firmware release is available. UI shows a banner with
    /// version + notes link.
    Available {
        installed: Option<String>,
        latest: String,
        channel: &'static str,
        notes_url: Option<String>,
        asset_url: String,
        asset_name: String,
        asset_size: u64,
        checked_at: String,
    },
    /// Download in flight.
    Downloading {
        latest: String,
        bytes_so_far: u64,
        total_bytes: Option<u64>,
        percent: Option<u8>,
    },
    /// Download complete — `.hex` is on disk. Flashing is a future
    /// concern (SC-13).
    Ready {
        latest: String,
        hex_path: String,
        size: u64,
        sha256: String,
    },
    /// Last check or download failed.
    Failed { error: String, when: String },
}

impl Default for State {
    fn default() -> Self {
        State::Idle
    }
}

/// One entry in the `/api/firmware/releases` response list. Built from
/// the union of [`Release`] + [`ParsedFilename`] for the asset we
/// matched.
#[derive(Debug, Clone, Serialize)]
pub struct ReleaseEntry {
    /// Display form, e.g. `rel-5.17` or `rel-5.17-ca8298b`.
    pub version: String,
    pub channel: &'static str,
    /// 7-char commit SHA on nightlies; `None` on stable.
    pub commit: Option<String>,
    pub board: String,
    pub published_at: Option<String>,
    pub asset_url: String,
    pub asset_name: String,
    pub asset_size: u64,
    /// The release's `html_url` so the UI can link to the GitHub
    /// release page for notes.
    pub html_url: Option<String>,
}

/// Cloneable handle to the firmware updater.
#[derive(Clone)]
pub struct FirmwareUpdater {
    pub state: Arc<Mutex<State>>,
    pub releases: Arc<Mutex<Vec<ReleaseEntry>>>,
    pub installed: LastHeartbeat,
    pub experimental: Arc<AtomicBool>,
    pub auto_check: Arc<AtomicBool>,
    pub repo: Arc<Mutex<String>>,
    pub client: reqwest::Client,
    pub api_base: String,
}

impl FirmwareUpdater {
    pub fn new(
        repo: String,
        auto_check_initial: bool,
        experimental_initial: bool,
        installed: LastHeartbeat,
    ) -> Self {
        let ua = format!("streamcheats-core/{}", env!("CARGO_PKG_VERSION"));
        // Reuse the updater module's client builder so the User-Agent
        // shape stays consistent across the two GitHub-polling surfaces.
        let client = match crate::updater::github::build_client(&ua) {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    "firmware: could not build dedicated client ({}); using default",
                    e
                );
                reqwest::Client::new()
            }
        };
        Self {
            state: Arc::new(Mutex::new(State::Idle)),
            releases: Arc::new(Mutex::new(Vec::new())),
            installed,
            experimental: Arc::new(AtomicBool::new(experimental_initial)),
            auto_check: Arc::new(AtomicBool::new(auto_check_initial)),
            repo: Arc::new(Mutex::new(repo)),
            client,
            api_base: github::DEFAULT_API_BASE.to_string(),
        }
    }

    pub async fn snapshot(&self) -> State {
        self.state.lock().await.clone()
    }

    pub async fn releases(&self) -> Vec<ReleaseEntry> {
        self.releases.lock().await.clone()
    }

    pub async fn repo(&self) -> String {
        self.repo.lock().await.clone()
    }

    pub fn experimental(&self) -> bool {
        self.experimental.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn set_experimental(&self, enabled: bool) {
        self.experimental
            .store(enabled, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn auto_check(&self) -> bool {
        self.auto_check.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Run one check cycle: pull releases, parse asset filenames, refresh
    /// the cached releases list, then re-evaluate the state machine.
    pub async fn check_once(&self) {
        let repo = self.repo().await;
        let raw = match github::fetch_releases(&self.client, &self.api_base, &repo).await {
            Ok(r) => r,
            Err(e) => {
                let msg = format!("github fetch failed: {}", e);
                warn!("firmware: {}", msg);
                let current = self.snapshot().await;
                if matches!(
                    current,
                    State::Idle | State::UpToDate { .. } | State::Failed { .. }
                ) {
                    self.set_state(State::Failed {
                        error: msg,
                        when: now_string(),
                    })
                    .await;
                }
                return;
            }
        };

        let experimental = self.experimental();
        let mut entries = build_release_entries(&raw);
        // Newest first by published_at (string sort works for ISO-8601),
        // ties broken by version.
        entries.sort_by(|a, b| {
            b.published_at
                .as_deref()
                .unwrap_or("")
                .cmp(a.published_at.as_deref().unwrap_or(""))
                .then_with(|| b.version.cmp(&a.version))
        });
        {
            let mut g = self.releases.lock().await;
            *g = entries.clone();
        }

        let installed_snap = self.installed.snapshot();
        let installed_version = match installed_snap {
            InstalledFirmware::Known { version, .. } => Some(version),
            InstalledFirmware::Unknown => None,
        };

        let now = now_string();
        let best = pick_best_entry(&entries, experimental);

        match best {
            None => {
                info!(
                    "firmware: no eligible releases (experimental={})",
                    experimental
                );
                self.set_state(State::UpToDate {
                    installed: installed_version
                        .map(|v| format!("rel-{}", v))
                        .unwrap_or_else(|| "unknown".to_string()),
                    checked_at: now,
                })
                .await;
            }
            Some(entry) => {
                let latest_v = parse_entry_version(&entry).map(|p| p.version);
                let up_to_date = match (installed_version, latest_v) {
                    // Stable: if installed major.minor >= latest, we're up to date.
                    (Some(inst), Some(latest)) if entry.channel == "stable" => inst >= latest,
                    // Nightly: we can't distinguish commits — treat any
                    // nightly of the same major.minor as "potentially
                    // installed" per the ticket.
                    (Some(inst), Some(latest)) => inst >= latest,
                    _ => false,
                };

                if up_to_date {
                    info!(
                        "firmware: up to date (installed={:?}, latest={})",
                        installed_version, entry.version
                    );
                    self.set_state(State::UpToDate {
                        installed: installed_version
                            .map(|v| format!("rel-{}", v))
                            .unwrap_or_else(|| "unknown".to_string()),
                        checked_at: now,
                    })
                    .await;
                } else {
                    info!(
                        "firmware: available installed={:?} latest={} channel={}",
                        installed_version, entry.version, entry.channel
                    );
                    self.set_state(State::Available {
                        installed: installed_version.map(|v| format!("rel-{}", v)),
                        latest: entry.version.clone(),
                        channel: entry.channel,
                        notes_url: entry.html_url.clone(),
                        asset_url: entry.asset_url.clone(),
                        asset_name: entry.asset_name.clone(),
                        asset_size: entry.asset_size,
                        checked_at: now,
                    })
                    .await;
                }
            }
        }
    }

    /// Start downloading a specific release version. The version string
    /// must match one of the cached [`ReleaseEntry::version`] values
    /// (e.g. `"rel-5.17"` or `"rel-5.17-ca8298b"`).
    pub async fn start_download(self: &Arc<Self>, version: &str) -> Result<(), String> {
        let entry = {
            let g = self.releases.lock().await;
            g.iter().find(|e| e.version == version).cloned()
        };
        let entry = entry.ok_or_else(|| format!("unknown firmware version {:?}", version))?;

        let (tx, mut rx) = mpsc::unbounded_channel::<Progress>();
        self.set_state(State::Downloading {
            latest: entry.version.clone(),
            bytes_so_far: 0,
            total_bytes: None,
            percent: None,
        })
        .await;

        let updater = self.clone();
        let progress_state = updater.state.clone();
        let latest_for_progress = entry.version.clone();
        tokio::spawn(async move {
            while let Some(p) = rx.recv().await {
                let pct = match p.total_bytes {
                    Some(total) if total > 0 => {
                        Some(((p.bytes_so_far * 100) / total).min(100) as u8)
                    }
                    _ => None,
                };
                let mut guard = progress_state.lock().await;
                *guard = State::Downloading {
                    latest: latest_for_progress.clone(),
                    bytes_so_far: p.bytes_so_far,
                    total_bytes: p.total_bytes,
                    percent: pct,
                };
            }
        });

        let client = self.client.clone();
        let updater_for_dl = self.clone();
        let asset_url = entry.asset_url.clone();
        let asset_name = entry.asset_name.clone();
        let latest = entry.version.clone();
        tokio::spawn(async move {
            match download::download_to_temp(&client, &asset_url, &asset_name, tx).await {
                Ok(Downloaded {
                    path,
                    sha256_hex,
                    size,
                }) => {
                    info!(
                        "firmware: download complete latest={} bytes={} sha256={}",
                        latest, size, sha256_hex
                    );
                    updater_for_dl
                        .set_state(State::Ready {
                            latest,
                            hex_path: path.to_string_lossy().to_string(),
                            size,
                            sha256: sha256_hex,
                        })
                        .await;
                }
                Err(e) => {
                    warn!("firmware: download failed: {}", e);
                    updater_for_dl
                        .set_state(State::Failed {
                            error: format!("download failed: {}", e),
                            when: now_string(),
                        })
                        .await;
                }
            }
        });
        Ok(())
    }

    async fn set_state(&self, new: State) {
        let mut g = self.state.lock().await;
        *g = new;
    }
}

/// Build the cached release entries from the raw GitHub response.
/// Drops drafts, releases with no parseable firmware asset, and
/// asset names that don't conform to [`filename::parse`].
fn build_release_entries(raw: &[Release]) -> Vec<ReleaseEntry> {
    let mut out = Vec::new();
    for r in raw {
        if r.draft {
            continue;
        }
        // First parseable firmware asset wins. Releases may bundle
        // multiple boards' .hex files in the future; v1 still surfaces
        // them as separate releases keyed off the first match — when a
        // second board lands we'll revisit this to emit one entry per
        // asset.
        let (parsed, asset) = match pick_firmware_asset(&r.assets) {
            Some(pair) => pair,
            None => continue,
        };
        out.push(ReleaseEntry {
            version: parsed.display_version(),
            channel: parsed.channel.as_str(),
            commit: parsed.commit,
            board: parsed.board,
            published_at: r.published_at.clone(),
            asset_url: asset.browser_download_url.clone(),
            asset_name: asset.name.clone(),
            asset_size: asset.size,
            html_url: r.html_url.clone(),
        });
    }
    out
}

/// Return the first firmware-shaped asset on a release.
fn pick_firmware_asset(assets: &[Asset]) -> Option<(ParsedFilename, &Asset)> {
    for a in assets {
        if let Some(p) = filename::parse(&a.name) {
            return Some((p, a));
        }
    }
    None
}

/// Pick the newest eligible release. Stable always wins ties over
/// nightly when both share the same major.minor, on the principle that
/// the "real" release of a version is preferable to its commit-suffixed
/// nightly counterpart.
fn pick_best_entry(entries: &[ReleaseEntry], experimental: bool) -> Option<ReleaseEntry> {
    let mut best: Option<(FirmwareVersion, u8, ReleaseEntry)> = None;
    for e in entries {
        let parsed = match parse_entry_version(e) {
            Some(p) => p,
            None => continue,
        };
        if parsed.channel == FirmwareChannel::Nightly && !experimental {
            continue;
        }
        // Stable beats nightly at equal version.
        let channel_rank = match parsed.channel {
            FirmwareChannel::Stable => 1,
            FirmwareChannel::Nightly => 0,
        };
        match &best {
            None => best = Some((parsed.version, channel_rank, e.clone())),
            Some((bv, br, _))
                if parsed.version > *bv || (parsed.version == *bv && channel_rank > *br) =>
            {
                best = Some((parsed.version, channel_rank, e.clone()))
            }
            _ => {}
        }
    }
    best.map(|(_, _, e)| e)
}

/// Re-parse the display version on a cached entry back into the
/// structured form so we can compare it.
fn parse_entry_version(entry: &ReleaseEntry) -> Option<ParsedVersion> {
    // entry.version is "rel-X.Y" or "rel-X.Y-<commit>"
    let s = entry.version.strip_prefix("rel-")?;
    let (vstr, commit) = match s.split_once('-') {
        Some((v, c)) => (v, Some(c.to_string())),
        None => (s, None),
    };
    let version = FirmwareVersion::parse(vstr)?;
    let channel = if commit.is_some() {
        FirmwareChannel::Nightly
    } else {
        FirmwareChannel::Stable
    };
    Some(ParsedVersion { version, channel })
}

struct ParsedVersion {
    version: FirmwareVersion,
    channel: FirmwareChannel,
}

fn now_string() -> String {
    chrono::Local::now().to_rfc3339()
}

/// Spawn the background polling task. Skips automatic checks when
/// `firmware.auto_check` is off (user can still hit the manual
/// `/api/firmware/check` endpoint).
pub fn spawn_poller(updater: Arc<FirmwareUpdater>) {
    tokio::spawn(async move {
        // Stagger relative to the software updater (which sleeps 5 s)
        // so the two HTTP fetches don't race for the same wakeup.
        tokio::time::sleep(Duration::from_secs(8)).await;
        loop {
            if updater.auto_check() {
                updater.check_once().await;
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, draft: bool, asset_name: Option<&str>) -> Release {
        Release {
            tag_name: tag.into(),
            html_url: Some(format!("https://example.invalid/{}", tag)),
            published_at: Some("2026-05-20T12:00:00Z".into()),
            prerelease: false,
            draft,
            assets: match asset_name {
                Some(n) => vec![Asset {
                    name: n.into(),
                    browser_download_url: format!("https://example.invalid/{}", n),
                    size: 1024,
                }],
                None => vec![],
            },
        }
    }

    #[test]
    fn build_release_entries_skips_drafts_and_unmatched_assets() {
        let raw = vec![
            release(
                "rel-5.17",
                false,
                Some("streamcheats_teensy-4.1_rel-5.17.hex"),
            ),
            release(
                "rel-5.18",
                true,
                Some("streamcheats_teensy-4.1_rel-5.18.hex"),
            ),
            release("rel-junk", false, Some("checksums.txt")),
            release("rel-empty", false, None),
        ];
        let entries = build_release_entries(&raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].version, "rel-5.17");
        assert_eq!(entries[0].channel, "stable");
        assert_eq!(entries[0].board, "teensy-4.1");
    }

    #[test]
    fn build_release_entries_captures_nightly_commit() {
        let raw = vec![release(
            "rel-5.17-ca8298b",
            false,
            Some("streamcheats_teensy-4.1_rel-5.17-ca8298b.hex"),
        )];
        let entries = build_release_entries(&raw);
        assert_eq!(entries[0].version, "rel-5.17-ca8298b");
        assert_eq!(entries[0].channel, "nightly");
        assert_eq!(entries[0].commit.as_deref(), Some("ca8298b"));
    }

    #[test]
    fn pick_best_filters_nightly_when_experimental_off() {
        let raw = vec![
            release(
                "rel-5.17",
                false,
                Some("streamcheats_teensy-4.1_rel-5.17.hex"),
            ),
            release(
                "rel-5.18-ca8298b",
                false,
                Some("streamcheats_teensy-4.1_rel-5.18-ca8298b.hex"),
            ),
        ];
        let entries = build_release_entries(&raw);
        let picked = pick_best_entry(&entries, false).unwrap();
        assert_eq!(picked.version, "rel-5.17");
    }

    #[test]
    fn pick_best_picks_newer_nightly_when_experimental_on() {
        let raw = vec![
            release(
                "rel-5.17",
                false,
                Some("streamcheats_teensy-4.1_rel-5.17.hex"),
            ),
            release(
                "rel-5.18-ca8298b",
                false,
                Some("streamcheats_teensy-4.1_rel-5.18-ca8298b.hex"),
            ),
        ];
        let entries = build_release_entries(&raw);
        let picked = pick_best_entry(&entries, true).unwrap();
        assert_eq!(picked.version, "rel-5.18-ca8298b");
    }

    #[test]
    fn pick_best_prefers_stable_over_nightly_at_same_version() {
        let raw = vec![
            release(
                "rel-5.18-ca8298b",
                false,
                Some("streamcheats_teensy-4.1_rel-5.18-ca8298b.hex"),
            ),
            release(
                "rel-5.18",
                false,
                Some("streamcheats_teensy-4.1_rel-5.18.hex"),
            ),
        ];
        let entries = build_release_entries(&raw);
        let picked = pick_best_entry(&entries, true).unwrap();
        assert_eq!(picked.channel, "stable");
        assert_eq!(picked.version, "rel-5.18");
    }

    #[test]
    fn pick_best_returns_none_when_no_entries_match() {
        let raw = vec![release("rel-junk", false, Some("checksums.txt"))];
        let entries = build_release_entries(&raw);
        assert!(pick_best_entry(&entries, true).is_none());
    }

    #[test]
    fn parse_entry_version_round_trips() {
        let entry = ReleaseEntry {
            version: "rel-5.17-ca8298b".into(),
            channel: "nightly",
            commit: Some("ca8298b".into()),
            board: "teensy-4.1".into(),
            published_at: None,
            asset_url: String::new(),
            asset_name: String::new(),
            asset_size: 0,
            html_url: None,
        };
        let p = parse_entry_version(&entry).unwrap();
        assert_eq!(
            p.version,
            FirmwareVersion {
                major: 5,
                minor: 17
            }
        );
        assert_eq!(p.channel, FirmwareChannel::Nightly);
    }
}
