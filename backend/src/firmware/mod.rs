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
pub mod flash;
pub mod github;
pub mod loader;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{mpsc, Mutex, Notify};
use tracing::{info, warn};

use self::device::{InstalledFirmware, LastHeartbeat};
use self::download::{Downloaded, Progress};
use self::filename::{FirmwareChannel, FirmwareVersion, ParsedFilename};
use self::github::{Asset, Release};

/// Cadence between automatic firmware-release checks. Matches the
/// software updater at 1 hour.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Default firmware repo when `config.json` omits `firmware.repo`.
pub const DEFAULT_REPO: &str = "sunshine-systems/Firmware-Teensy-4.1";

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
    /// Flash in flight. `teensy_loader_cli` doesn't expose a structured
    /// progress signal, but it DOES emit characteristic stdout lines we
    /// pattern-match into a coarse phase enum so the UI stepper modal
    /// can render the right step. We also mirror the last ~20 stdout
    /// lines into `log_tail` so the modal can show recent loader output
    /// inline.
    Flashing {
        /// Display version we asked the loader to write (e.g.
        /// `"rel-5.17"` or `"manual"` for `/flash_local`).
        version: String,
        /// Absolute path of the hex file being flashed. Useful for the
        /// UI to confirm-display "flashing C:\…\file.hex" on the
        /// manual-flash path.
        hex_path: String,
        /// RFC3339 timestamp the flash started, so the UI can render
        /// `Math.floor((now - started_at) / 1000)` for elapsed time.
        started_at: String,
        /// Coarse phase the loader is currently in — driven off
        /// pattern-matched stdout lines. Starts in `Starting` before
        /// the first line lands.
        phase: FlashPhase,
        /// Last ~20 lines of stdout/stderr from the loader. Capped at
        /// [`flash::LOG_TAIL_CAP`] to keep status responses small.
        log_tail: Vec<String>,
    },
    /// Last check, download, or flash failed.
    Failed { error: String, when: String },
}

/// Coarse phase tracker for a flash in flight. Driven off the
/// characteristic stdout lines `teensy_loader_cli` emits — see
/// [`flash::run_flash`] for the pattern-match rules. The UI stepper
/// modal maps each phase to a step screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FlashPhase {
    /// Subprocess spawned, no output yet. Initial.
    Starting,
    /// Saw "Waiting for Teensy device" — user needs to press the
    /// reset/program button. The wait-for-device timeout is armed
    /// while we're in this phase.
    WaitingForDevice,
    /// Saw "Found HalfKay Bootloader" — flashing in progress. No
    /// cancel UI in this phase: yanking power mid-write would brick
    /// the device.
    Programming,
    /// Saw "Booting" — device is restarting. Almost done.
    Booting,
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
    /// Single-flight guard for `start_flash` / `start_flash_local`,
    /// shared with [`device::LastHeartbeat::flash_suspended`] so the
    /// heartbeat timeout in [`device::LastHeartbeat::snapshot_at`] is
    /// suspended for exactly the same window the flash holds the
    /// guard. A second concurrent flash attempt returns
    /// `Err("flash_in_progress")` instead of queuing — the bootloader
    /// can only host one write at a time and queueing makes the
    /// failure modes harder to reason about.
    pub flash_in_progress: Arc<AtomicBool>,
    /// Memoised resolved loader path so the resolve probe (`--help`)
    /// doesn't run on every flash. Cleared on resolve failure so the
    /// next attempt re-probes from scratch.
    pub loader_path: Arc<Mutex<Option<PathBuf>>>,
    /// Fired by `POST /api/firmware/cancel_flash`. The active flash's
    /// supervision loop in [`flash::run_flash`] notices and kills the
    /// subprocess. Stored as `Mutex<Arc<Notify>>` (not a plain
    /// `Arc<Notify>`) so `start_flash` can swap in a fresh `Notify`
    /// per flash — a stored permit from a never-delivered cancel on
    /// a previous flash can't carry over and kill a fresh one.
    pub flash_cancel: Arc<Mutex<Arc<Notify>>>,
}

