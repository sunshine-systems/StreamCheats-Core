"use client";

// Unseen-log tracker.
//
// Public API (SC-11 calls these from the Logs page):
//   useUnseenLogCount()   — number of warn/error events since the
//                           user last visited /logs. Re-renders on
//                           every new event and on the marker reset.
//   useUnseenLogPreview() — up to N most-recent warn/error events
//                           after the last-seen marker, newest last.
//   markLogsSeen()        — bumps the "last seen" timestamp to now;
//                           SC-11 must call this from the /logs page
//                           mount effect so the Home badge resets.
//
// Implementation note: we read the rolling buffer from `useLogStream`
// rather than asking the daemon for an unseen count. The buffer is
// already in memory (capped at 5_000 events) and the Home page is
// alive whenever the badge needs to update, so a pure-client
// derivation is the lowest-friction path. If the buffer wraps before
// the user visits Logs the badge under-counts by definition — that's
// acceptable for an at-a-glance signal and matches what the user can
// actually see in the Logs view anyway.

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  readLastSeen,
  writeLastSeen,
  UNSEEN_LOG_EVENT,
} from "../storage/unseenLog";
import { useLogStream, type LogEvent } from "./useLogStream";

const COUNTED_LEVELS = new Set(["WARN", "ERROR"]);

function isCounted(event: LogEvent): boolean {
  return COUNTED_LEVELS.has(event.level.toUpperCase());
}

/**
 * Bump the "last seen" timestamp to `now`. Call from the /logs page
 * mount effect (SC-11). Safe to call repeatedly.
 */
export function markLogsSeen(): void {
  writeLastSeen(new Date().toISOString());
}

/**
 * Subscribe to the persisted last-seen timestamp. Re-renders when
 * another component in the same tab calls `markLogsSeen()` (via the
 * UNSEEN_LOG_EVENT broadcast) or when a different tab writes to
 * localStorage.
 */
function useLastSeenTs(): string | null {
  const [ts, setTs] = useState<string | null>(() => readLastSeen());

  useEffect(() => {
    const onChange = () => setTs(readLastSeen());
    window.addEventListener(UNSEEN_LOG_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(UNSEEN_LOG_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  return ts;
}

/**
 * Count of warn + error events newer than the last-seen marker.
 *
 * Returns 0 while the log stream is still warming up (empty buffer).
 * When `lastSeen` is null (fresh install) every warn/error in the
 * buffer is counted as unseen.
 */
export function useUnseenLogCount(): number {
  const { events } = useLogStream();
  const lastSeen = useLastSeenTs();

  return useMemo(() => {
    let n = 0;
    for (const e of events) {
      if (!isCounted(e)) continue;
      if (lastSeen == null || e.ts > lastSeen) n += 1;
    }
    return n;
  }, [events, lastSeen]);
}

/**
 * Severity breakdown + a small ordered preview of the most recent
 * unseen warn/error entries. `limit` caps the preview length
 * (default 3). Entries are ordered newest-last to match how they
 * appear in the Logs viewport.
 */
export interface UnseenLogSummary {
  count: number;
  warnCount: number;
  errorCount: number;
  preview: LogEvent[];
}

export function useUnseenLogSummary(limit = 3): UnseenLogSummary {
  const { events } = useLogStream();
  const lastSeen = useLastSeenTs();

  return useMemo(() => {
    let warnCount = 0;
    let errorCount = 0;
    const matches: LogEvent[] = [];
    for (const e of events) {
      if (!isCounted(e)) continue;
      if (lastSeen != null && e.ts <= lastSeen) continue;
      if (e.level.toUpperCase() === "WARN") warnCount += 1;
      else errorCount += 1;
      matches.push(e);
    }
    const preview = matches.slice(-limit);
    return {
      count: warnCount + errorCount,
      warnCount,
      errorCount,
      preview,
    };
  }, [events, lastSeen, limit]);
}

/**
 * Imperative version of `markLogsSeen` returned as a stable callback —
 * convenient when a component needs to pass the reset action down to
 * a child (e.g. a "Mark all read" button).
 */
export function useMarkLogsSeen(): () => void {
  return useCallback(() => markLogsSeen(), []);
}
