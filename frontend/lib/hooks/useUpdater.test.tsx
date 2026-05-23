// useUpdater hook tests (SC-4 wiring under SC-12 lock-in).

import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { useUpdater } from "./useUpdater";
import {
  updaterStatusAvailable,
  updaterStatusReady,
} from "../../test/msw/fixtures";
import { BASE } from "../../test/msw/handlers";
import { server } from "../../test/msw/server";

describe("useUpdater", () => {
  it("idles on mount", async () => {
    const { result } = renderHook(() => useUpdater());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(result.current.state?.kind).toBe("idle");
    expect(result.current.experimental).toBe(false);
  });

  it("reflects an available release after a check", async () => {
    server.use(
      http.post(`${BASE}/api/updates/check`, () =>
        HttpResponse.json({ state: updaterStatusAvailable.state })
      )
    );
    const { result } = renderHook(() => useUpdater());
    await waitFor(() => expect(result.current.state).not.toBeNull());

    await act(async () => {
      await result.current.runCheck();
    });
    expect(result.current.state?.kind).toBe("available");
    expect(result.current.dismissed).toBe(false);
  });

  it("setNightly persists the echoed flag", async () => {
    const { result } = renderHook(() => useUpdater());
    await waitFor(() => expect(result.current.state).not.toBeNull());

    await act(async () => {
      await result.current.setNightly(true);
    });
    expect(result.current.experimental).toBe(true);
  });

  it("dismiss() flips dismissed=true; re-surfaces on new latest", async () => {
    server.use(
      http.get(`${BASE}/api/updates/status`, () =>
        HttpResponse.json(updaterStatusAvailable)
      )
    );
    const { result } = renderHook(() => useUpdater());
    await waitFor(() => expect(result.current.state?.kind).toBe("available"));

    act(() => {
      result.current.dismiss();
    });
    expect(result.current.dismissed).toBe(true);

    // Bump latest — refresh should clear dismissed.
    server.use(
      http.get(`${BASE}/api/updates/status`, () =>
        HttpResponse.json({
          state: { ...updaterStatusReady.state, latest: "0.6.5" },
          experimental_builds: false,
        })
      )
    );
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.dismissed).toBe(false);
  });

  it("survives 500 without throwing", async () => {
    server.use(
      http.get(`${BASE}/api/updates/status`, () =>
        HttpResponse.json({ error: "boom" }, { status: 500 })
      )
    );
    const { result } = renderHook(() => useUpdater());
    // Wait a tick — refresh fires on mount but state stays null on 500.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(result.current.state).toBeNull();
  });
});
