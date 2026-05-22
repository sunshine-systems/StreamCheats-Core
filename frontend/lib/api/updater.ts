// Typed client for the daemon's `/api/updates/*` HTTP surface.
//
// All endpoints are POSTed against the loopback daemon resolved via the
// Electron preload bridge (`window.streamcheats.getBackendUrl()`). When
// the bridge is absent (e.g. `next dev` against a manually-launched
// daemon) we fall back to `http://127.0.0.1:<NEXT_PUBLIC_STREAMCHEATS_HTTP_PORT>`.
//
// The route surface here mirrors `backend/src/http/routes/updates.rs`
// exactly — keep the two in sync.

import { getBridge } from "./client";

export type UpdaterStateKind =
  | "idle"
  | "up_to_date"
  | "available"
  | "downloading"
  | "ready"
  | "failed";

export interface UpdaterState {
  kind: UpdaterStateKind;
  installed?: string;
  latest?: string;
  channel?: "stable" | "nightly";
  notes_url?: string | null;
  asset_url?: string;
  asset_size?: number;
  checked_at?: string;
  bytes_so_far?: number;
  total_bytes?: number | null;
  percent?: number | null;
  installer_path?: string;
  size?: number;
  sha256?: string;
  error?: string;
  when?: string;
}

export interface UpdaterStatusResponse {
  state: UpdaterState;
  experimental_builds: boolean;
}

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
    if (!resp.ok && resp.status !== 202 && resp.status !== 409) {
      // 202 / 409 still parse as JSON; everything else is an error
      return null;
    }
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

export function getStatus(): Promise<UpdaterStatusResponse | null> {
  return call<UpdaterStatusResponse>("/api/updates/status");
}

export function checkNow(): Promise<{ state: UpdaterState } | null> {
  return call<{ state: UpdaterState }>("/api/updates/check", { method: "POST" });
}

export function startDownload(): Promise<{ ok: boolean; error?: string } | null> {
  return call("/api/updates/download", { method: "POST" });
}

export function installNow(): Promise<{
  ok: boolean;
  installer_path?: string;
  error?: string;
} | null> {
  return call("/api/updates/install", { method: "POST" });
}

export function setExperimentalBuilds(
  enabled: boolean
): Promise<{ ok: boolean; enabled: boolean; error?: string } | null> {
  return call("/api/settings/experimental_builds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}