impl FirmwareUpdater {
    pub fn new(
        repo: String,
        auto_check_initial: bool,
        experimental_initial: bool,
        installed: LastHeartbeat,
        _data_dir: PathBuf,
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
            installed: installed.clone(),
            experimental: Arc::new(AtomicBool::new(experimental_initial)),
            auto_check: Arc::new(AtomicBool::new(auto_check_initial)),
            repo: Arc::new(Mutex::new(repo)),
            client,
            api_base: github::DEFAULT_API_BASE.to_string(),
            flash_in_progress: installed.flash_suspended(),
            loader_path: Arc::new(Mutex::new(None)),
            flash_cancel: Arc::new(Mutex::new(Arc::new(Notify::new()))),
        }
    }

    /// Request cancellation of the in-flight flash. Returns `true` if
    /// a flash was actually running, `false` if there was nothing to
    /// cancel. Route layer surfaces `false` as 409 so the UI doesn't
    /// silently no-op a button press. The supervision loop in
    /// [`flash::run_flash`] handles the actual kill + state transition.
    pub async fn cancel_flash(&self) -> bool {
        if !self.flash_in_progress.load(Ordering::SeqCst) {
            return false;
        }
        let notify = self.flash_cancel.lock().await.clone();
        notify.notify_one();
        true
    }

    /// Cheap sync check used by `GET /api/firmware/status` — does the
    /// bundled loader exist on disk? Doesn't run `--help` (that's
    /// reserved for the resolve path so we don't shell out every poll).
    pub fn loader_present(&self) -> bool {
        loader::loader_present()
    }

    /// Resolve the bundled loader. Memoises the result so repeat flash
    /// attempts don't re-probe. On a failed probe the cache is cleared
    /// so the next attempt re-resolves from scratch.
    pub async fn resolve_loader(&self) -> Result<PathBuf, loader::LoaderError> {
        // Fast path: memoised resolved path is still valid.
        {
            let guard = self.loader_path.lock().await;
            if let Some(p) = guard.as_ref() {
                if p.is_file() {
                    return Ok(p.clone());
                }
            }
        }
        let result = loader::resolve_loader().await;
        let mut guard = self.loader_path.lock().await;
        match &result {
            Ok(p) => *guard = Some(p.clone()),
            Err(_) => *guard = None,
        }
        result
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

    /// Start flashing a previously-downloaded release. The version
    /// must match a cached [`ReleaseEntry`] AND the daemon must be in
    /// the [`State::Ready`] state for that version (i.e. the user has
    /// already hit Download). Returns immediately on dispatch; the
    /// actual flash runs on a background task. The state machine
    /// drives the rest of the UI: `Ready` → `Flashing` → `UpToDate` /
    /// `Failed`.
    ///
    /// Error strings are stable wire-form codes the route layer
    /// surfaces as `{ "error": "..." }`:
    ///
    ///   `flash_in_progress`  another flash is already running
    ///   `hex_not_downloaded` no `Ready` state matching `version`
    ///   `unknown_version`    version isn't in the releases cache
    ///   `unsupported_board`  no MCU lookup for the release's board
    pub async fn start_flash(self: &Arc<Self>, version: &str) -> Result<(), String> {
        let entry = {
            let g = self.releases.lock().await;
            g.iter().find(|e| e.version == version).cloned()
        };
        let entry = entry.ok_or_else(|| "unknown_version".to_string())?;
        let mcu = flash::mcu_for(&entry.board).ok_or_else(|| "unsupported_board".to_string())?;

        // The state must currently be Ready for the requested version
        // (or, generously, any Ready state — the user might have
        // downloaded then re-checked which can transition Ready →
        // Available). We refuse if no Ready hex exists.
        let hex_path = {
            let s = self.state.lock().await;
            match &*s {
                State::Ready {
                    latest, hex_path, ..
                } if latest == &entry.version => PathBuf::from(hex_path),
                _ => return Err("hex_not_downloaded".to_string()),
            }
        };

        self.spawn_flash(entry.version.clone(), hex_path, mcu).await
    }

    /// Start flashing an arbitrary local `.hex` file. Used by the
    /// manual-flash file picker in the Updates UI for downgrades or
    /// out-of-band firmware. Board is assumed to be `teensy-4.1` for
    /// v1 — future boards land alongside [`flash::mcu_for`].
    pub async fn start_flash_local(self: &Arc<Self>, hex_path: PathBuf) -> Result<(), String> {
        let mcu = flash::mcu_for("teensy-4.1").ok_or_else(|| "unsupported_board".to_string())?;
        if let Err(e) = flash::validate_hex_path(&hex_path) {
            return Err(format!("invalid_hex: {}", e));
        }
        self.spawn_flash("manual".to_string(), hex_path, mcu).await
    }

    /// Shared by both flash entry points: trip the single-flight flag,
    /// transition to `Flashing`, kick off the subprocess on a tokio
    /// task, and on completion transition to `UpToDate` (on success)
    /// or `Failed` (on subprocess non-zero / spawn error).
    async fn spawn_flash(
        self: &Arc<Self>,
        version: String,
        hex_path: PathBuf,
        mcu: &'static str,
    ) -> Result<(), String> {
        // Resolve the bundled loader BEFORE we trip the single-flight
        // flag. With a correct install the binary is always present
        // (`extraResources` rule + env var from electron); a failure
        // here means the install is broken and the user should
        // reinstall. We surface `loader_unavailable` synchronously so
        // the route layer can return 503 without flipping any state.
        let loader_path = match self.resolve_loader().await {
            Ok(p) => p,
            Err(e) => {
                warn!("firmware: flash refused — loader unavailable: {}", e);
                return Err("loader_unavailable".to_string());
            }
        };

        // Single-flight: trip the flag with a CAS so two simultaneous
        // requests can't both win. The loser sees the existing `true`
        // and gets the stable `flash_in_progress` error code.
        if self
            .flash_in_progress
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("flash_in_progress".to_string());
        }

        let started_at = now_string();
        self.set_state(State::Flashing {
            version: version.clone(),
            hex_path: hex_path.to_string_lossy().to_string(),
            started_at,
            phase: FlashPhase::Starting,
            log_tail: Vec::new(),
        })
        .await;

        // Swap in a fresh Notify for this flash so any stale permit
        // from a previous cancel-after-exit race can't kill the new
        // flash. The cancel_flash route reads from the same Mutex
        // wrapper, so subsequent cancels still find the live Notify.
        let cancel_for_task = {
            let fresh = Arc::new(Notify::new());
            let mut g = self.flash_cancel.lock().await;
            *g = fresh.clone();
            fresh
        };

        let me = self.clone();
        let version_for_task = version.clone();
        let hex_for_task = hex_path.clone();
        let state_for_task = self.state.clone();
        tokio::spawn(async move {
            let control = flash::FlashControl {
                state: state_for_task,
                cancel: cancel_for_task,
            };
            let outcome = flash::run_flash(&loader_path, mcu, &hex_for_task, control).await;
            // Clear the single-flight + heartbeat-suspension flag
            // BEFORE the state transition so anything reading
            // `installed_version` immediately afterwards sees the
            // resumed heartbeat timing — not a frozen `age_ms = 0`.
            me.flash_in_progress.store(false, Ordering::SeqCst);
            match outcome {
                Ok(()) => {
                    info!(
                        "firmware: flash succeeded version={} hex={}",
                        version_for_task,
                        hex_for_task.display()
                    );
                    me.set_state(State::UpToDate {
                        installed: version_for_task,
                        checked_at: now_string(),
                    })
                    .await;
                }
                Err(flash::FlashError::Cancelled) => {
                    info!("firmware: flash cancelled by user");
                    me.set_state(State::Failed {
                        error: "user_cancelled".to_string(),
                        when: now_string(),
                    })
                    .await;
                }
                Err(flash::FlashError::WaitForDeviceTimeout) => {
                    warn!("firmware: flash timed out waiting for device button");
                    me.set_state(State::Failed {
                        error: "wait_for_device_timeout".to_string(),
                        when: now_string(),
                    })
                    .await;
                }
                Err(e) => {
                    warn!("firmware: flash failed: {}", e);
                    me.set_state(State::Failed {
                        error: format!("flash failed: {}", e),
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
