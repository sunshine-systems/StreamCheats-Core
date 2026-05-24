// Realistic fixture payloads — one per endpoint, validated against the
// zod schemas before they leave this module. Importing a fixture
// guarantees the shape parses cleanly under the schema, so the MSW
// handlers can serve them without further wrapping.
//
// When the daemon's response shape drifts, the schema parse here fails
// at module-load time and every test that imports the fixture fails
// loudly — the "contract drift signal" SC-12 is about.

import {
  ExperimentalRegistryResponseSchema,
  ExperimentalStatusSchema,
  FirmwareReleasesResponseSchema,
  FirmwareStatusResponseSchema,
  HealthResponseSchema,
  LogEventSchema,
  UpdaterStatusResponseSchema,
  type ExperimentalRegistryResponse,
  type ExperimentalStatus,
  type FirmwareReleasesResponse,
  type FirmwareStatusResponse,
  type HealthResponse,
  type LogEvent,
  type UpdaterStatusResponse,
} from "../../lib/api/schemas";

// ---- Firmware ---------------------------------------------------------

export const firmwareStatusIdle: FirmwareStatusResponse =
  FirmwareStatusResponseSchema.parse({
    state: { kind: "idle" },
    installed_version: null,
    channel: "unknown",
    repo: "sunshine-systems/Firmware-Teensy-4.1",
    board: null,
    auto_check: true,
    // SC-14: fresh-install state — loader hasn't been downloaded yet.
    // The Updates page uses this to swap the flash button for a
    // "Download flash tool" affordance in the confirm modal.
    loader_ready: false,
    experimental_builds: false,
  });

export const firmwareStatusUpToDate: FirmwareStatusResponse =
  FirmwareStatusResponseSchema.parse({
    state: {
      kind: "up_to_date",
      installed: "rel-5.17",
      checked_at: "2026-05-22T18:00:00Z",
    },
    installed_version: "rel-5.17",
    channel: "unknown",
    repo: "sunshine-systems/Firmware-Teensy-4.1",
    board: "teensy-4.1",
    auto_check: true,
    loader_ready: true,
    experimental_builds: false,
  });

export const firmwareStatusAvailable: FirmwareStatusResponse =
  FirmwareStatusResponseSchema.parse({
    state: {
      kind: "available",
      installed: "rel-5.16",
      latest: "rel-5.17",
      channel: "stable",
      notes_url: "https://github.com/example/repo/releases/tag/rel-5.17",
      asset_url: "https://example.invalid/rel-5.17.hex",
      asset_name: "teensy-4.1-rel-5.17.hex",
      asset_size: 524288,
      checked_at: "2026-05-22T18:00:00Z",
    },
    installed_version: "rel-5.16",
    channel: "stable",
    repo: "sunshine-systems/Firmware-Teensy-4.1",
    board: "teensy-4.1",
    auto_check: true,
    loader_ready: true,
    experimental_builds: false,
  });

export const firmwareStatusDownloading: FirmwareStatusResponse =
  FirmwareStatusResponseSchema.parse({
    state: {
      kind: "downloading",
      latest: "rel-5.17",
      bytes_so_far: 131072,
      total_bytes: 524288,
      percent: 25,
    },
    installed_version: "rel-5.16",
    channel: "stable",
    repo: "sunshine-systems/Firmware-Teensy-4.1",
    board: "teensy-4.1",
    auto_check: true,
    loader_ready: true,
    experimental_builds: false,
  });

export const firmwareStatusReady: FirmwareStatusResponse =
  FirmwareStatusResponseSchema.parse({
    state: {
      kind: "ready",
      latest: "rel-5.17",
      hex_path: "C:\\Users\\J\\AppData\\Local\\StreamCheats\\firmware\\rel-5.17.hex",
      size: 524288,
      sha256: "a".repeat(64),
    },
    installed_version: "rel-5.16",
    channel: "stable",
    repo: "sunshine-systems/Firmware-Teensy-4.1",
    board: "teensy-4.1",
    auto_check: true,
    loader_ready: true,
    experimental_builds: false,
  });

export const firmwareStatusFlashing: FirmwareStatusResponse =
  FirmwareStatusResponseSchema.parse({
    state: {
      kind: "flashing",
      version: "rel-5.17",
      hex_path: "C:\\Users\\J\\AppData\\Local\\StreamCheats\\firmware\\rel-5.17.hex",
      started_at: "2026-05-22T18:05:00Z",
    },
    installed_version: "rel-5.16",
    channel: "stable",
    repo: "sunshine-systems/Firmware-Teensy-4.1",
    board: "teensy-4.1",
    auto_check: true,
    loader_ready: true,
    experimental_builds: false,
  });

