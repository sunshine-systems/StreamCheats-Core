"use client";

// Hook owning the in-app updater UI state. Polls
// `GET /api/updates/status` every 30 s so the banner reflects the
// background poller's progress, plus exposes imperative helpers
// (check / download / install / toggle nightly) that the banner and
// settings UI bind to buttons.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  checkNow,
  getStatus,
  installNow,
  setExperimentalBuilds,
  startDownload,
  UpdaterState,
} from "../api/updater";

const POLL_INTERVAL_MS = 60_000;

export interface UpdaterSnapshot {
  state: UpdaterState | null;
  experimental: boolean;
  dismissed: boolean;
}

export function useUpdater() {
  const [state, setState] = useState<UpdaterState | null>(null);
  const [experimental, setExperimental] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelledRef = useRef(false);
  const versionRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const r = await getStatus();
    if (cancelledRef.current) return;
    if (r) {
      setState(r.state);
      setExperimental(r.experimental_builds);
      // Re-surface the banner if the "latest" version changed since
      // the user dismissed it (e.g. a new release dropped).
      const latest =
        r.state.kind === "available" || r.state.kind === "ready"
          ? r.state.latest
          : undefined;
      if (latest !== versionRef.current) {
        versionRef.current = latest;
        setDismissed(false);
      }
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    // Initial refresh on mount is intentional — we want the banner /
    // settings to reflect the daemon's current updater state without
    // waiting POLL_INTERVAL_MS for the first interval tick. The
    // setState-in-effect rule fires because refresh() calls setState
    // synchronously after a fetch; the cascade is gated by the
    // network round-trip and `cancelledRef`, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [refresh]);

  const runCheck = useCallback(async () => {
    setBusy(true);
    try {
      const r = await checkNow();
      if (r) setState(r.state);
    } finally {
      setBusy(false);
    }
  }, []);

  const runDownload = useCallback(async () => {
    setBusy(true);
    try {
      const r = await startDownload();
      if (!r?.ok) {
        // Try a refresh to surface whatever the new state is.
        await refresh();
      } else {
        // Start polling more aggressively while the download is in flight.
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const runInstall = useCallback(async () => {
    setBusy(true);
    try {
      await installNow();
      // Don't refresh — the daemon is shutting down. The UI will
      // close imminently.
    } finally {
      setBusy(false);
    }
  }, []);

  const setNightly = useCallback(async (enabled: boolean) => {
    setBusy(true);
    try {
      const r = await setExperimentalBuilds(enabled);
      if (r) setExperimental(r.enabled);
    } finally {
      setBusy(false);
    }
  }, []);

  const dismiss = useCallback(() => setDismissed(true), []);

  // Faster polling while the download is in flight so the percent
  // visibly advances.
  useEffect(() => {
    if (state?.kind !== "downloading") return;
    const id = setInterval(refresh, 1_000);
    return () => clearInterval(id);
  }, [state?.kind, refresh]);

  return {
    state,
    experimental,
    dismissed,
    busy,
    refresh,
    runCheck,
    runDownload,
    runInstall,
    setNightly,
    dismiss,
  };
}
