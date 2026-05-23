// Zod schemas for `/api/updates/*` and
// `/api/settings/experimental_builds` — SC-4.
//
// Mirrors the `UpdaterState` enum in `backend/src/updater/` and the
// route bodies in `backend/src/http/routes/updates.rs`.

import { z } from "zod";

export const UpdaterChannelSchema = z.enum(["stable", "nightly"]);

// Variants from the daemon's UpdaterState enum.
export const UpdaterIdleSchema = z.object({ kind: z.literal("idle") });

export const UpdaterUpToDateSchema = z.object({
  kind: z.literal("up_to_date"),
  installed: z.string(),
  checked_at: z.string(),
});

export const UpdaterAvailableSchema = z.object({
  kind: z.literal("available"),
  installed: z.string(),
  latest: z.string(),
  channel: UpdaterChannelSchema,
  notes_url: z.string().nullable(),
  asset_url: z.string(),
  asset_size: z.number().int().nonnegative(),
  checked_at: z.string(),
});

export const UpdaterDownloadingSchema = z.object({
  kind: z.literal("downloading"),
  latest: z.string(),
  bytes_so_far: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative().nullable(),
  percent: z.number().int().min(0).max(100).nullable(),
});

export const UpdaterReadySchema = z.object({
  kind: z.literal("ready"),
  latest: z.string(),
  installer_path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
});

export const UpdaterFailedSchema = z.object({
  kind: z.literal("failed"),
  error: z.string(),
  when: z.string(),
});

export const UpdaterStateSchema = z.discriminatedUnion("kind", [
  UpdaterIdleSchema,
  UpdaterUpToDateSchema,
  UpdaterAvailableSchema,
  UpdaterDownloadingSchema,
  UpdaterReadySchema,
  UpdaterFailedSchema,
]);

export const UpdaterStatusResponseSchema = z.object({
  state: UpdaterStateSchema,
  experimental_builds: z.boolean(),
});

export const UpdaterCheckResponseSchema = z.object({
  state: UpdaterStateSchema,
});

export const UpdaterDownloadResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

export const UpdaterInstallResponseSchema = z.object({
  ok: z.boolean(),
  installer_path: z.string().optional(),
  error: z.string().optional(),
});

export const SetExperimentalBuildsRequestSchema = z.object({
  enabled: z.boolean(),
});

export const SetExperimentalBuildsResponseSchema = z.object({
  ok: z.boolean(),
  enabled: z.boolean(),
  error: z.string().optional(),
});

export type UpdaterState = z.infer<typeof UpdaterStateSchema>;
export type UpdaterStatusResponse = z.infer<typeof UpdaterStatusResponseSchema>;
