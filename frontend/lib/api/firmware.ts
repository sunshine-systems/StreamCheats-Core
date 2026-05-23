// Typed client for the daemon's `/api/firmware/*` HTTP surface (SC-10).
//
// Same bridge-then-env-port resolution as `./updater.ts`. Mirrors the
// route shapes documented in `backend/src/http/routes/firmware.rs` and
// the `FirmwareUpdater::State` enum in `backend/src/firmware/mod.rs` —
// keep this file in lockstep with those.
//
// Flash endpoints are intentionally implemented here against the
// SC-10-shipped 501 stubs so the UI can probe them and render a
// "Coming in SC-13" affordance. They will start returning real
// success / failure shapes once SC-13 lands.

import { getBridge } from "./client";

export type FirmwareStateKind =
  | "idle"
  | "up_to_date"
  | "available"
  | "downloading"
  | "ready"
  | "failed";

export interface FirmwareState {
  kind: FirmwareStateKind;
  installed?: string | null;
  latest?: string;
  channel?: "stable" | "nightly";
  notes_url?: string | null;
  asset_url?: string;
  asset_name?: string;
  asset_size?: number;
  checked_at?: string;
  bytes_so_far?: number;
  total_bytes?: number | null;
  percent?: number | null;
  hex_path?: string;
  size?: number;
  sha256?: string;
  error?: string;
  when?: string;
}

export interface FirmwareStatusResponse {
  state: FirmwareState;
  installed_version: string | null;
  channel: "stable" | "nightly" | "unknown";
  repo: string;
  board: string | null;
  auto_check: boolean;
  experimental_builds: boolean;
}

export interface FirmwareReleaseEntry {
  version: string;
  channel: "stable" | "nightly";
  commit: string | null;
  board: string;
  published_at: string | null;
  asset_url: string;
  asset_name: string;
  asset_size: number;
  html_url: string | null;
}

export interface FirmwareReleasesResponse {
  releases: FirmwareReleaseEntry[];
}

/**
 * Result of probing a flash endpoint. Until SC-13 lands the daemon
 * returns 501; the caller renders a "Coming in SC-13" affordance.
 */
export type FlashResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "not_implemented"
        | "network"
        | "device_not_connected"
        | "hex_not_downloaded"
        | "already_flashing"
        | "unknown";
      detail?: string;
    };

async function resolveBase(): Promise<string | null> {
  const bridge = getBridge();
  if (bridge?.getBackendUrl) {
    const r = await bridge.getBackendUrl();
    if (r.ok) return r.http;
  }
  const port = process.env.NEXT_PUBLIC_STREAMCHEATS_HTTP_PORT;
  if (port) return `http://127.0.0.1:${port}`;
  return null;
}

async function call<T = unknown>(
  path: string,
  init?: RequestInit
): Promise<T | null> {
  const base = await resolveBase();
  if (!base) return null;
  try {
    const resp = await fetch(`${base}${path}`, init);
    // 202 (accepted) and 409 (conflict) still carry JSON bodies that
    // the caller wants. 501 (flash stubs) is handled separately by
    // `flash` / `flashLocal` below.
    if (!resp.ok && resp.status !== 202 && resp.status !== 409) {
      return null;
    }
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

export function getStatus(): Promise<FirmwareStatusResponse | null> {
  return call<FirmwareStatusResponse>("/api/firmware/status");
}

export function getReleases(): Promise<FirmwareReleasesResponse | null> {
  return call<FirmwareReleasesResponse>("/api/firmware/releases");
}

export function checkNow(): Promise<{ state: FirmwareState } | null> {
  return call<{ state: FirmwareState }>("/api/firmware/check", {
    method: "POST",
  });
}

export function startDownload(
  version: string
): Promise<{ ok: boolean; error?: string } | null> {
  return call("/api/firmware/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version }),
  });
}

/**
 * Probe `/api/firmware/flash`. Returns `{ ok: false, reason:
 * "not_implemented" }` until SC-13 wires up `teensy_loader_cli`.
 */
export async function flash(version: string): Promise<FlashResult> {
  const base = await resolveBase();
  if (!base) return { ok: false, reason: "network" };
  try {
    const resp = await fetch(`${base}/api/firmware/flash`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version }),
    });
    return await interpretFlashResponse(resp);
  } catch (e) {
    return {
      ok: false,
      reason: "network",
      detail: e instanceof Error ? e.message : undefined,
    };
  }
}

export async function flashLocal(hexPath: string): Promise<FlashResult> {
  const base = await resolveBase();
  if (!base) return { ok: false, reason: "network" };
  try {
    const resp = await fetch(`${base}/api/firmware/flash_local`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hex_path: hexPath }),
    });
    return await interpretFlashResponse(resp);
  } catch (e) {
    return {
      ok: false,
      reason: "network",
      detail: e instanceof Error ? e.message : undefined,
    };
  }
}

async function interpretFlashResponse(resp: Response): Promise<FlashResult> {
  if (resp.status === 501) {
    return { ok: false, reason: "not_implemented" };
  }
  if (resp.status === 202) {
    return { ok: true };
  }
  if (resp.status === 409) {
    try {
      const body = (await resp.json()) as { error?: string };
      const error = body.error;
      if (
        error === "device_not_connected" ||
        error === "hex_not_downloaded" ||
        error === "already_flashing"
      ) {
        return { ok: false, reason: error };
      }
      return { ok: false, reason: "unknown", detail: error };
    } catch {
      return { ok: false, reason: "unknown" };
    }
  }
  return { ok: false, reason: "unknown", detail: `HTTP ${resp.status}` };
}
