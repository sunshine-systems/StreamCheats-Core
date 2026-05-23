// useFirmwareStatus hook tests — assert state transitions through
// MSW-mocked status snapshots and that the imperative helpers
// (runCheck, runDownload) interact with the right endpoints.

import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { useFirmwareStatus } from "./useFirmwareStatus";
import {
  firmwareStatusAvailable,
  firmwareStatusIdle,
  firmwareStatusReady,
} from "../../test/msw/fixtures";
import { BASE } from "../../test/msw/handlers";
import { server } from "../../test/msw/server";

describe("useFirmwareStatus", () => {
  it("loads the initial status on mount", async () => {
    const { result } = renderHook(() => useFirmwareStatus());
    expect(result.current.status).toBeNull();
    expect(result.current.loaded).toBe(false);

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });
    expect(result.current.status?.state.kind).toBe("idle");
  });

  it("reflects a check that flips the state to available", async () => {
    const { result } = renderHook(() => useFirmwareStatus());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    // After the check the daemon goes available.
    server.use(
      http.post(`${BASE}/api/firmware/check`, () =>
        HttpResponse.json({ state: firmwareStatusAvailable.state })
      ),
      http.get(`${BASE}/api/firmware/status`, () =>
        HttpResponse.json(firmwareStatusAvailable)
      )
    );

    await act(async () => {
      await result.current.runCheck();
    });

    expect(result.current.status?.state.kind).toBe("available");
    expect(result.current.busy).toBe(false);
  });

  it("runDownload surfaces 202 ok shape", async () => {
    const { result } = renderHook(() => useFirmwareStatus());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let downloadResult: { ok: boolean; error?: string } | null = null;
    await act(async () => {
      downloadResult = await result.current.runDownload("rel-5.17");
    });
    expect(downloadResult).toEqual({ ok: true });
  });

  it("survives a 500 — exposes loaded=true and status=null", async () => {
    server.use(
      http.get(`${BASE}/api/firmware/status`, () =>
        HttpResponse.json({ error: "boom" }, { status: 500 })
      )
    );
    const { result } = renderHook(() => useFirmwareStatus());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.status).toBeNull();
  });

  it("preserves outer status fields on a successful check", async () => {
    server.use(
      http.get(`${BASE}/api/firmware/status`, () =>
        HttpResponse.json(firmwareStatusIdle)
      )
    );
    const { result } = renderHook(() => useFirmwareStatus());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const initialRepo = result.current.status?.repo;

    server.use(
      http.post(`${BASE}/api/firmware/check`, () =>
        HttpResponse.json({ state: firmwareStatusReady.state })
      )
    );
    await act(async () => {
      await result.current.runCheck();
    });
    // repo persists across the check — runCheck folds new state into
    // the existing snapshot rather than replacing it wholesale.
    expect(result.current.status?.repo).toBe(initialRepo);
  });
});
