// Contract drift signal — SC-12 lock-in.
//
// Each test parses a hand-built JSON payload that mirrors the exact
// shape the Rust daemon emits (per the serde-tagged enums in
// backend/src/firmware/mod.rs, backend/src/updater/mod.rs,
// backend/src/experimental/mod.rs, etc.) under the corresponding zod
// schema. If a daemon ticket changes a field name, removes a variant,
// or flips a type, the parse here fails loudly and the PR build
// breaks — exactly the regression signal SC-12 is asking for.
//
// When a schema legitimately needs to change, both this file AND the
// schema get updated in the same commit. See `test/CONTRACT.md` for
// the manual review checklist.

import { describe, expect, it } from "vitest";

import {
  ExperimentalActionResponseSchema,
  ExperimentalRegistryResponseSchema,
  ExperimentalStatusSchema,
  FirmwareReleasesResponseSchema,
  FirmwareStateSchema,
  FirmwareStatusResponseSchema,
  HealthResponseSchema,
  LogEventSchema,
  LogLaggedFrameSchema,
  LogStreamFrameSchema,
  SetExperimentalBuildsResponseSchema,
  UpdaterStateSchema,
  UpdaterStatusResponseSchema,
} from "../lib/api/schemas";

describe("firmware contract", () => {
  it("accepts all six State variants verbatim from the daemon", () => {
    // Each payload below is what `serde_json::to_value(&State::*)` produces
    // for the corresponding `FirmwareUpdater::State` arm.
    const variants = [
      { kind: "idle" },
      {
        kind: "up_to_date",
        installed: "rel-5.17",
        checked_at: "2026-05-22T18:00:00Z",
      },
      {
        kind: "available",
        installed: "rel-5.16",
        latest: "rel-5.17",
        channel: "stable",
        notes_url: null,
        asset_url: "https://x/y.hex",
        asset_name: "y.hex",
        asset_size: 1024,
        checked_at: "2026-05-22T18:00:00Z",
      },
      {
        kind: "downloading",
        latest: "rel-5.17",
        bytes_so_far: 0,
        total_bytes: null,
        percent: null,
      },
      {
        kind: "ready",
        latest: "rel-5.17",
        hex_path: "C:\\x\\y.hex",
        size: 1024,
        sha256: "deadbeef".repeat(8),
      },
      {
        kind: "flashing",
        version: "rel-5.17",
        hex_path: "C:\\x\\y.hex",
        started_at: "2026-05-22T18:05:00Z",
      },
      {
        kind: "failed",
        error: "boom",
        when: "2026-05-22T18:00:00Z",
      },
    ];
    for (const v of variants) {
      expect(() => FirmwareStateSchema.parse(v)).not.toThrow();
    }
  });

  it("rejects an unknown State kind", () => {
    expect(() =>
      FirmwareStateSchema.parse({ kind: "exploding", error: "lol" })
    ).toThrow();
  });

  it("status response carries installed_version (nullable) + repo + channel + auto_check + loader_ready", () => {
    const parsed = FirmwareStatusResponseSchema.parse({
      state: { kind: "idle" },
      installed_version: null,
      channel: "unknown",
      repo: "sunshine-systems/Teensy-Core-1.59.0",
      board: null,
      auto_check: true,
      experimental_builds: false,
      // SC-14: loader_ready is required — drift signal for the pre-
      // flight loader-download UX.
      loader_ready: false,
    });
    expect(parsed.installed_version).toBeNull();
    expect(parsed.auto_check).toBe(true);
    expect(parsed.loader_ready).toBe(false);
  });

  it("rejects status with a missing required field (drift signal)", () => {
    expect(() =>
      FirmwareStatusResponseSchema.parse({
        // installed_version omitted — should fail.
        state: { kind: "idle" },
        channel: "unknown",
        repo: "x",
        board: null,
        auto_check: true,
        experimental_builds: false,
      })
    ).toThrow();
  });

  it("releases payload accepts an empty list", () => {
    expect(() =>
      FirmwareReleasesResponseSchema.parse({ releases: [] })
    ).not.toThrow();
  });
});

