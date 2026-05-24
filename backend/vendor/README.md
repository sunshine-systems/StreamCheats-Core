# Vendored third-party binaries

## `teensy_loader_cli.exe`

A prebuilt Windows x64 build of [`teensy_loader_cli`](https://github.com/PaulStoffregen/teensy_loader_cli),
the command-line firmware flasher for PJRC Teensy boards. StreamCheats Core
shells out to it to write `.hex` files to the Teensy 4.1 — see
`backend/src/firmware/flash.rs`.

* **File:** `teensy_loader_cli.exe`
* **Version:** v1.0 (reports as `Teensy Loader, Command Line, Version 2.3`
  when invoked)
* **Upstream:** https://github.com/PaulStoffregen/teensy_loader_cli
* **License:** GPLv3 — see `LICENSE.txt` next to this file

### Why is it vendored?

PJRC does not ship a prebuilt Windows CLI binary (their `teensy.exe`
download is the GUI Teensy Loader, not the CLI). Bundling our own
known-good build avoids the lazy-download-on-first-flash UX that SC-14
attempted (which was awkward without a hosted binary). The tradeoff is
that we redistribute a GPLv3 binary; we comply by shipping `LICENSE.txt`
alongside it and pointing users to the upstream source.

### How to replace this binary

If a newer `teensy_loader_cli` build is needed:

1. Build it from source on Windows (see upstream README) OR grab a
   trusted prebuilt from a community source.
2. Replace `teensy_loader_cli.exe` in this directory.
3. Sanity-check: `./teensy_loader_cli.exe --help` should print a usage
   banner and exit. (The daemon also runs this probe on resolve.)
4. Rebuild the installer with `pnpm -C electron build:all` — the
   electron-builder `extraResources` rule under
   `electron/package.json` will pick the new binary up automatically.

### Where it lives at runtime

* **Packaged:** `resources/teensy_loader_cli.exe` next to
  `streamcheats_core.exe` (electron-builder copies it there from this
  directory via the `extraResources` build rule).
* **Dev:** read directly from this directory. `electron/main.js` sets
  `STREAMCHEATS_TEENSY_LOADER_PATH` to point the daemon at the right
  file in both modes.
