//! In-app update checker.
//!
//! Polls GitHub Releases every [`CHECK_INTERVAL`], filters to versions
//! the user is eligible for (stable by default, or stable + nightly
//! when `experimental_builds` is on), and exposes the current updater
//! [`State`] to the HTTP routes under `/api/updates/*`.
//!
//! Threading: the polling task runs inside the existing tokio runtime
//! that hosts the axum server (see [`crate::http::server`]); it doesn't
//! spawn a fresh runtime. State is held behind a `tokio::sync::Mutex`
//! that handlers clone via `Arc`.

pub mod download;
pub mod github;
pub mod installed;
pub mod version;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use semver::Version;
use serde::Serialize;
use tokio::sync::{mpsc, Mutex};
use tracing::{info, warn};

use self::download::{Downloaded, Progress};
use self::github::Release;
use self::version::{channel_allowed, parse_tag, Channel};

/// Cadence between automatic update checks. 1 hour gives users
/// timely visibility of new releases while staying well under
/// GitHub's 60 req/hr anonymous quota (1 software + 1 firmware
/// poll/hour = 2 req/hr).
pub const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Updater state machine. Each variant is what the UI renders. Serde-
/// serialised as JSON for `GET /api/updates/status`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum State {
    /// No check has run yet (process just started).
    Idle,
    /// Last check succeeded — installed version is already the newest
    /// the user is eligible for.
    UpToDate {
        installed: String,
        checked_at: String,
    },
    /// Newer release available. UI shows a banner with version + notes
    /// link.
    Available {
        installed: String,
        latest: String,
        channel: &'static str,
        notes_url: Option<String>,
        asset_url: String,
        asset_size: u64,
        checked_at: String,
    },
    /// Download is in flight. `percent` is `None` when the server
    /// didn't advertise a Content-Length.
    Downloading {
        latest: String,
        bytes_so_far: u64,
        total_bytes: Option<u64>,
        percent: Option<u8>,
    },
    /// Download complete. Installer is on disk; UI shows "Install now".
    Ready {
        latest: String,
        installer_path: String,
        size: u64,
        sha256: String,
    },
    /// Last check or download failed. Error string is for the UI.
    Failed {
        error: String,
        when: String,
    },
}

impl Default for State {
    fn default() -> Self {
        State::Idle
    }
}

/// Cloneable handle to the updater. Holds the live state, the http
/// client, and the settings hook the orchestrator reads on each check.
#[derive(Clone)]
pub struct Updater {
    pub state: Arc<Mutex<State>>,
    pub experimental: Arc<std::sync::atomic::AtomicBool>,
    pub client: reqwest::Client,
    pub api_base: String,
}

impl Updater {
    /// Build a new updater. `experimental_initial` is the persisted
    /// `experimental_builds` flag from `config.json`.
    pub fn new(experimental_initial: bool) -> Self {
        let ua = format!("streamcheats-core/{}", env!("CARGO_PKG_VERSION"));
        // If client construction fails we still want the daemon to
        // start — fall back to the default reqwest client (which still
        // has *a* user-agent, just not ours). The error is logged so
        // the user can see it.
        let client = match github::build_client(&ua) {
            Ok(c) => c,
            Err(e) => {
                warn!("updater: could not build dedicated client ({}); using default", e);
                reqwest::Client::new()
            }
        };
        Self {
            state: Arc::new(Mutex::new(State::Idle)),
            experimental: Arc::new(std::sync::atomic::AtomicBool::new(experimental_initial)),
            client,
            api_base: github::DEFAULT_API_BASE.to_string(),
        }
    }

    /// Snapshot of the current state. Cloned out of the mutex so the
    /// caller doesn't hold the lock across an await.
    pub async fn snapshot(&self) -> State {
        self.state.lock().await.clone()
    }

