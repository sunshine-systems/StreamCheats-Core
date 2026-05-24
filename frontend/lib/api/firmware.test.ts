// Per-endpoint tests for the firmware typed client (SC-10 + SC-13).
//
// Every test goes through MSW and asserts the parsed response matches
// the zod schema. Error paths assert the client degrades gracefully
// (returns `null` or a structured `{ ok: false, reason }` shape rather
// than throwing).

import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import {
  cancelFlash,
  checkNow,
  ensureLoader,
  flash,
  flashLocal,
  getReleases,
  getStatus,
  startDownload,
} from "./firmware";
import {
  EnsureLoaderResponseSchema,
  FirmwareCheckResponseSchema,
  FirmwareReleasesResponseSchema,
  FirmwareStatusResponseSchema,
} from "./schemas";
import {
  firmwareReleasesPayload,
  firmwareStatusAvailable,
  firmwareStatusDownloading,
  firmwareStatusFailed,
  firmwareStatusFlashing,
  firmwareStatusIdle,
  firmwareStatusReady,
  firmwareStatusUpToDate,
} from "../../test/msw/fixtures";
import { BASE } from "../../test/msw/handlers";
import { server } from "../../test/msw/server";

describe("firmware.getStatus", () => {
  it("returns the parsed status for every state variant", async () => {
    const variants = [
      firmwareStatusIdle,
      firmwareStatusUpToDate,
      firmwareStatusAvailable,
      firmwareStatusDownloading,
      firmwareStatusReady,
      firmwareStatusFlashing,
      firmwareStatusFailed,
    ];
    for (const fixture of variants) {
      server.use(
        http.get(`${BASE}/api/firmware/status`, () => HttpResponse.json(fixture))
      );
      const got = await getStatus();
      expect(got).not.toBeNull();
      expect(() => FirmwareStatusResponseSchema.parse(got)).not.toThrow();
      expect(got?.state.kind).toBe(fixture.state.kind);
    }
  });

  it("returns null on 500", async () => {
    server.use(
      http.get(`${BASE}/api/firmware/status`, () =>
        HttpResponse.json({ error: "boom" }, { status: 500 })
      )
    );
    expect(await getStatus()).toBeNull();
  });

  it("returns null on network failure", async () => {
    server.use(http.get(`${BASE}/api/firmware/status`, () => HttpResponse.error()));
    expect(await getStatus()).toBeNull();
  });

  it("returns null when the env port is missing", async () => {
    const prev = process.env.NEXT_PUBLIC_STREAMCHEATS_HTTP_PORT;
    delete process.env.NEXT_PUBLIC_STREAMCHEATS_HTTP_PORT;
    try {
      expect(await getStatus()).toBeNull();
    } finally {
      process.env.NEXT_PUBLIC_STREAMCHEATS_HTTP_PORT = prev;
    }
  });
});

describe("firmware.getReleases", () => {
  it("parses a realistic releases list", async () => {
    server.use(
      http.get(`${BASE}/api/firmware/releases`, () =>
        HttpResponse.json(firmwareReleasesPayload)
      )
    );
    const got = await getReleases();
    expect(() => FirmwareReleasesResponseSchema.parse(got)).not.toThrow();
    expect(got?.releases).toHaveLength(2);
    expect(got?.releases[0].channel).toBe("stable");
  });

  it("accepts an empty list", async () => {
    server.use(
      http.get(`${BASE}/api/firmware/releases`, () =>
        HttpResponse.json({ releases: [] })
      )
    );
    const got = await getReleases();
    expect(got?.releases).toEqual([]);
  });
});

describe("firmware.checkNow", () => {
  it("returns the new state", async () => {
    server.use(
      http.post(`${BASE}/api/firmware/check`, () =>
        HttpResponse.json({ state: firmwareStatusAvailable.state })
      )
    );
    const got = await checkNow();
    expect(() => FirmwareCheckResponseSchema.parse(got)).not.toThrow();
    expect(got?.state.kind).toBe("available");
  });
});

describe("firmware.startDownload", () => {
  it("parses 202 { ok: true }", async () => {
    const got = await startDownload("rel-5.17");
    expect(got).toEqual({ ok: true });
  });

  it("surfaces 409 { ok: false, error } bodies", async () => {
    server.use(
      http.post(`${BASE}/api/firmware/download`, () =>
        HttpResponse.json(
          { ok: false, error: "download_in_progress" },
          { status: 409 }
        )
      )
    );
    const got = await startDownload("rel-5.17");
    expect(got).toEqual({ ok: false, error: "download_in_progress" });
  });
});

