"use client";

// Fires `POST /api/logs/mark_seen` once on mount so the Home page's
// unseen warning/error badge clears when the user visits /logs.
//
// The endpoint is owned by SC-7 (Home page implementation). SC-11 ships
// independently of SC-7, so this hook MUST tolerate the endpoint being
// missing — a 404 or network error is treated as a graceful no-op, not
// a user-visible failure. Once SC-7 merges this just starts working.

import { useEffect } from "react";

import { getBridge } from "../api/client";

export function useMarkLogsSeen(): void {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const url = await resolveMarkSeenUrl();
      if (cancelled || !url) return;
      try {
        const resp = await fetch(url, { method: "POST" });
        if (cancelled) return;
        if (resp.status === 404) {
          // Endpoint not deployed yet (SC-7 hasn't merged). Quiet no-op.
          console.warn(
            "[logs] mark_seen endpoint not available yet (SC-7 pending); badge will not clear."
          );
          return;
        }
        if (!resp.ok) {
          console.warn(`[logs] mark_seen returned HTTP ${resp.status}`);
        }
      } catch (e) {
        console.warn("[logs] mark_seen request failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}

async function resolveMarkSeenUrl(): Promise<string | null> {
  const bridge = getBridge();
  if (bridge?.getBackendUrl) {
    try {
      const res = await bridge.getBackendUrl();
      if (res.ok) return `${res.http}/api/logs/mark_seen`;
    } catch {
      /* fall through to env fallback */
    }
  }
  const envPort =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_STREAMCHEATS_HTTP_PORT
      : undefined;
  if (envPort) return `http://127.0.0.1:${envPort}/api/logs/mark_seen`;
  return null;
}