export const firmwareStatusFailed: FirmwareStatusResponse =
  FirmwareStatusResponseSchema.parse({
    state: {
      kind: "failed",
      error: "download failed: HTTP 502",
      when: "2026-05-22T18:01:00Z",
    },
    installed_version: "rel-5.16",
    channel: "stable",
    repo: "sunshine-systems/Firmware-Teensy-4.1",
    board: "teensy-4.1",
    auto_check: true,
    loader_ready: true,
    experimental_builds: false,
  });

export const firmwareReleasesPayload: FirmwareReleasesResponse =
  FirmwareReleasesResponseSchema.parse({
    releases: [
      {
        version: "rel-5.17",
        channel: "stable",
        commit: null,
        board: "teensy-4.1",
        published_at: "2026-05-20T12:00:00Z",
        asset_url: "https://example.invalid/rel-5.17.hex",
        asset_name: "teensy-4.1-rel-5.17.hex",
        asset_size: 524288,
        html_url: "https://github.com/example/repo/releases/tag/rel-5.17",
      },
      {
        version: "rel-5.16-ca8298b",
        channel: "nightly",
        commit: "ca8298b",
        board: "teensy-4.1",
        published_at: "2026-05-15T03:21:00Z",
        asset_url: "https://example.invalid/rel-5.16-ca8298b.hex",
        asset_name: "teensy-4.1-rel-5.16-ca8298b.hex",
        asset_size: 524000,
        html_url: null,
      },
    ],
  });

// ---- Experimental -----------------------------------------------------

export const experimentalRegistry: ExperimentalRegistryResponse =
  ExperimentalRegistryResponseSchema.parse({
    apis: [
      {
        id: "kmbox-net",
        name: "KMBox Net",
        description:
          "UDP-based control protocol used by KMBox-compatible third-party tools.",
      },
    ],
  });

export const experimentalStatusDisabled: ExperimentalStatus =
  ExperimentalStatusSchema.parse({
    active: "kmbox-net",
    enabled: false,
    running: false,
    bound: null,
    last_error: null,
  });

export const experimentalStatusRunning: ExperimentalStatus =
  ExperimentalStatusSchema.parse({
    active: "kmbox-net",
    enabled: true,
    running: true,
    bound: "127.0.0.1:14598",
    last_error: null,
  });

// ---- Updater ----------------------------------------------------------

export const updaterStatusIdle: UpdaterStatusResponse =
  UpdaterStatusResponseSchema.parse({
    state: { kind: "idle" },
    experimental_builds: false,
  });

export const updaterStatusAvailable: UpdaterStatusResponse =
  UpdaterStatusResponseSchema.parse({
    state: {
      kind: "available",
      installed: "0.6.3",
      latest: "0.6.4",
      channel: "stable",
      notes_url: "https://github.com/example/repo/releases/tag/v0.6.4",
      asset_url: "https://example.invalid/StreamCheats-0.6.4-Setup.exe",
      asset_size: 12_345_678,
      checked_at: "2026-05-22T18:00:00Z",
    },
    experimental_builds: false,
  });

export const updaterStatusReady: UpdaterStatusResponse =
  UpdaterStatusResponseSchema.parse({
    state: {
      kind: "ready",
      latest: "0.6.4",
      installer_path: "C:\\Users\\J\\AppData\\Local\\Temp\\StreamCheats-0.6.4-Setup.exe",
      size: 12_345_678,
      sha256: "b".repeat(64),
    },
    experimental_builds: false,
  });

// ---- Health -----------------------------------------------------------

export const healthOk: HealthResponse = HealthResponseSchema.parse({
  status: "ok",
  uptime_seconds: 42,
  version: "0.6.3",
});

// ---- Logs -------------------------------------------------------------

export const logEventInfo: LogEvent = LogEventSchema.parse({
  ts: "2026-05-22T18:34:01.234Z",
  level: "INFO",
  line: "daemon: bound on 127.0.0.1:9999",
});

export const logEventWarn: LogEvent = LogEventSchema.parse({
  ts: "2026-05-22T18:34:02.000Z",
  level: "WARN",
  line: "kmbox-net: dropped frame",
});

export const logEventError: LogEvent = LogEventSchema.parse({
  ts: "2026-05-22T18:34:03.000Z",
  level: "ERROR",
  line: "device: heartbeat timeout",
});
