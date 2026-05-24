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
  | "flashing"
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
  // Present only when kind === "flashing".
  version?: string;
  started_at?: string;
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
  /**
   * SC-14: true when `<data_dir>/bin/teensy_loader_cli.exe` exists on
   * disk. Cheap existence check — the UI uses it to pre-flight the
   * flash flow before showing the confirmation modal's flash button.
   */
  loader_ready: boolean;
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
 * Result of dispatching a flash. 202 on accepted, 409 with a stable
 * error code on rejection (see backend/src/firmware/mod.rs:
 * `start_flash` / `start_flash_local`). The UI polls
 * `/api/firmware/status` for progress once dispatch succeeds.
 */
export type FlashResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "flash_in_progress"
        | "hex_not_downloaded"
        | "unknown_version"
        | "unsupported_board"
        | "invalid_hex"
        // SC-14: daemon couldn't resolve / download the loader binary.
        // The UI should redirect the user back through
        // ensureLoader() instead of treating this as transient.
        | "loader_unavailable"
        | "network"
        // Kept for legacy paths (e.g. an older daemon still returning
        // 501); current daemon never produces this.
        | "not_implemented"
        | "unknown";
      detail?: string;
    };

/**
 * SC-14: response from `POST /api/firmware/ensure_loader`. The daemon
 * returns 200 for ready (`{ ready: true, path, sha256_verified }`) or
 * 503 with a structured error code for everything else.
 */
export type EnsureLoaderResult =
  | { ready: true; path: string; sha256_verified: boolean }
  | {
      ready: false;
      error:
        | "loader_url_not_configured"
        | "network_error"
        | "sha256_mismatch"
        | "download_failed"
        | "unknown";
      message: string;
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
  // SC-14: daemon returns 503 when the loader binary can't be resolved
  // or downloaded. The UI uses this to bounce the user back through
  // ensureLoader() rather than presenting it as a transient conflict.
  if (resp.status === 503) {
    try {
      const body = (await resp.json()) as { error?: string };
      if (body.error === "loader_unavailable") {
        return { ok: false, reason: "loader_unavailable" };
      }
      return { ok: false, reason: "unknown", detail: body.error };
    } catch {
      return { ok: false, reason: "loader_unavailable" };
    }
  }
  if (resp.status === 409) {
    try {
      const body = (await resp.json()) as { error?: string };
      const raw = body.error ?? "";
      // The daemon returns a stable code; for "invalid_hex" it prefixes
      // a human-readable cause (e.g. "invalid_hex: ... is empty").
      if (raw.startsWith("invalid_hex")) {
        return {
          ok: false,
          reason: "invalid_hex",
          detail: raw.replace(/^invalid_hex:\s*/, ""),
        };
      }
      if (
        raw === "flash_in_progress" ||
        raw === "hex_not_downloaded" ||
        raw === "unknown_version" ||
        raw === "unsupported_board"
      ) {
        return { ok: false, reason: raw };
      }
      return { ok: false, reason: "unknown", detail: raw };
    } catch {
      return { ok: false, reason: "unknown" };
    }
  }
  return { ok: false, reason: "unknown", detail: `HTTP ${resp.status}` };
}

/**
 * SC-14: POST `/api/firmware/ensure_loader`. Resolves or downloads the
 * Windows `teensy_loader_cli.exe` to `<data_dir>/bin/`. The UI calls
 * this from the flash confirmation modal when `status.loader_ready` is
 * false. Returns `{ ready: true, ... }` on success, or a structured
 * `{ ready: false, error, message }` on failure for the copper-tinted
 * error card with a Retry button.
 */
export async function ensureLoader(): Promise<EnsureLoaderResult> {
  const base = await resolveBase();
  if (!base) {
    return {
      ready: false,
      error: "network_error",
      message: "Couldn't reach the daemon. Is StreamCheats running?",
    };
  }
  try {
    const resp = await fetch(`${base}/api/firmware/ensure_loader`, {
      method: "POST",
    });
    // 200 ready=true, 503 ready=false with structured error code.
    // Anything else we treat as unknown so the UI surfaces something
    // rather than silently swallowing it.
    if (resp.status === 200) {
      const body = (await resp.json()) as {
        ready: true;
        path: string;
        sha256_verified: boolean;
      };
      return body;
    }
    if (resp.status === 503) {
      const body = (await resp.json()) as {
        ready: false;
        error: string;
        message: string;
      };
      const error = (
        ["loader_url_not_configured", "network_error", "sha256_mismatch", "download_failed"] as const
      ).includes(body.error as never)
        ? (body.error as EnsureLoaderResult extends { ready: false; error: infer E }
            ? E
            : never)
        : "unknown";
      return { ready: false, error, message: body.message };
    }
    return {
      ready: false,
      error: "unknown",
      message: `HTTP ${resp.status}`,
    };
  } catch (e) {
    return {
      ready: false,
      error: "network_error",
      message: e instanceof Error ? e.message : "network error",
    };
  }
}

/** Resolved shape returned by `window.streamcheats.pickHexFile`. */
export type PickHexFileResult =
  | { ok: true; path: string }
  | { ok: false; reason: "cancelled" | "unavailable" };

/**
 * Open the OS-native file picker (constrained to `.hex`) via the
 * Electron preload bridge. Returns the absolute path the user chose,
 * or null on cancel / no-bridge.
 */
export async function pickHexFile(): Promise<string | null> {
  const bridge = getBridge();
  if (!bridge || typeof bridge.pickHexFile !== "function") return null;
  const r = await bridge.pickHexFile();
  if (r.ok) return r.path;
  return null;
}
