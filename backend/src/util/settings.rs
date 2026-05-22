//! Persisted settings utility: loads `config.json` from disk, validates,
//! and surfaces a structured `Settings` value to the rest of the program.

use std::fs;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Filename of the persisted config, looked up in the process's current
/// working directory.
pub const CONFIG_FILENAME: &str = "config.json";
/// UDP port used when `config.json` omits `udp_port`. Matches the vendor
/// SDK's default of 8888.
pub const DEFAULT_UDP_PORT: u16 = 8888;
/// Default 8-hex-char device identifier used when `config.json` omits
/// `device_mac`. Host apps must send packets stamped with this value or
/// they will be dropped on MAC mismatch.
pub const DEFAULT_MAC: &str = "01FBC068";

/// Raw on-disk schema. Unknown fields are tolerated silently — earlier
/// versions of the translator carried `com_port` and `baud_rate` keys
/// and we don't want stale configs to error out (the supervisor now
/// auto-discovers any Teensy on any COM port at the hardcoded 115200).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RawSettings {
    #[serde(default)]
    pub listen_addr: String,
    #[serde(default)]
    pub udp_port: Option<u16>,
    #[serde(default)]
    pub device_mac: Option<String>,
    #[serde(default)]
    pub enable_timing_logs: Option<bool>,
    /// Optional platform-aware data directory for logs + future state.
    /// `None` or an empty string falls back to
    /// `dirs::data_local_dir()/"StreamCheats Core"` (i.e.
    /// `%LOCALAPPDATA%\StreamCheats Core` on Windows).
    #[serde(default)]
    pub data_dir: Option<String>,
    /// On by default. When `true` (or absent), [`crate::init_logging`]
    /// adds a daily-rotating non-blocking file appender at
    /// `<data_dir>/logs/`. Hot-path threads never block on disk because
    /// the appender is wrapped in `tracing_appender::non_blocking` in
    /// lossy mode — see `init_logging` for the contract.
    #[serde(default)]
    pub enable_file_logging: Option<bool>,
}

/// Validated runtime configuration. Produced by [`load_or_create`] on a
/// successful load and consumed by `main::run`.
#[derive(Debug, Clone)]
pub struct Settings {
    /// Local IP address to bind the UDP listener on (e.g. `0.0.0.0`).
    pub listen_addr: IpAddr,
    /// UDP port to bind on. Defaults to [`DEFAULT_UDP_PORT`] if unset.
    pub udp_port: u16,
    /// Device identifier as a `u32`, parsed from the config's 8-hex-char string.
    /// Incoming packets must carry this value in `Header::mac` or they
    /// are silently dropped.
    pub device_mac: u32,
    /// Original uppercase hex string form of `device_mac`, kept around so
    /// the startup banner can log it verbatim without re-formatting.
    pub device_mac_str: String,
    /// When `true`, every IN/OUT log line gets a timing suffix
    /// (`parse=Nµs` on IN, `lat=X.Yms q=A.Bms w=C.Dms` on OUT) so you can
    /// trace where lag is coming from. Off by default — it's purely
    /// diagnostic. Defaults to `false` if unset.
    pub enable_timing_logs: bool,
    /// Resolved data directory. Used as the parent of the `logs/` folder
    /// when [`Self::enable_file_logging`] is on. Falls back to
    /// `%LOCALAPPDATA%\StreamCheats Core` on Windows (or the
    /// `dirs::data_local_dir()` equivalent on other platforms) when the
    /// user leaves `data_dir` blank in `config.json`.
    pub data_dir: PathBuf,
    /// Flag for the daily-rotating file logger. `true` by default — the
    /// logger uses `tracing_appender::non_blocking` in lossy mode so the
    /// serial writer / reader / UDP / heartbeat threads never block on
    /// disk. Users who want zero on-disk files can set this to `false`
    /// in `config.json`.
    pub enable_file_logging: bool,
}

fn default_json() -> &'static str {
    "{\n  \"listen_addr\": \"127.0.0.1\",\n  \"udp_port\": 8888,\n  \"device_mac\": \"01FBC068\",\n  \"enable_timing_logs\": false,\n  \"data_dir\": \"\",\n  \"enable_file_logging\": true\n}\n"
}

/// Resolve the effective data directory. An explicit non-empty
/// `data_dir` from the config wins; otherwise we fall back to
/// `dirs::data_local_dir()` joined with `"StreamCheats Core"`.
/// Returns an error only if the platform doesn't expose a local data
/// dir AND the user didn't provide one — vanishingly rare on the
/// supported targets but worth surfacing rather than panicking.
fn resolve_data_dir(raw: Option<&str>) -> Result<PathBuf> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => Ok(PathBuf::from(p)),
        None => dirs::data_local_dir()
            .map(|d| d.join("StreamCheats Core"))
            .ok_or_else(|| {
                anyhow!(
                    "could not determine a default data_dir for this platform; set `data_dir` in config.json"
                )
            }),
    }
}