    /// Toggle the experimental-builds flag. Returns the new value.
    pub fn set_experimental(&self, enabled: bool) {
        self.experimental
            .store(enabled, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn experimental(&self) -> bool {
        self.experimental.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Run one check cycle: pull releases, find the best eligible one,
    /// update state. Returns silently — the new state is observable via
    /// [`Self::snapshot`].
    pub async fn check_once(&self) {
        let installed_raw = installed::read_installed_version();
        let installed_v = match parse_tag(&installed_raw) {
            Ok(v) => v,
            Err(e) => {
                let msg = format!("could not parse installed version {:?}: {}", installed_raw, e);
                warn!("updater: {}", msg);
                self.set_state(State::Failed {
                    error: msg,
                    when: now_string(),
                })
                .await;
                return;
            }
        };

        let releases = match github::fetch_releases(&self.client, &self.api_base).await {
            Ok(r) => r,
            Err(e) => {
                let msg = format!("github fetch failed: {}", e);
                warn!("updater: {}", msg);
                // Don't clobber a previous Available state — leave it
                // so the banner stays visible even if a follow-up check
                // fails. Only overwrite when we don't already have one.
                let current = self.snapshot().await;
                if matches!(current, State::Idle | State::UpToDate { .. } | State::Failed { .. })
                {
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
        let best = pick_best_release(&releases, experimental);
        let now = now_string();

        match best {
            Some((release, ver)) => {
                if !version::is_newer(&ver, &installed_v) {
                    info!(
                        "updater: up to date (installed={}, latest_eligible={})",
                        installed_v, ver
                    );
                    self.set_state(State::UpToDate {
                        installed: installed_v.to_string(),
                        checked_at: now,
                    })
                    .await;
                    return;
                }

                let asset = pick_installer_asset(&release.assets);
                let asset = match asset {
                    Some(a) => a,
                    None => {
                        let msg = format!(
                            "release {} has no installer asset (looking for *.exe)",
                            release.tag_name
                        );
                        warn!("updater: {}", msg);
                        self.set_state(State::Failed {
                            error: msg,
                            when: now,
                        })
                        .await;
                        return;
                    }
                };
                let channel = match Channel::classify(&ver) {
                    Channel::Stable => "stable",
                    Channel::Nightly => "nightly",
                };
                info!(
                    "updater: available installed={} latest={} channel={}",
                    installed_v, ver, channel
                );
                self.set_state(State::Available {
                    installed: installed_v.to_string(),
                    latest: ver.to_string(),
                    channel,
                    notes_url: release.html_url.clone(),
                    asset_url: asset.browser_download_url.clone(),
                    asset_size: asset.size,
                    checked_at: now,
                })
                .await;
            }
            None => {
                info!(
                    "updater: no eligible releases (installed={}, experimental={})",
                    installed_v, experimental
                );
                self.set_state(State::UpToDate {
                    installed: installed_v.to_string(),
                    checked_at: now,
                })
                .await;
            }
        }
    }

    /// Begin a download for whatever release is currently `Available`.
    /// Spawns the download in a background tokio task; returns once the
    /// task is dispatched.
    pub async fn start_download(self: &Arc<Self>) -> Result<(), String> {
        let snap = self.snapshot().await;
        let (latest, asset_url) = match snap {
            State::Available {
                latest, asset_url, ..
            } => (latest, asset_url),
            other => {
                return Err(format!("not in a downloadable state: {:?}", other));
            }
        };

        let filename = download::installer_filename(&latest);
        let (tx, mut rx) = mpsc::unbounded_channel::<Progress>();
        // Move state to Downloading{0} immediately so the UI flips.
        self.set_state(State::Downloading {
            latest: latest.clone(),
            bytes_so_far: 0,
            total_bytes: None,
            percent: None,
        })
        .await;

        let updater = self.clone();
        let latest_for_progress = latest.clone();
        let progress_state = updater.state.clone();
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
        tokio::spawn(async move {
            match download::download_to_temp(&client, &asset_url, &filename, tx).await {
                Ok(Downloaded { path, sha256_hex, size }) => {
                    info!(
                        "updater: download complete latest={} bytes={} sha256={}",
                        latest, size, sha256_hex
                    );
                    updater_for_dl
                        .set_state(State::Ready {
                            latest,
                            installer_path: path.to_string_lossy().to_string(),
                            size,
                            sha256: sha256_hex,
                        })
                        .await;
                }
                Err(e) => {
                    warn!("updater: download failed: {}", e);
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

    /// Launch the downloaded installer (detached) and signal the
    /// daemon to exit. Returns the installer path on success.
    pub async fn install_now(&self) -> Result<PathBuf, String> {
        let snap = self.snapshot().await;
        let installer_path = match snap {
            State::Ready { installer_path, .. } => PathBuf::from(installer_path),
            _ => return Err("no downloaded installer ready".into()),
        };
        spawn_installer_detached(&installer_path)
            .map_err(|e| format!("could not launch installer: {}", e))?;
        Ok(installer_path)
    }

    async fn set_state(&self, new: State) {
        let mut guard = self.state.lock().await;
        *guard = new;
    }
}

/// Pick the highest-versioned release the user is eligible for. Drafts
/// are skipped. Returns the release + parsed Version.
fn pick_best_release(releases: &[Release], experimental: bool) -> Option<(Release, Version)> {
    let mut best: Option<(Release, Version)> = None;
    for r in releases {
        if r.draft {
            continue;
        }
        let v = match parse_tag(&r.tag_name) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if !channel_allowed(&v, experimental) {
            continue;
        }
        match &best {
            None => best = Some((r.clone(), v)),
            Some((_, bv)) if &v > bv => best = Some((r.clone(), v)),
            _ => {}
        }
    }
    best
}

/// Find the installer asset on a release. Matches `StreamCheats Core
/// Setup *.exe` first, then any `.exe`, so a future asset-naming tweak
/// doesn't silently break the updater.
fn pick_installer_asset(assets: &[github::Asset]) -> Option<&github::Asset> {
    assets
        .iter()
        .find(|a| a.name.starts_with("StreamCheats Core Setup") && a.name.ends_with(".exe"))
        .or_else(|| assets.iter().find(|a| a.name.ends_with(".exe")))
}

/// Spawn the installer as a detached child so the daemon can exit
/// immediately and let the installer replace files on disk.
#[cfg(windows)]
fn spawn_installer_detached(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    // CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS: the child does not
    // inherit our console and won't die when we exit.
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    Command::new(path)
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(|_| ())
}

#[cfg(not(windows))]
fn spawn_installer_detached(path: &std::path::Path) -> std::io::Result<()> {
    use std::process::Command;
    Command::new(path).spawn().map(|_| ())
}

fn now_string() -> String {
    chrono::Local::now().to_rfc3339()
}

/// Spawn the background polling task. Runs an immediate check on
/// startup, then sleeps [`CHECK_INTERVAL`] between checks. Cancelled
/// when the tokio runtime hosting it is dropped (i.e. at daemon
/// shutdown).
pub fn spawn_poller(updater: Arc<Updater>) {
    tokio::spawn(async move {
        // Small initial delay so the first check doesn't race against
        // the rest of the daemon coming up.
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            updater.check_once().await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater::github::{Asset, Release};

    fn rel(tag: &str, prerelease: bool, with_asset: bool) -> Release {
        Release {
            tag_name: tag.into(),
            name: Some(tag.into()),
            html_url: Some(format!("https://example.invalid/{}", tag)),
            prerelease,
            draft: false,
            assets: if with_asset {
                vec![Asset {
                    name: format!("StreamCheats Core Setup {}.exe", tag.trim_start_matches('v')),
                    browser_download_url: format!("https://example.invalid/{}.exe", tag),
                    size: 1_000_000,
                }]
            } else {
                vec![]
            },
        }
    }

    #[test]
    fn pick_best_filters_nightly_when_off() {
        let releases = vec![
            rel("v0.6.3", false, true),
            rel("v0.7.0-nightly.20260601", true, true),
        ];
        let (picked, ver) = pick_best_release(&releases, false).unwrap();
        assert_eq!(picked.tag_name, "v0.6.3");
        assert_eq!(ver.to_string(), "0.6.3");
    }

    #[test]
    fn pick_best_includes_nightly_when_on() {
        let releases = vec![
            rel("v0.6.3", false, true),
            rel("v0.7.0-nightly.20260601", true, true),
        ];
        let (picked, _) = pick_best_release(&releases, true).unwrap();
        assert_eq!(picked.tag_name, "v0.7.0-nightly.20260601");
    }

    #[test]
    fn pick_best_skips_drafts_and_unparseable_tags() {
        let mut releases = vec![rel("v0.6.3", false, true), rel("not-a-version", false, true)];
        releases[0].draft = true;
        // Draft + unparseable → nothing left to pick.
        assert!(pick_best_release(&releases, true).is_none());
    }

    #[test]
    fn pick_best_returns_none_for_empty_list() {
        assert!(pick_best_release(&[], false).is_none());
        assert!(pick_best_release(&[], true).is_none());
    }

    #[test]
    fn pick_installer_asset_prefers_canonical_name() {
        let assets = vec![
            Asset {
                name: "checksums.txt".into(),
                browser_download_url: "https://example/checksums.txt".into(),
                size: 100,
            },
            Asset {
                name: "StreamCheats Core Setup 0.6.3.exe".into(),
                browser_download_url: "https://example/setup.exe".into(),
                size: 50_000_000,
            },
        ];
        let a = pick_installer_asset(&assets).unwrap();
        assert_eq!(a.name, "StreamCheats Core Setup 0.6.3.exe");
    }

    #[test]
    fn pick_installer_asset_falls_back_to_any_exe() {
        let assets = vec![Asset {
            name: "weird-name.exe".into(),
            browser_download_url: "https://example/weird.exe".into(),
            size: 100,
        }];
        assert_eq!(pick_installer_asset(&assets).unwrap().name, "weird-name.exe");
    }

    #[test]
    fn pick_installer_asset_returns_none_when_no_exe() {
        let assets = vec![Asset {
            name: "checksums.txt".into(),
            browser_download_url: "https://example/checksums.txt".into(),
            size: 100,
        }];
        assert!(pick_installer_asset(&assets).is_none());
    }
}
