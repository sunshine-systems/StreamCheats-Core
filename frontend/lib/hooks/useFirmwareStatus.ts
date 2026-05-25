"use client";

// Polls `GET /api/firmware/status` on the same 30s cadence as
// `useUpdater`. Surfaces the daemon's firmware state + the heartbeat-
// derived installed version + the experimental-builds toggle so the
// Updates page can render both halves of the firmware UI off one hook.
//
// While a firmware download is in flight we tighten the poll to 1s so
// the progress bar advances visibly — same pattern as `useUpdater`.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  checkNow,
  getStatus,
  startDownload,
  type FirmwareStatusResponse,
  type FirmwareState,
} from "../api/firmware";

const POLL_INTERVAL_MS = 60_000;
const ACTIVE_POLL_INTERVAL_MS = 1_000;

export interface FirmwareStatusSnapshot {
  status: FirmwareStatusResponse | null;
  busy: boolean;
  /** True after the first fetch attempt completes (success OR null). */
  loaded: boolean;
  refresh: () => Promise<void>;
  runCheck: () => Promise<void>;
  runDownload: (version: string) => Promise<{ ok: boolean; error?: string } | null>;
}

export function useFirmwareStatus(): FirmwareStatusSnapshot {
  const [status, setStatus] = useState<FirmwareStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    const r = await getStatus();
    if (cancelledRef.current) return;
    setStatus(r);
    setLoaded(true);
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    // Initial fetch on mount so the page doesn't blank-render for the
    // full poll interval. refresh() is async and only setStates
    // after the network round-trip, so this doesn't trip the
    // set-state-in-effect rule.
    void refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [refresh]);

  // Tighter polling while a download OR flash is in flight so the
  // progress / elapsed-time UI doesn't feel frozen between 30s ticks.
  // Same 1s cadence as the software updater's downloading window.
  const kind: FirmwareState["kind"] | undefined = status?.state.kind;
  useEffect(() => {
    if (kind !== "downloading" && kind !== "flashing") return;
    const id = setInterval(refresh, ACTIVE_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [kind, refresh]);

  const runCheck = useCallback(async () => {
    setBusy(true);
    try {
      const r = await checkNow();
      if (r) {
        // /api/firmware/check only returns `{ state }` — fold it into
        // the existing status snapshot so we keep installed_version
        // and the other fields intact.
        setStatus((prev) => (prev ? { ...prev, state: r.state } : prev));
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const runDownload = useCallback(
    async (version: string) => {
      setBusy(true);
      try {
        const r = await startDownload(version);
        await refresh();
        return r;
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  return { status, busy, loaded, refresh, runCheck, runDownload };
}