fn parse_mac(s: &str) -> Result<u32> {
    let t = s.trim();
    if t.len() != 8 || !t.chars().all(|c| c.is_ascii_hexdigit()) {
        bail!(
            "device_mac must be exactly 8 hex characters (got {:?})",
            s
        );
    }
    u32::from_str_radix(t, 16).map_err(|e| anyhow!("device_mac hex parse: {}", e))
}

fn validate(raw: RawSettings) -> Result<Settings> {
    if raw.listen_addr.trim().is_empty() {
        bail!("listen_addr is required and must be non-empty");
    }
    let listen_addr: IpAddr = raw
        .listen_addr
        .trim()
        .parse()
        .with_context(|| format!("listen_addr {:?} is not a valid IP address", raw.listen_addr))?;

    let udp_port = match raw.udp_port {
        Some(0) => bail!("udp_port must be 1..=65535"),
        Some(p) => p,
        None => DEFAULT_UDP_PORT,
    };

    let mac_str = raw
        .device_mac
        .clone()
        .unwrap_or_else(|| DEFAULT_MAC.to_string());
    let device_mac = parse_mac(&mac_str)?;

    let data_dir = resolve_data_dir(raw.data_dir.as_deref())?;

    Ok(Settings {
        listen_addr,
        udp_port,
        device_mac,
        device_mac_str: mac_str.to_uppercase(),
        enable_timing_logs: raw.enable_timing_logs.unwrap_or(false),
        data_dir,
        // Default ON: hot-path threads use the lossy `non_blocking`
        // writer so file logging adds no synchronous I/O on the critical
        // serial/UDP paths. Users opt OUT via an explicit `false` in
        // config.json if they want zero on-disk files.
        enable_file_logging: raw.enable_file_logging.unwrap_or(true),
    })
}

/// Three-way result of [`load_or_create`]. Encodes whether the caller
/// should keep running (`Loaded`), exit so the user can edit the file we
/// just wrote (`WroteDefault`), or exit so the user can fix a named field
/// in the existing file (`Invalid`).
pub enum LoadOutcome {
    /// Config parsed and validated cleanly. Carry on.
    Loaded(Settings),
    /// File was missing OR structurally unusable (unreadable / not valid
    /// JSON). A fresh default was written at `path`. `reason` is `None`
    /// when the file was simply missing, `Some(text)` when an existing
    /// file had to be discarded.
    WroteDefault {
        /// Absolute path of the freshly-written default config.
        path: PathBuf,
        /// Diagnostic for the user explaining *why* their previous file
        /// was discarded, or `None` if the file just didn't exist yet.
        reason: Option<String>,
    },
    /// File parsed as JSON but one or more field values are wrong. The
    /// file has NOT been touched — the user's other edits are preserved.
    /// They should fix the specific value named in `reason` and re-run.
    Invalid {
        /// Absolute path of the existing config the user must edit.
        path: PathBuf,
        /// Human-readable description of the validation failure.
        reason: String,
    },
}

