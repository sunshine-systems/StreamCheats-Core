// Per-endpoint tests for the software updater client (SC-4).

import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import {
  checkNow,
  getStatus,
  installNow,
  setExperimentalBuilds,
  startDownload,
} from "./updater";
import {
  SetExperimentalBuildsResponseSchema,
  UpdaterStatusResponseSchema,
} from "./schemas";
import {
  updaterStatusAvailable,
  updaterStatusReady,
} from "../../test/msw/fixtures";
import { BASE } from "../../test/msw/handlers";
import { server } from "../../test/msw/server";

describe("updater.getStatus", () => {
  it("parses idle", async () => {
    const got = await getStatus();
    expect(() => UpdaterStatusResponseSchema.parse(got)).not.toThrow();
    expect(got?.state.kind).toBe("idle");
  });

  it("parses available", async () => {
    server.use(
      http.get(`${BASE}/api/updates/status`, () =>
        HttpResponse.json(updaterStatusAvailable)
      )
    );
    const got = await getStatus();
    expect(got?.state.kind).toBe("available");
  });

  it("parses ready", async () => {
    server.use(
      http.get(`${BASE}/api/updates/status`, () =>
        HttpResponse.json(updaterStatusReady)
      )
    );
    const got = await getStatus();
    if (got?.state.kind === "ready") {
      expect(got.state.installer_path).toMatch(/Setup\.exe$/);
    } else {
      throw new Error("expected ready state");
    }
  });

  it("returns null on malformed JSON", async () => {
    server.use(
      http.get(`${BASE}/api/updates/status`, () =>
        HttpResponse.text("not json")
      )
    );
    // updater.call swallows JSON parse failures via the try/catch around fetch.
    expect(await getStatus()).toBeNull();
  });
});

describe("updater.checkNow / startDownload / installNow", () => {
  it("checkNow returns the new state", async () => {
    const got = await checkNow();
    expect(got?.state.kind).toBe("idle");
  });

  it("startDownload parses 202", async () => {
    expect(await startDownload()).toEqual({ ok: true });
  });

  it("installNow returns installer_path", async () => {
    const got = await installNow();
    expect(got?.ok).toBe(true);
    expect(got?.installer_path).toBeTruthy();
  });
});

describe("updater.setExperimentalBuilds", () => {
  it("echoes the enabled flag", async () => {
    const got = await setExperimentalBuilds(true);
    expect(() => SetExperimentalBuildsResponseSchema.parse(got)).not.toThrow();
    expect(got?.enabled).toBe(true);

    const got2 = await setExperimentalBuilds(false);
    expect(got2?.enabled).toBe(false);
  });

  it("surfaces 500 persist failure", async () => {
    server.use(
      http.post(`${BASE}/api/settings/experimental_builds`, () =>
        HttpResponse.json(
          { ok: false, enabled: true, error: "persist failed: ..." },
          { status: 500 }
        )
      )
    );
    // The client's call() drops non-2xx (except 202/409) → returns null.
    expect(await setExperimentalBuilds(true)).toBeNull();
  });
});
