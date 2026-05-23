// localStorage-backed marker for the most recently "seen" log entry.
//
// The Home page renders an "unseen warnings/errors" badge whose count
// is derived from `useLogStream().events` filtered against the
// timestamp stored here. Visiting `/logs` calls `markLogsSeen()` which
// bumps the marker to "now" so the badge resets.
//
// Storage is best-effort: a missing / corrupted value is treated as
// "never seen", which matches the desired UX (a fresh install shows
// every warning/error currently in the ring buffer).
//
// Stored format: ISO-8601 UTC string. We intentionally avoid a numeric
// sequence number — the backend's log events are keyed by RFC 3339
// timestamps (`LogEvent.ts`) so a string compare is sufficient and
// survives the daemon restarting (where any in-memory sequence would
// reset).

const STORAGE_KEY = "sc.unseenLog.lastSeenTs";

/**
 * Read the most recently persisted "last seen" timestamp.
 * Returns `null` when nothing has been stored yet, or when the value
 * is unreadable (private-mode storage failure, corrupted value, etc).
 */
export function readLastSeen(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (!v) return null;
    // Sanity check: must parse as a Date. Reject anything else so a
    // bad value can't poison comparisons forever.
    if (Number.isNaN(Date.parse(v))) return null;
    return v;
  } catch {
    return null;
  }
}

/**
 * Persist `iso` as the new "last seen" timestamp. Pass `null` to
 * clear the marker (treats every log entry as unseen).
 *
 * Emits a `storage`-shaped CustomEvent on `window` so other hook
 * instances in the same tab (e.g. the Home page badge mounted at the
 * same time as Logs) react immediately — the native `storage` event
 * only fires across tabs.
 */
export function writeLastSeen(iso: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (iso == null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, iso);
    }
    window.dispatchEvent(
      new CustomEvent(UNSEEN_LOG_EVENT, { detail: { value: iso } })
    );
  } catch {
    // Storage may be unavailable (private mode, quota); silently
    // degrade — the badge will simply not reset across reloads.
  }
}

/** Name of the in-tab change event broadcast by `writeLastSeen`. */
export const UNSEEN_LOG_EVENT = "sc:unseen-log-changed";

/** localStorage key — exported for tests. */
export const UNSEEN_LOG_STORAGE_KEY = STORAGE_KEY;
