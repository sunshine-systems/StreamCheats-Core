// useFirmwareReleases hook tests. Covers the initial mount fetch +
// the refresh-after-empty contract that backs the Bug 1 fix on
// /updates/firmware.
//
// Bug 1 (firmware list empty on first visit) is fixed at the page
// layer — the page kicks an explicit `/api/firmware/check` when the
// hook lands with an empty list. The hook itself stays a simple
// one-shot fetcher with a refresh() helper, so the page test asserts
// the end-to-end behaviour via this hook + an MSW handler that flips
// the second `/releases` response from empty to populated.

import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { useFirmwareReleases } from "./useFirmwareReleases";
import { firmwareReleasesPayload } from "../../test/msw/fixtures";
import { BASE } from "../../test/msw/handlers";
import { server } from "../../test/msw/server";

describe("useFirmwareReleases", () => {
  it("loads releases on mount", async () => {
    const { result } = renderHook(() => useFirmwareReleases());
    expect(result.current.loaded).toBe(false);
    expect(result.current.releases).toEqual([]);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.releases.length).toBe(
      firmwareReleasesPayload.releases.length
    );
  });

  it("Bug 1 — refresh() picks up the populated list after the daemon's first poll completes", async () => {
    // Mirrors the daemon-staggered-startup race: first fetch returns
    // empty (poller hasn't run yet), then the user / page triggers a
    // refresh and the second fetch returns the populated list.
    let call = 0;
    server.use(
      http.get(`${BASE}/api/firmware/releases`, () => {
        call += 1;
        if (call === 1) return HttpResponse.json({ releases: [] });
        return HttpResponse.json(firmwareReleasesPayload);
      })
    );

    const { result } = renderHook(() => useFirmwareReleases());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.releases).toEqual([]);

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.releases.length).toBe(
      firmwareReleasesPayload.releases.length
    );
  });
});
