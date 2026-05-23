// useExperimentalStatus hook tests.

import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import {
  useExperimentalActive,
  useExperimentalStatus,
} from "./useExperimentalStatus";
import { experimentalStatusRunning } from "../../test/msw/fixtures";
import { BASE } from "../../test/msw/handlers";
import { server } from "../../test/msw/server";

describe("useExperimentalStatus", () => {
  it("loads registry + status on mount", async () => {
    const { result } = renderHook(() => useExperimentalStatus());

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
      expect(result.current.registry).not.toBeNull();
    });

    expect(result.current.status?.running).toBe(false);
    expect(result.current.registry?.[0].id).toBe("kmbox-net");
  });

  it("enable() flips running=true in the status snapshot", async () => {
    const { result } = renderHook(() => useExperimentalStatus());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    server.use(
      http.post(`${BASE}/api/experimental/enable`, () =>
        HttpResponse.json({ ok: true, status: experimentalStatusRunning })
      )
    );

    let res: { ok: boolean; error?: string } | null = null;
    await act(async () => {
      res = await result.current.enable();
    });
    expect(res).toEqual({ ok: true, error: undefined });
    expect(result.current.status?.running).toBe(true);
  });

  it("disable() flips running back to false", async () => {
    const { result } = renderHook(() => useExperimentalStatus());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    await act(async () => {
      await result.current.enable();
    });
    await act(async () => {
      await result.current.disable();
    });
    expect(result.current.status?.running).toBe(false);
  });

  it("selectApi network failure surfaces a typed error", async () => {
    server.use(
      http.post(`${BASE}/api/experimental/set_active`, () =>
        HttpResponse.error()
      )
    );
    const { result } = renderHook(() => useExperimentalStatus());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let res: { ok: boolean; error?: string } | undefined;
    await act(async () => {
      res = await result.current.selectApi("kmbox-net");
    });
    expect(res).toEqual({ ok: false, error: "network" });
  });
});

describe("useExperimentalActive", () => {
  it("returns true iff the daemon reports running", async () => {
    server.use(
      http.get(`${BASE}/api/experimental/status`, () =>
        HttpResponse.json(experimentalStatusRunning)
      )
    );
    const { result } = renderHook(() => useExperimentalActive());
    await waitFor(() => expect(result.current).toBe(true));
  });
});
