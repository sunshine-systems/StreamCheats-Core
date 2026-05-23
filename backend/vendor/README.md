# `backend/vendor/`

Third-party binaries bundled alongside the daemon and shipped via the
Electron installer (`extraResources` in `electron/package.json`). Each
binary lives next to its license.

## `teensy_loader_cli.exe`

Used by the SC-13 firmware-flash flow to write `.hex` images to a
Teensy 4.1 over USB. The daemon resolves it via, in order:

1. `STREAMCHEATS_TEENSY_LOADER_PATH` (set by Electron at daemon spawn)
2. `<exe_dir>/vendor/teensy_loader_cli.exe`
3. `<exe_dir>/teensy_loader_cli.exe`
4. `<cwd>/vendor/teensy_loader_cli.exe` (dev)
5. `<cwd>/../backend/vendor/teensy_loader_cli.exe` (dev)

If none resolve, `POST /api/firmware/flash` and
`POST /api/firmware/flash_local` return 202 then transition the state
machine to `Failed { error: "flash failed: teensy_loader_cli binary
not found …" }`. The UI surfaces this verbatim under the flash card.

### How to obtain

Source: <https://github.com/PaulStoffregen/teensy_loader_cli> (GPLv3).

There is no official prebuilt Windows binary from upstream. Build it
yourself on a Windows host with MinGW / MSYS2:

```sh
git clone https://github.com/PaulStoffregen/teensy_loader_cli
cd teensy_loader_cli
make OS=WINDOWS
```

…then copy the resulting `teensy_loader_cli.exe` to this directory
alongside a copy of the project's `LICENSE` file (GPLv3 requires the
license travel with the binary).

### License compatibility

`teensy_loader_cli` is GPLv3. Bundling a GPLv3-licensed binary
alongside an otherwise-permissively-licensed app is permitted as
"mere aggregation" (GPLv3 §5) provided:

* the binary is unmodified (we ship upstream's build verbatim),
* its license travels with it (drop `LICENSE` in this directory),
* the source is available (linked in this file).

We do not link `teensy_loader_cli` into the daemon — we shell out to
it as a separate process — so the GPL boundary stops at the
subprocess fork.

### Why this isn't checked in by default

CI agents have no Windows C toolchain available, so the binary cannot
be reproducibly built inside automation. A maintainer needs to build
it once on a dev box and check it in. Once that lands, no further
manual steps are required — `electron-builder` picks it up
automatically via the `vendor/**` extraResources rule and the daemon
finds it via env at runtime.
