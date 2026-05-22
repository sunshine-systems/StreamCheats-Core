# streamcheats-core

StreamCheats.com core product, enabling support for kmbox net commands -> our custom interface / firmware (Teensy 4.1).

## Components

- `backend/` — Rust daemon (`streamcheats_core.exe`) that talks to the hardware.
- `frontend/` — Next.js UI (static export served by the Electron shell).
- `electron/` — Electron shell that wraps the daemon + UI into a desktop app.

## Building the Windows installer

The Windows build now ships as a proper NSIS installer (replacing the previous portable single-exe). See [BUILD.md](./BUILD.md) for full details.

Quick version, from `electron/`:

```
pnpm run build:all
```

Output: `electron/dist/StreamCheats Core Setup <version>.exe`.

### Installer behaviour

- Per-user install (no admin elevation prompt).
- Default install location: `%LOCALAPPDATA%\Programs\StreamCheats Core\`.
- User chooses the install directory in the installer UI (`oneClick: false`).
- Creates a Desktop shortcut and a Start Menu entry, both named "StreamCheats Core".
- Registered uninstaller in Add/Remove Programs as "StreamCheats Core".
- User config / app data is preserved on uninstall (so reinstalls keep settings).

### Version key (for the future updater, SC-4)

After install, the version string is readable from the standard per-user uninstall key:

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.sunshinesystems.streamcheatscore
    DisplayVersion = <version>
```

The SC-4 updater should read `DisplayVersion` from that key to determine the currently-installed version.

### Code signing

The installer is currently **unsigned** — we do not yet have an Authenticode certificate. Windows SmartScreen will warn users on first launch. Once a cert is acquired, plug it into `electron/package.json` (`win.certificateFile` / `win.certificatePassword`, or the `CSC_LINK` / `CSC_KEY_PASSWORD` env vars) and rebuild. Tracked as a TODO in [BUILD.md](./BUILD.md).
