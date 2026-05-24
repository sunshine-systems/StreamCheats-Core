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

/**
 * Coarse phase the loader subprocess is currently in. The daemon
 * advances it by pattern-matching teensy_loader_cli stdout — see
 * `backend/src/firmware/flash.rs`. The UI stepper modal maps each
 * value onto a step screen.
 */
export type FlashPhase =
  | "starting"
  | "waiting_for_device"
  | "programming"
  | "booting";

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
  /** Updates restructure: drives the stepper modal step. */
  phase?: FlashPhase;
  /**
   * Updates restructure: last ~20 stdout/stderr lines from the loader.
   * Capped daemon-side at `LOG_TAIL_CAP`. Used by the stepper modal
   * to render recent loader output in a muted mono block.
   */
  log_tail?: string[];
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
   * True when the bundled `teensy_loader_cli.exe` is where the daemon
   * expects it (set by electron via STREAMCHEATS_TEENSY_LOADER_PATH).
   * With a correct install this is always true; the UI surfaces a
   * "Flash tool missing — please reinstall" message when it isn't.
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
        // Daemon couldn't resolve the bundled loader binary. With a
        // correct install this never fires; the UI surfaces a
        // "please reinstall" message when it does.
        | "loader_unavailable"
        | "network"
        // Kept for legacy paths (e.g. an older daemon still returning
        // 501); current daemon never produces this.
        | "not_implemented"
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
  // Daemon returns 503 when the bundled loader binary can't be
  // resolved (broken install). The UI surfaces a "please reinstall"
  // message rather than presenting it as a transient conflict.
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
 * Result of `POST /api/firmware/cancel_flash`. The daemon returns 202
 * `{ ok: true }` when it signalled the supervision loop to kill the
 * subprocess (subsequent state polls will show `Failed { error:
 * "user_cancelled" }`), or 409 `{ ok: false, reason: "not_flashing" }`
 * when nothing was in flight.
 */
export type CancelFlashResult =
  | { ok: true }
  | {
      ok: false;
      reason: "not_flashing" | "network" | "unknown";
      detail?: string;
    };

/**
 * Updates restructure: POST `/api/firmware/cancel_flash`. Used by the
 * stepper modal's Cancel button in the `waiting_for_device` phase
 * (NOT in `programming` — interrupting mid-write would brick the
 * device). The daemon kills the subprocess and transitions to
 * `Failed { error: "user_cancelled" }`; the polling status watcher
 * picks the transition up on the next tick.
 */
export async function cancelFlash(): Promise<CancelFlashResult> {
  const base = await resolveBase();
  if (!base) return { ok: false, reason: "network" };
  try {
    const resp = await fetch(`${base}/api/firmware/cancel_flash`, {
      method: "POST",
    });
    if (resp.status === 202) return { ok: true };
    if (resp.status === 409) {
      try {
        const body = (await resp.json()) as { error?: string };
        if (body.error === "not_flashing") {
          return { ok: false, reason: "not_flashing" };
        }
        return { ok: false, reason: "unknown", detail: body.error };
      } catch {
        return { ok: false, reason: "unknown" };
      }
    }
    return { ok: false, reason: "unknown", detail: `HTTP ${resp.status}` };
  } catch (e) {
    return {
      ok: false,
      reason: "network",
      detail: e instanceof Error ? e.message : undefined,
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
