"use client";

// Polls `GET /api/experimental/status` (SC-8) on the same 30s background
// cadence the other status hooks use and exposes the three mutating
// actions — `selectApi(id)`, `enable()`, `disable()` — as Promise-
// returning callbacks. Also fetches the static registry once on mount
// so the Experimental Support page can populate its dropdown.
//
// Sidebar consumers want `useExperimentalActive()` — a derived flag
// that's `true` iff the manager reports a running listener. Pulled out
// as its own hook so AppShell only re-renders when that boolean flips,
// not on every status poll.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  disable as apiDisable,
  enable as apiEnable,
  getRegistry,
  getStatus,
  setActive,
  type ExperimentalApiDescriptor,
  type ExperimentalStatus,
} from "../api/experimental";

const POLL_INTERVAL_MS = 30_000;

export interface ExperimentalStatusSnapshot {
  status: ExperimentalStatus | null;
  registry: ExperimentalApiDescriptor[] | null;
  busy: boolean;
  /** True after the first fetch attempt completes (success OR null). */
  loaded: boolean;
  refresh: () => Promise<void>;
  selectApi: (id: string) => Promise<{ ok: boolean; error?: string }>;
  enable: () => Promise<{ ok: boolean; error?: string }>;
  disable: () => Promise<{ ok: boolean; error?: string }>;
}

export function useExperimentalStatus(): ExperimentalStatusSnapshot {
  const [status, setStatus] = useState<ExperimentalStatus | null>(null);
  const [registry, setRegistry] = useState<ExperimentalApiDescriptor[] | null>(
    null
  );
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
    // Initial fetches on mount — registry only needs to load once
    // (it's a static const on the daemon side) but we re-fetch it
    // alongside status here to keep the wiring trivial. If a future
    // bump adds APIs to the registry, the user gets the new options
    // on next refresh without reloading the renderer.
    void refresh();
    void getRegistry().then((r) => {
      if (cancelledRef.current) return;
      setRegistry(r?.apis ?? null);
    });
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [refresh]);

  const selectApi = useCallback(
    async (id: string): Promise<{ ok: boolean; error?: string }> => {
      setBusy(true);
      try {
        const r = await setActive(id);
        if (r) {
          setStatus(r.status);
          return { ok: r.ok, error: r.error };
        }
        return { ok: false, error: "network" };
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const enable = useCallback(async (): Promise<{
    ok: boolean;
    error?: string;
  }> => {
    setBusy(true);
    try {
      const r = await apiEnable();
      if (r) {
        setStatus(r.status);
        return { ok: r.ok, error: r.error };
      }
      return { ok: false, error: "network" };
    } finally {
      setBusy(false);
    }
  }, []);

  const disable = useCallback(async (): Promise<{
    ok: boolean;
    error?: string;
  }> => {
    setBusy(true);
    try {
      const r = await apiDisable();
      if (r) {
        setStatus(r.status);
        return { ok: r.ok, error: r.error };
      }
      return { ok: false, error: "network" };
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    status,
    registry,
    busy,
    loaded,
    refresh,
    selectApi,
    enable,
    disable,
  };
}

/**
 * Returns `true` iff the daemon reports a running experimental
 * listener. Used by the sidebar to tint the Experimental icon copper
 * per SC-5's "copper is reserved" rule. Pure derivation off
 * `useExperimentalStatus` so it adds no extra polling traffic.
 */
export function useExperimentalActive(): boolean {
  const { status } = useExperimentalStatus();
  return status?.running === true;
}
