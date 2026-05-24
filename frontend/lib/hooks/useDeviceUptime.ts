"use client";

// Tracks how long the StreamCheats device has been "not detected".
//
// We don't have a real device-heartbeat endpoint yet — the daemon's
// loopback connection is the closest proxy. Treat `connected` from
// `useConnectionStatus` as "device is talking to us"; anything else
// (`connecting`, `disconnected`) is "not detected right now".
//
// Returns:
//   * `detected: boolean` — whether the device is currently reachable
//   * `notDetectedFor: number | null` — seconds since the device was
//     last detected. `null` while detected. Begins at page mount when
//     the device was never seen this session.
//   * `notDetectedSince: Date | null` — timestamp when the device
//     transitioned to "not detected" (or page mount if never seen).
//
// Ticks once per second via setInterval — informational, not animation,
// so the 1s cadence is acceptable per SC-7 follow-up spec.

import { useEffect, useState } from "react";

import { useConnectionStatus } from "./useConnectionStatus";

export interface DeviceUptimeState {
  detected: boolean;
  notDetectedSince: Date | null;
  notDetectedFor: number | null;
}

export function useDeviceUptime(): DeviceUptimeState {
  const { status } = useConnectionStatus();
  const detected = status === "connected";

  // `notDetectedSince` is canonical state, not a ref — the timer
  // derivation depends on it, and React's hook-purity rules prohibit
  // reading refs during render. It transitions exactly when the
  // connection status crosses the detected/not-detected boundary.
  const [notDetectedSince, setNotDetectedSince] = useState<Date | null>(
    () => (status === "connected" ? null : new Date())
  );
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    // Anchor flips with the detection state. setState-in-effect is
    // appropriate here: the source of truth (`detected`) lives in a
    // sibling hook subscription, not in component props, so we have
    // to bridge it into our own state. Pattern matches the existing
    // disable in `useConnectionStatus.ts`.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNotDetectedSince((prev) => {
      if (detected) return null;
      // Preserve the existing anchor if we're already in "not
      // detected" — only stamp a new one when we just transitioned.
      return prev ?? new Date();
    });
  }, [detected]);

  // 1s tick while not detected so the elapsed time refreshes. When
  // detected we skip the interval — the value is stable (null).
  useEffect(() => {
    if (detected) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [detected]);

  const notDetectedFor =
    detected || notDetectedSince == null
      ? null
      : Math.max(
          0,
          Math.floor((nowMs - notDetectedSince.getTime()) / 1000)
        );

  return { detected, notDetectedSince, notDetectedFor };
}

/**
 * Format a duration in seconds as `Xs` / `Xm Ys` / `Xh Ym`.
 * Used by the device-status timer per SC-7 follow-up spec.
 */
export function formatDeviceUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "0s";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}
