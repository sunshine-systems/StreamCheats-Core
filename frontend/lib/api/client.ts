// Tiny API client. Detects whether we're running inside Electron via
// `window.streamcheats`; falls back to a plain `fetch` against the local
// daemon when running in a browser (for dev with `next dev` against a
// daemon you started manually).
//
// All real callers should go through the typed helpers in
// `./bug-report.ts` — this file just owns the runtime detection and
// the fetch-based fallback.

import { BugReportError } from "./errors";

export interface StreamCheatsBridge {
  bugReport: () => Promise<BridgeBugReportResult>;
  healthCheck: () => Promise<BridgeHealthCheckResult>;
  healthDetail?: () => Promise<BridgeHealthDetailResult>;
  getBackendUrl?: () => Promise<BridgeBackendUrlResult>;
  /**
   * SC-13: native .hex file picker for the manual-flash card. Only
   * present when the renderer is loaded inside the Electron shell —
   * web-only dev runs see `undefined` here.
   */
  pickHexFile?: () => Promise<BridgePickHexFileResult>;
}

/** Shape returned by `window.streamcheats.pickHexFile()`. Never throws. */
export type BridgePickHexFileResult =
  | { ok: true; path: string }
  | { ok: false; reason: "cancelled" | "unavailable" };

/** Shape returned by `window.streamcheats.getBackendUrl()`. Never throws. */
export type BridgeBackendUrlResult =
  | { ok: true; http: string; ws: string; port: number }
  | { ok: false; reason: "no_port_file" };

/**
 * Shape returned by `window.streamcheats.healthCheck()`. Never throws. The
 * `reason` field is only present on failures so the renderer can render
 * a tooltip distinguishing "daemon never started" (`no_port_file`) from
 * "daemon ran but is unresponsive" (`probe_failed`).
 */
export type BridgeHealthCheckResult =
  | { ok: true }
  | { ok: false; reason?: "no_port_file" | "probe_failed"; port?: number };

/** Shape returned by `window.streamcheats.healthDetail()`. Never throws. */
export type BridgeHealthDetailResult =
  | {
      ok: true;
      pid: number | null;
      port: number;
      version: string | null;
      uptimeSeconds: number | null;
    }
  | { ok: false };

/** Shape returned by the Electron preload bridge. */
export type BridgeBugReportResult =
  | {
      ok: true;
      savedTo: string;
      fellBack?: boolean;
    }
  | {
      ok: false;
      error:
        | "file_logging_disabled"
        | "http_port_unavailable"
        | "network"
        | "timeout"
        | "unknown";
      detail?: string;
    };

declare global {
  interface Window {
    streamcheats?: StreamCheatsBridge;
  }
}

/**
 * Returns the live bridge or `null` when not running inside Electron.
 * Centralised so a future renames (`window.electron` etc.) only touch
 * this file.
 */
export function getBridge(): StreamCheatsBridge | null {
  if (typeof window === "undefined") return null;
  return window.streamcheats ?? null;
}

/**
 * Browser-fallback path: hit the daemon's HTTP endpoint directly. Only
 * usable in `pnpm dev` while a daemon is also running on the same box
 * AND its HTTP port is exposed via env var. Production (inside
 * Electron) always goes through the bridge.
 *
 * The dev port comes from `NEXT_PUBLIC_STREAMCHEATS_HTTP_PORT` — Next.js
 * inlines NEXT_PUBLIC_* values at build time. With no env var set we
 * throw a typed error so the hook can surface "couldn't reach backend".
 */
export async function fallbackBugReport(): Promise<BridgeBugReportResult> {
  const port = process.env.NEXT_PUBLIC_STREAMCHEATS_HTTP_PORT;
  if (!port) {
    throw new BugReportError(
      "http_port_unavailable",
      "no NEXT_PUBLIC_STREAMCHEATS_HTTP_PORT set and not running inside Electron"
    );
  }
  let resp: Response;
  try {
    resp = await fetch(`http://127.0.0.1:${port}/bug-report`, {
      method: "POST",
    });
  } catch (e) {
    throw new BugReportError(
      "network",
      e instanceof Error ? e.message : "fetch failed"
    );
  }
  if (resp.status === 400) {
    let parsed: { error?: string } = {};
    try {
      parsed = (await resp.json()) as { error?: string };
    } catch {
      /* ignore */
    }
    if (parsed.error === "file_logging_disabled") {
      return { ok: false, error: "file_logging_disabled" };
    }
    return { ok: false, error: "unknown", detail: `HTTP 400` };
  }
  if (!resp.ok) {
    return {
      ok: false,
      error: "unknown",
      detail: `HTTP ${resp.status}`,
    };
  }
  // In browser fallback we can't save to Desktop; trigger a blob
  // download so dev mode still produces something inspectable.
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const cd = resp.headers.get("content-disposition") ?? "";
  const m = /filename="([^"]+)"/.exec(cd);
  a.download = m ? m[1] : "streamcheats_bug_report.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { ok: true, savedTo: a.download };
}
