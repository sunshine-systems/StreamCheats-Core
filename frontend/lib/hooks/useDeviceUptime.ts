"use client";

// Reports whether the StreamCheats device is currently detected.
//
// Source of truth is the daemon's heartbeat-derived `installed_version`
// field on `GET /api/firmware/status`. The firmware module declares the
// device `Unknown` after `HEARTBEAT_TIMEOUT` (10s) without a `V:`
// heartbeat reply — at that point `installed_version` flips to `null`
// and we treat the device as not detected. This is the real
// serial-device heartbeat, NOT the daemon loopback connection
// (`useConnectionStatus`) which only reports whether the local HTTP
// server is reachable.
//
// Loading state: while the very first firmware status fetch is in
// flight we report `detected: false` so callers can show a "Detecting…"
// state rather than briefly flashing "Connected".

import { useFirmwareStatus } from "./useFirmwareStatus";

export interface DeviceUptimeState {
  detected: boolean;
}

export function useDeviceUptime(): DeviceUptimeState {
  const { status, loaded } = useFirmwareStatus();
  // `installed_version !== null` <=> heartbeat seen within the
  // backend's HEARTBEAT_TIMEOUT (10s). Until the first poll lands we
  // optimistically treat the device as not detected so the UI shows
  // "Detecting…" rather than flashing "Connected" before truth arrives.
  const detected = loaded && status?.installed_version != null;
  return { detected };
}
