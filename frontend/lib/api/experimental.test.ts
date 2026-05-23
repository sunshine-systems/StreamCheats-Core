// Per-endpoint tests for the experimental typed client (SC-8).

import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import {
  disable,
  enable,
  getRegistry,
  getStatus,
  setActive,
} from "./experimental";
import {
  ExperimentalActionResponseSchema,
  ExperimentalRegistryResponseSchema,
  ExperimentalStatusSchema,
} from "./schemas";
import {
  experimentalStatusDisabled,
  experimentalStatusRunning,
} from "../../test/msw/fixtures";
import { BASE } from "../../test/msw/handlers";
import { server } from "../../test/msw/server";

describe("experimental.getRegistry", () => {
  it("returns the parsed registry", async () => {
    const got = await getRegistry();
    expect(() => ExperimentalRegistryResponseSchema.parse(got)).not.toThrow();
    expect(got?.apis[0].id).toBe("kmbox-net");
  });

  it("returns null on 500", async () => {
    server.use(
      http.get(`${BASE}/api/experimental/registry`, () =>
        HttpResponse.json({}, { status: 500 })
      )
    );
    expect(await getRegistry()).toBeNull();
  });
});

describe("experimental.getStatus", () => {
  it("parses disabled status", async () => {
    const got = await getStatus();
    expect(() => ExperimentalStatusSchema.parse(got)).not.toThrow();
    expect(got?.running).toBe(false);
  });

  it("parses running status", async () => {
    server.use(
      http.get(`${BASE}/api/experimental/status`, () =>
        HttpResponse.json(experimentalStatusRunning)
      )
    );
    const got = await getStatus();
    expect(got?.running).toBe(true);
    expect(got?.bound).toBe("127.0.0.1:14598");
  });
});

describe("experimental.setActive", () => {
  it("parses the 200 ok envelope", async () => {
    const got = await setActive("kmbox-net");
    expect(() => ExperimentalActionResponseSchema.parse(got)).not.toThrow();
    expect(got?.ok).toBe(true);
  });

  it("parses the 409 listener_running envelope", async () => {
    server.use(
      http.post(`${BASE}/api/experimental/set_active`, () =>
        HttpResponse.json(
          {
            ok: false,
            error: "listener_running",
            status: experimentalStatusRunning,
          },
          { status: 409 }
        )
      )
    );
    const got = await setActive("kmbox-net");
    expect(got?.ok).toBe(false);
    expect(got?.error).toBe("listener_running");
  });
});

describe("experimental.enable / disable", () => {
  it("enable returns running status on success", async () => {
    server.use(
      http.post(`${BASE}/api/experimental/enable`, () =>
        HttpResponse.json({ ok: true, status: experimentalStatusRunning })
      )
    );
    const got = await enable();
    expect(got?.ok).toBe(true);
    expect(got?.status.running).toBe(true);
  });

  it("disable returns disabled status", async () => {
    const got = await disable();
    expect(got?.ok).toBe(true);
    expect(got?.status.running).toBe(false);
  });

  it("enable surfaces 409 with last_error in the status snapshot", async () => {
    server.use(
      http.post(`${BASE}/api/experimental/enable`, () =>
        HttpResponse.json(
          {
            ok: false,
            error: "bind failed: address in use",
            status: {
              ...experimentalStatusDisabled,
              enabled: true,
              last_error: "bind failed: address in use",
            },
          },
          { status: 409 }
        )
      )
    );
    const got = await enable();
    expect(got?.ok).toBe(false);
    expect(got?.status.last_error).toMatch(/bind failed/);
  });
});
