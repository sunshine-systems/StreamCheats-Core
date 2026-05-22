# Building StreamCheats Core

## Prerequisites

- Rust (stable) with `cargo`
- Node.js + `pnpm`
- Windows (the only supported target right now)

## Full installer build (one shot)

From `electron/`:

```
pnpm run build:all
```

This runs, in order:

1. `cargo build --release` for the Rust daemon (`backend/target/release/streamcheats_core.exe`).
2. `pnpm --filter ./../frontend build` to produce the static Next.js export at `frontend/out/`.
3. `electron-builder` to produce the NSIS installer at `electron/dist/StreamCheats Core Setup <version>.exe`.

If you prefer to run the steps manually, run them in the same order — `electron-builder` will fail if either the Rust binary or the frontend `out/` directory is missing (they are referenced from `extraResources` in `electron/package.json`).

## Installer details

- Target: `electron-builder` `nsis` (per-user, no admin elevation required).
- Output: `electron/dist/StreamCheats Core Setup <version>.exe`.
- Default install path (per-user): `%LOCALAPPDATA%\Programs\StreamCheats Core\`.
- Desktop + Start Menu shortcut: created, name "StreamCheats Core".
- Uninstall: registered in Windows Add/Remove Programs as "StreamCheats Core". App data is intentionally NOT deleted on uninstall (`deleteAppDataOnUninstall: false`) so reinstalls preserve user config.

## Registry version key

electron-builder's NSIS template writes per-user uninstall info under:

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<appId>
```

For this app `<appId>` is `com.sunshinesystems.streamcheatscore`. The `DisplayVersion` value under that key holds the installed version string and is what the SC-4 updater should read.

If we later need a dedicated version key under `HKCU\Software\StreamCheats\Version`, add a custom NSIS include script via `nsis.include` in `electron/package.json` — not added yet because the standard Uninstall key already gives us a stable, documented location.

## Code signing

TODO (SC-?): the installer is currently UNSIGNED. Windows SmartScreen will warn end users on first run. Once we have an Authenticode certificate, configure `win.certificateFile` / `win.certificatePassword` (or `CSC_LINK` / `CSC_KEY_PASSWORD` env vars) and rebuild. Until then, releases ship unsigned.