describe("experimental contract", () => {
  it("registry mirrors the Rust REGISTRY const exactly", () => {
    expect(() =>
      ExperimentalRegistryResponseSchema.parse({
        apis: [
          {
            id: "kmbox-net",
            name: "KMBox Net",
            description:
              "UDP-based control protocol used by KMBox-compatible third-party tools.",
          },
        ],
      })
    ).not.toThrow();
  });

  it("status accepts bound = null when stopped", () => {
    const parsed = ExperimentalStatusSchema.parse({
      active: "kmbox-net",
      enabled: false,
      running: false,
      bound: null,
      last_error: null,
    });
    expect(parsed.running).toBe(false);
  });

  it("action response envelope: ok + status + optional error", () => {
    expect(() =>
      ExperimentalActionResponseSchema.parse({
        ok: false,
        error: "listener_running",
        status: {
          active: "kmbox-net",
          enabled: true,
          running: true,
          bound: "127.0.0.1:14598",
          last_error: null,
        },
      })
    ).not.toThrow();
  });
});

describe("updater contract", () => {
  it("accepts all six UpdaterState variants verbatim", () => {
    const variants = [
      { kind: "idle" },
      {
        kind: "up_to_date",
        installed: "0.6.3",
        checked_at: "2026-05-22T18:00:00Z",
      },
      {
        kind: "available",
        installed: "0.6.3",
        latest: "0.6.4",
        channel: "stable",
        notes_url: null,
        asset_url: "https://x/setup.exe",
        asset_size: 1234,
        checked_at: "2026-05-22T18:00:00Z",
      },
      {
        kind: "downloading",
        latest: "0.6.4",
        bytes_so_far: 0,
        total_bytes: null,
        percent: null,
      },
      {
        kind: "ready",
        latest: "0.6.4",
        installer_path: "C:\\tmp\\setup.exe",
        size: 1234,
        sha256: "a".repeat(64),
      },
      {
        kind: "failed",
        error: "boom",
        when: "2026-05-22T18:00:00Z",
      },
    ];
    for (const v of variants) {
      expect(() => UpdaterStateSchema.parse(v)).not.toThrow();
    }
  });

  it("status response wraps state + experimental_builds", () => {
    expect(() =>
      UpdaterStatusResponseSchema.parse({
        state: { kind: "idle" },
        experimental_builds: true,
      })
    ).not.toThrow();
  });

  it("set_experimental response carries ok + enabled", () => {
    expect(() =>
      SetExperimentalBuildsResponseSchema.parse({
        ok: true,
        enabled: true,
      })
    ).not.toThrow();
  });
});

describe("health contract", () => {
  it("/health is { status: 'ok', uptime_seconds, version }", () => {
    expect(() =>
      HealthResponseSchema.parse({
        status: "ok",
        uptime_seconds: 0,
        version: "0.6.3",
      })
    ).not.toThrow();
  });
});

describe("log stream contract", () => {
  it("regular event has ts + level + line", () => {
    expect(() =>
      LogEventSchema.parse({
        ts: "2026-05-22T18:34:01.234Z",
        level: "INFO",
        line: "hello",
      })
    ).not.toThrow();
  });

  it("lagged control frame is recognised by the discriminated union", () => {
    expect(() =>
      LogLaggedFrameSchema.parse({ type: "lagged", count: 7 })
    ).not.toThrow();
    expect(() =>
      LogStreamFrameSchema.parse({ type: "lagged", count: 7 })
    ).not.toThrow();
    expect(() =>
      LogStreamFrameSchema.parse({
        ts: "2026-05-22T18:34:01.234Z",
        level: "INFO",
        line: "hello",
      })
    ).not.toThrow();
  });
});
