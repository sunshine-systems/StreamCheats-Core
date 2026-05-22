"use client";

// Polls `window.streamcheats.healthDetail()` every 4s and exposes the full
// daemon snapshot (pid, port, version, uptime) used by the status rail.
//
// Independent of useConnectionStatus on purpose — the simple pill only
// needs ok/not-ok at 2 s, the rail wants richer data at a calmer cadence.
// When the detail bridge is missing (older preload) the hook returns
// null forever and the rail falls back to a "—" placeholder.

import { useEffect, useRef, useState } from "react";

import { getBridge } from "../api/client";

export interface HealthDetail {
  pid: number | null;
  port: number;
  version: string | null;
  uptimeSeconds: number | null;
}

const POLL_INTERVAL_MS = 4000;

export function useHealthDetail(): HealthDetail | null {
  const [detail, setDetail] = useState<HealthDetail | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const bridge = getBridge();
    if (!bridge || !bridge.healthDetail) {
      return () => {
        cancelledRef.current = true;
      };
    }

    let timer: ReturnType<typeof setTimeout> | null = null;

    const runOnce = async () => {
      try {
        const res = await bridge.healthDetail!();
        if (cancelledRef.current) return;
        if (res && res.ok) {
          setDetail({
            pid: res.pid,
            port: res.port,
            version: res.version,
            uptimeSeconds: res.uptimeSeconds,
          });
        } else {
          setDetail(null);
        }
      } catch {
        if (!cancelledRef.current) setDetail(null);
      }
      if (!cancelledRef.current) {
        timer = setTimeout(runOnce, POLL_INTERVAL_MS);
      }
    };

    runOnce();

    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return detail;
}

/** Format an uptime in seconds as a compact `1d 03:14:22` / `03:14:22` / `14:22`. */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (days > 0) return `${days}d ${pad(hours)}:${pad(mins)}:${pad(secs)}`;
  if (hours > 0) return `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
  return `${pad(mins)}:${pad(secs)}`;
}