/// Load `config.json` from `dir`. Behaviour:
///   * missing             -> write default, return WroteDefault { reason: None }
///   * unreadable / bad JSON -> rewrite default, return WroteDefault { reason: Some(...) }
///                              (file itself is structurally unusable, nothing to preserve)
///   * parses but value invalid -> LEAVE FILE ALONE, return Invalid { reason }
///                                 (user's edits are kept; they fix the named field)
///   * present and valid   -> return Loaded(settings)
pub fn load_or_create(dir: &Path) -> Result<LoadOutcome> {
    let path = dir.join(CONFIG_FILENAME);

    if !path.exists() {
        fs::write(&path, default_json())
            .with_context(|| format!("writing default config to {}", path.display()))?;
        return Ok(LoadOutcome::WroteDefault { path, reason: None });
    }

    let text = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            let _ = fs::remove_file(&path);
            fs::write(&path, default_json()).with_context(|| {
                format!("rewriting default config to {}", path.display())
            })?;
            return Ok(LoadOutcome::WroteDefault {
                path,
                reason: Some(format!("could not read file: {}", e)),
            });
        }
    };

    let raw: RawSettings = match serde_json::from_str(&text) {
        Ok(r) => r,
        Err(e) => {
            let _ = fs::remove_file(&path);
            fs::write(&path, default_json()).with_context(|| {
                format!("rewriting default config to {}", path.display())
            })?;
            return Ok(LoadOutcome::WroteDefault {
                path,
                reason: Some(format!("JSON parse error: {}", e)),
            });
        }
    };

    match validate(raw) {
        Ok(settings) => Ok(LoadOutcome::Loaded(settings)),
        Err(e) => Ok(LoadOutcome::Invalid {
            path,
            reason: format!("{}", e),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_ok() {
        assert_eq!(parse_mac("01FBC068").unwrap(), 0x01FBC068);
        assert_eq!(parse_mac("01fbc068").unwrap(), 0x01FBC068);
    }

    #[test]
    fn mac_rejects_bad_len() {
        assert!(parse_mac("01FBC06").is_err());
        assert!(parse_mac("01FBC0688").is_err());
    }

    #[test]
    fn mac_rejects_non_hex() {
        assert!(parse_mac("01FBC0GG").is_err());
    }

    #[test]
    fn validate_requires_listen_addr() {
        let raw = RawSettings {
            listen_addr: "".into(),
            udp_port: None,
            device_mac: None,
            enable_timing_logs: None,
            data_dir: None,
            enable_file_logging: None,
        };
        assert!(validate(raw).is_err());
    }

    #[test]
    fn validate_fills_defaults() {
        let raw = RawSettings {
            listen_addr: "127.0.0.1".into(),
            udp_port: None,
            device_mac: None,
            enable_timing_logs: None,
            data_dir: None,
            enable_file_logging: None,
        };
        let s = validate(raw).unwrap();
        assert_eq!(s.udp_port, DEFAULT_UDP_PORT);
        assert_eq!(s.device_mac, 0x01FBC068);
        // enable_timing_logs defaults to false so users get clean logs
        // unless they opt in.
        assert!(!s.enable_timing_logs);
    }

    #[test]
    fn enable_timing_logs_can_be_opted_in() {
        let raw = RawSettings {
            listen_addr: "127.0.0.1".into(),
            udp_port: None,
            device_mac: None,
            enable_timing_logs: Some(true),
            data_dir: None,
            enable_file_logging: None,
        };
        let s = validate(raw).unwrap();
        assert!(s.enable_timing_logs);
    }

    #[test]
    fn file_logging_defaults_on_and_data_dir_falls_back() {
        // Empty data_dir + missing enable_file_logging must resolve to
        // a non-empty platform default and a `true` flag — file logging
        // is on by default and uses a non-blocking lossy appender, so
        // there is no latency cost on the serial / UDP hot paths.
        let raw = RawSettings {
            listen_addr: "127.0.0.1".into(),
            udp_port: None,
            device_mac: None,
            enable_timing_logs: None,
            data_dir: None,
            enable_file_logging: None,
        };
        let s = validate(raw).unwrap();
        assert!(s.enable_file_logging);
        assert!(!s.data_dir.as_os_str().is_empty());
    }

    #[test]
    fn file_logging_can_be_opted_out() {
        // Users who really want zero on-disk files can still set
        // `enable_file_logging: false` in config.json.
        let raw = RawSettings {
            listen_addr: "127.0.0.1".into(),
            udp_port: None,
            device_mac: None,
            enable_timing_logs: None,
            data_dir: None,
            enable_file_logging: Some(false),
        };
        let s = validate(raw).unwrap();
        assert!(!s.enable_file_logging);
    }

    #[test]
    fn explicit_data_dir_is_honoured() {
        let raw = RawSettings {
            listen_addr: "127.0.0.1".into(),
            udp_port: None,
            device_mac: None,
            enable_timing_logs: None,
            data_dir: Some("C:/tmp/streamcheats-test".into()),
            enable_file_logging: Some(true),
        };
        let s = validate(raw).unwrap();
        assert_eq!(s.data_dir, PathBuf::from("C:/tmp/streamcheats-test"));
        assert!(s.enable_file_logging);
    }

    #[test]
    fn stale_com_port_and_baud_rate_keys_are_ignored() {
        // Old configs from before auto-discovery may still carry these
        // keys. They must parse cleanly (serde_json is permissive by
        // default — no `deny_unknown_fields`) so users don't have to
        // hand-edit their config when upgrading.
        let text = r#"{
            "listen_addr": "0.0.0.0",
            "udp_port": 8888,
            "com_port": "COM3",
            "baud_rate": 115200,
            "device_mac": "01FBC068",
            "enable_timing_logs": false
        }"#;
        let raw: RawSettings = serde_json::from_str(text).expect("stale keys must not error");
        let s = validate(raw).unwrap();
        assert_eq!(s.udp_port, 8888);
        assert_eq!(s.device_mac, 0x01FBC068);
    }
}
