//! Resolve the currently-installed StreamCheats Core version.
//!
//! Reads `DisplayVersion` from the NSIS uninstall registry key
//! electron-builder writes when the installer runs:
//!
//! ```text
//! HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\
//!     com.sunshinesystems.streamcheatscore
//! ```
//!
//! Falls back to the compile-time `CARGO_PKG_VERSION` when the key is
//! missing or unreadable (dev runs from `cargo run`, the installer
//! never touched HKCU). The fallback means the updater still surfaces a
//! coherent state during development; it just compares against the
//! daemon's build version rather than what the user installed.

/// Compile-time fallback used when the registry lookup fails.
pub const FALLBACK_VERSION: &str = env!("CARGO_PKG_VERSION");

/// NSIS uninstall key the electron-builder NSIS installer writes per
/// the `appId` set in electron/package.json's build config.
#[cfg(windows)]
const UNINSTALL_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Uninstall\com.sunshinesystems.streamcheatscore";

/// Look up the installed version string. Returns the registry value
/// when present, otherwise [`FALLBACK_VERSION`]. The returned string is
/// the raw `DisplayVersion` value — callers should run it through
/// [`super::version::parse_tag`] (or `Version::parse` directly) before
/// comparing.
#[cfg(windows)]
pub fn read_installed_version() -> String {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.open_subkey(UNINSTALL_KEY) {
        Ok(key) => match key.get_value::<String, _>("DisplayVersion") {
            Ok(v) if !v.trim().is_empty() => v,
            _ => FALLBACK_VERSION.to_string(),
        },
        Err(_) => FALLBACK_VERSION.to_string(),
    }
}

/// Non-Windows builds (e.g. CI on Linux for `cargo test`) always
/// report the compile-time version — there's no installer there.
#[cfg(not(windows))]
pub fn read_installed_version() -> String {
    FALLBACK_VERSION.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_matches_cargo_pkg_version() {
        // The fallback is the package version baked in at compile time;
        // this test just locks down the contract so a future refactor
        // doesn't accidentally swap it for an unrelated string.
        assert_eq!(FALLBACK_VERSION, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn read_returns_non_empty_string() {
        // On a CI box with no installer, this returns the fallback.
        // On a dev box that does have the key, it returns whatever is
        // installed. Either way the string must be non-empty.
        let v = read_installed_version();
        assert!(!v.trim().is_empty());
    }
}
