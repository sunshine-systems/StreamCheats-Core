"use client";

// Fetches `GET /api/firmware/releases` once on mount and exposes a
// refetch helper so the Updates page can refresh the list after a
// "Check for updates" tap. The list is small (assumed <200 entries
// for the foreseeable future per SC-10), so we don't paginate or
// poll — the daemon's poller refreshes its cache on its own cadence
// and the UI re-reads on user gestures.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  getReleases,
  type FirmwareReleaseEntry,
} from "../api/firmware";

export interface FirmwareReleasesSnapshot {
  releases: FirmwareReleaseEntry[];
  loaded: boolean;
  refresh: () => Promise<void>;
}

export function useFirmwareReleases(): FirmwareReleasesSnapshot {
  const [releases, setReleases] = useState<FirmwareReleaseEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    const r = await getReleases();
    if (cancelledRef.current) return;
    setReleases(r?.releases ?? []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    // Kick off the initial fetch on mount. refresh() is async and
    // only setStates after the await, so this doesn't trip the
    // set-state-in-effect rule.
    void refresh();
    return () => {
      cancelledRef.current = true;
    };
  }, [refresh]);

  return { releases, loaded, refresh };
}
