// Zod schemas describing the daemon's `/api/firmware/*` JSON wire
// format. The schemas are the single source of truth for the response
// shapes — the TS interfaces in `../firmware.ts` should be
// `z.infer<typeof X>` types (kept compatible for now via re-export so
// existing imports don't break).
//
// Mirrors `backend/src/firmware/mod.rs`'s `State` / `ReleaseEntry`
// serde-tagged enums + the route bodies in
// `backend/src/http/routes/firmware.rs`. If the daemon changes any of
// those, these schemas should change in lockstep — `test/contract.test.ts`
// asserts the schemas accept and reject realistic payloads to lock that in.

import { z } from "zod";

export const FirmwareChannelSchema = z.enum(["stable", "nightly"]);
export const FirmwareInstalledChannelSchema = z.enum([
  "stable",
  "nightly",
  "unknown",
]);

// One variant per `State::*` in backend/src/firmware/mod.rs.
//
// Note: `installed_version` on the outer status response is `null` when
// the device hasn't been heard from yet, so the state's `installed`
// fields are also `nullable` where the backend says `Option<String>`.

export const FirmwareIdleSchema = z.object({ kind: z.literal("idle") });

export const FirmwareUpToDateSchema = z.object({
  kind: z.literal("up_to_date"),
  installed: z.string(),
  checked_at: z.string(),
});

export const FirmwareAvailableSchema = z.object({
  kind: z.literal("available"),
  installed: z.string().nullable(),
  latest: z.string(),
  channel: FirmwareChannelSchema,
  notes_url: z.string().nullable(),
  asset_url: z.string(),
  asset_name: z.string(),
  asset_size: z.number().int().nonnegative(),
  checked_at: z.string(),
});

export const FirmwareDownloadingSchema = z.object({
  kind: z.literal("downloading"),
  latest: z.string(),
  bytes_so_far: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative().nullable(),
  percent: z.number().int().min(0).max(100).nullable(),
});

export const FirmwareReadySchema = z.object({
  kind: z.literal("ready"),
  latest: z.string(),
  hex_path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
});

// Updates restructure: coarse phase tracker the daemon emits from
// pattern-matched teensy_loader_cli stdout. The stepper modal in the
// UI maps each phase to a step screen.
export const FlashPhaseSchema = z.enum([
  "starting",
  "waiting_for_device",
  "programming",
  "booting",
]);

export const FirmwareFlashingSchema = z.object({
  kind: z.literal("flashing"),
  version: z.string(),
  hex_path: z.string(),
  started_at: z.string(),
  // Updates restructure: drives the stepper modal step.
  phase: FlashPhaseSchema,
  // Last ~20 stdout/stderr lines from the loader, capped daemon-side
  // (see `backend/src/firmware/flash.rs:LOG_TAIL_CAP`). The modal
  // renders these in a muted mono block so the user can see what the
  // loader is actually doing.
  log_tail: z.array(z.string()),
});

export const FirmwareFailedSchema = z.object({
  kind: z.literal("failed"),
  error: z.string(),
  when: z.string(),
});

export const FirmwareStateSchema = z.discriminatedUnion("kind", [
  FirmwareIdleSchema,
  FirmwareUpToDateSchema,
  FirmwareAvailableSchema,
  FirmwareDownloadingSchema,
  FirmwareReadySchema,
  FirmwareFlashingSchema,
  FirmwareFailedSchema,
]);

export const FirmwareStatusResponseSchema = z.object({
  state: FirmwareStateSchema,
  installed_version: z.string().nullable(),
  channel: FirmwareInstalledChannelSchema,
  repo: z.string(),
  board: z.string().nullable(),
  auto_check: z.boolean(),
  experimental_builds: z.boolean(),
  // SC-14: cheap synchronous "is the cached teensy_loader_cli.exe
  // present?" flag. The UI uses it to pre-flight the flash flow —
  // when false the confirmation modal swaps "I understand, flash" for
  // "Download flash tool" which POSTs /api/firmware/ensure_loader.
  loader_ready: z.boolean(),
});

export const FirmwareReleaseEntrySchema = z.object({
  version: z.string(),
  channel: FirmwareChannelSchema,
  commit: z.string().nullable(),
  board: z.string(),
  published_at: z.string().nullable(),
  asset_url: z.string(),
  asset_name: z.string(),
  asset_size: z.number().int().nonnegative(),
  html_url: z.string().nullable(),
});

export const FirmwareReleasesResponseSchema = z.object({
  releases: z.array(FirmwareReleaseEntrySchema),
});

export const FirmwareCheckResponseSchema = z.object({
  state: FirmwareStateSchema,
});

// Request body shapes the UI POSTs.
export const FirmwareDownloadRequestSchema = z.object({
  version: z.string().min(1),
});
export const FirmwareFlashRequestSchema = z.object({
  version: z.string().min(1),
});
export const FirmwareFlashLocalRequestSchema = z.object({
  hex_path: z.string().min(1),
});

// Both dispatch endpoints return 202 `{ ok: true }` on accept or 409
// `{ ok: false, error: "<code>" }` on rejection. The known error codes
// are the ones `start_flash` / `start_flash_local` produce (see
// backend/src/firmware/mod.rs). `invalid_hex` carries a free-text
// suffix on the wire (`invalid_hex: <reason>`) which the UI client
// peels off before reaching this schema, so the schema only validates
// the stable prefix.
export const FirmwareDispatchOkSchema = z.object({ ok: z.literal(true) });
export const FirmwareDispatchErrSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
});
export const FirmwareDispatchResponseSchema = z.union([
  FirmwareDispatchOkSchema,
  FirmwareDispatchErrSchema,
]);

// SC-14: ensure-loader endpoint. 200 carries `{ ready: true, path,
// sha256_verified }`; 503 carries `{ ready: false, error, message }`.
export const EnsureLoaderOkSchema = z.object({
  ready: z.literal(true),
  path: z.string(),
  sha256_verified: z.boolean(),
});
export const EnsureLoaderErrSchema = z.object({
  ready: z.literal(false),
  error: z.enum([
    "loader_url_not_configured",
    "network_error",
    "sha256_mismatch",
    "download_failed",
  ]),
  message: z.string(),
});
export const EnsureLoaderResponseSchema = z.union([
  EnsureLoaderOkSchema,
  EnsureLoaderErrSchema,
]);

// Inferred types — these are the canonical TS shapes. `../firmware.ts`
// exports compatible interfaces; we'd flip those to `z.infer<…>` in a
// follow-up to remove the duplication.
export type FlashPhase = z.infer<typeof FlashPhaseSchema>;
export type FirmwareState = z.infer<typeof FirmwareStateSchema>;
export type FirmwareStatusResponse = z.infer<typeof FirmwareStatusResponseSchema>;
export type FirmwareReleaseEntry = z.infer<typeof FirmwareReleaseEntrySchema>;
export type FirmwareReleasesResponse = z.infer<typeof FirmwareReleasesResponseSchema>;
export type FirmwareDispatchResponse = z.infer<typeof FirmwareDispatchResponseSchema>;
export type EnsureLoaderResponse = z.infer<typeof EnsureLoaderResponseSchema>;
