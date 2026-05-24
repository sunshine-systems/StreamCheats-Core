"use client";

// Tracks how long the StreamCheats device has been "not detected".
//
// Source of truth is the daemon's heartbeat-derived
// `installed_version` field on `GET /api/firmware/status`. The
// firmware module declares the device `Unknown` after
// `HEARTBEAT_TIMEOUT` (10s) without a `V:` heartbeat reply — at that
// point `installed_version` flips to `null` and we treat the device
// as not detected. This is the real serial-device heartbeat, NOT the
// daemon loopback connection (`useConnectionStatus`) which only
// reports whether the local HTTP server is reachable.
//
// Loading state: while the very first firmware status fetch is in
// flight we report `detected: false, notDetectedFor: 0` so the chip
// shows "Detecting…" rather than briefly flashing "Not detected".
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

import { useFirmwareStatus } from "./useFirmwareStatus";

export interface DeviceUptimeState {
  detected: boolean;
  notDetectedSince: Date | null;
  notDetectedFor: number | null;
}

export function useDeviceUptime(): DeviceUptimeState {
  const { status, loaded } = useFirmwareStatus();
  // `installed_version !== null` <=> heartbeat seen within the
  // backend's HEARTBEAT_TIMEOUT (10s). Until the first poll lands we
  // optimistically treat the device as not detected so the UI shows
  // "Detecting…" rather than flashing "Connected" before truth arrives.
  const detected = loaded && status?.installed_version != null;

  // `notDetectedSince` is canonical state, not a ref — the timer
  // derivation depends on it, and React's hook-purity rules prohibit
  // reading refs during render. It transitions exactly when the
  // detection state crosses the boundary.
  const [notDetectedSince, setNotDetectedSince] = useState<Date | null>(
    () => (detected ? null : new Date())
  );
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    // Anchor flips with the detection state. setState-in-effect is
    // appropriate here: the source of truth (`detected`) lives in a
    // sibling hook subscription, not in component props, so we have
    // to bridge it into our own state.
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
