// Typed client for the daemon's `/api/experimental/*` HTTP surface
// (SC-8). Mirrors the route shapes documented in
// `backend/src/http/routes/experimental.rs` and the `Status` struct in
// `backend/src/experimental/mod.rs` — keep this file in lockstep with
// those.
//
// All four entrypoints share the same bridge-then-env-port resolution
// as `./firmware.ts` and `./updater.ts`.

import { getBridge } from "./client";

export interface ExperimentalApiDescriptor {
  id: string;
  name: string;
  description: string;
}

export interface ExperimentalRegistryResponse {
  apis: ExperimentalApiDescriptor[];
}

export interface ExperimentalStatus {
  active: string;
  enabled: boolean;
  running: boolean;
  bound: string | null;
  last_error: string | null;
}

/** Server response wrapper for the write endpoints. */
export interface ExperimentalActionResponse {
  ok: boolean;
  error?: string;
  status: ExperimentalStatus;
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
    // 200 OK is the happy path; 409 (listener-running conflict, enable
    // failed) still carries a useful body so we surface it. Anything
    // else we treat as transient and return null.
    if (!resp.ok && resp.status !== 409 && resp.status !== 400) {
      return null;
    }
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

export function getRegistry(): Promise<ExperimentalRegistryResponse | null> {
  return call<ExperimentalRegistryResponse>("/api/experimental/registry");
}

export function getStatus(): Promise<ExperimentalStatus | null> {
  return call<ExperimentalStatus>("/api/experimental/status");
}

export function setActive(
  id: string
): Promise<ExperimentalActionResponse | null> {
  return call<ExperimentalActionResponse>("/api/experimental/set_active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

export function enable(): Promise<ExperimentalActionResponse | null> {
  return call<ExperimentalActionResponse>("/api/experimental/enable", {
    method: "POST",
  });
}

export function disable(): Promise<ExperimentalActionResponse | null> {
  return call<ExperimentalActionResponse>("/api/experimental/disable", {
    method: "POST",
  });
}