describe("firmware.flash", () => {
  it("returns ok on 202", async () => {
    expect(await flash("rel-5.17")).toEqual({ ok: true });
  });

  it("maps 501 to not_implemented (legacy daemon path)", async () => {
    server.use(
      http.post(`${BASE}/api/firmware/flash`, () =>
        HttpResponse.text("", { status: 501 })
      )
    );
    expect(await flash("rel-5.17")).toEqual({
      ok: false,
      reason: "not_implemented",
    });
  });

  it("maps known 409 codes to typed reasons", async () => {
    for (const code of [
      "flash_in_progress",
      "hex_not_downloaded",
      "unknown_version",
      "unsupported_board",
    ] as const) {
      server.use(
        http.post(`${BASE}/api/firmware/flash`, () =>
          HttpResponse.json({ ok: false, error: code }, { status: 409 })
        )
      );
      expect(await flash("rel-5.17")).toEqual({ ok: false, reason: code });
    }
  });

  it("peels the human suffix off invalid_hex 409s", async () => {
    server.use(
      http.post(`${BASE}/api/firmware/flash`, () =>
        HttpResponse.json(
          { ok: false, error: "invalid_hex: file is empty" },
          { status: 409 }
        )
      )
    );
    expect(await flash("rel-5.17")).toEqual({
      ok: false,
      reason: "invalid_hex",
      detail: "file is empty",
    });
  });

  it("returns network on fetch failure", async () => {
    server.use(
      http.post(`${BASE}/api/firmware/flash`, () => HttpResponse.error())
    );
    const got = await flash("rel-5.17");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("network");
  });
});

describe("firmware.flashLocal", () => {
  it("returns ok on 202", async () => {
    expect(await flashLocal("C:\\x\\y.hex")).toEqual({ ok: true });
  });

  it("returns network when env port missing", async () => {
    const prev = process.env.NEXT_PUBLIC_STREAMCHEATS_HTTP_PORT;
    delete process.env.NEXT_PUBLIC_STREAMCHEATS_HTTP_PORT;
    try {
      const got = await flashLocal("C:\\x\\y.hex");
      expect(got).toEqual({ ok: false, reason: "network" });
    } finally {
      process.env.NEXT_PUBLIC_STREAMCHEATS_HTTP_PORT = prev;
    }
  });

  it("maps 503 loader_unavailable to a typed reason (SC-14)", async () => {
    server.use(
      http.post(`${BASE}/api/firmware/flash_local`, () =>
        HttpResponse.json(
          { ok: false, error: "loader_unavailable" },
          { status: 503 }
        )
      )
    );
    expect(await flashLocal("C:\\x\\y.hex")).toEqual({
      ok: false,
      reason: "loader_unavailable",
    });
  });
});

// Updates restructure: cancelFlash. Mirrors the flash() tests but the
// surface is smaller — 202 → ok, 409 not_flashing → typed reason,
// network failure → reason: "network".
describe("firmware.cancelFlash", () => {
  it("returns ok on 202", async () => {
    expect(await cancelFlash()).toEqual({ ok: true });
  });

  it("maps 409 not_flashing to a typed reason", async () => {
    server.use(
      http.post(`${BASE}/api/firmware/cancel_flash`, () =>
        HttpResponse.json({ ok: false, error: "not_flashing" }, { status: 409 })
      )
    );
    expect(await cancelFlash()).toEqual({ ok: false, reason: "not_flashing" });
  });

  it("returns network on fetch failure", async () => {
    server.use(
      http.post(`${BASE}/api/firmware/cancel_flash`, () => HttpResponse.error())
    );
    const got = await cancelFlash();
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("network");
  });
});

// SC-14: ensureLoader covers the happy path + each documented error
// code. The schema parse asserts shapes line up with the daemon's
// response (drift in either side fails the test loudly).
describe("firmware.ensureLoader", () => {
  it("returns ready: true on 200", async () => {
    const got = await ensureLoader();
    expect(got.ready).toBe(true);
    // Round-trip through the schema as a contract check.
    expect(() => EnsureLoaderResponseSchema.parse(got)).not.toThrow();
    if (got.ready) {
      expect(got.path).toMatch(/teensy_loader_cli\.exe$/);
      expect(typeof got.sha256_verified).toBe("boolean");
    }
  });

  it("maps 503 loader_url_not_configured", async () => {
    server.use(
      http.post(`${BASE}/api/firmware/ensure_loader`, () =>
        HttpResponse.json(
          {
            ready: false,
            error: "loader_url_not_configured",
            message:
              "Set firmware.loader_url in config.json to a Windows build of teensy_loader_cli.",
          },
          { status: 503 }
        )
      )
    );
    const got = await ensureLoader();
    expect(got).toEqual({
      ready: false,
      error: "loader_url_not_configured",
      message:
        "Set firmware.loader_url in config.json to a Windows build of teensy_loader_cli.",
    });
    expect(() => EnsureLoaderResponseSchema.parse(got)).not.toThrow();
  });

  it("maps 503 sha256_mismatch", async () => {
    server.use(
      http.post(`${BASE}/api/firmware/ensure_loader`, () =>
        HttpResponse.json(
          {
            ready: false,
            error: "sha256_mismatch",
            message: "expected aaa, got bbb",
          },
          { status: 503 }
        )
      )
    );
    const got = await ensureLoader();
    expect(got.ready).toBe(false);
    if (!got.ready) {
      expect(got.error).toBe("sha256_mismatch");
      expect(got.message).toContain("expected");
    }
  });

  it("returns network_error on fetch failure", async () => {
    server.use(
      http.post(`${BASE}/api/firmware/ensure_loader`, () => HttpResponse.error())
    );
    const got = await ensureLoader();
    expect(got).toEqual({
      ready: false,
      error: "network_error",
      message: expect.any(String) as unknown as string,
    });
  });
});
