// Zod schemas for `GET /health` and the bridge surfaces
// `healthCheck()` / `healthDetail()` / `getBackendUrl()` consume.
//
// Mirrors `backend/src/http/routes/health.rs::HealthResponse` plus the
// preload bridge shapes documented in `frontend/lib/api/client.ts`.

import { z } from "zod";

// Daemon HTTP shape — `GET /health`.
export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  uptime_seconds: z.number().int().nonnegative(),
  version: z.string().min(1),
});

// Preload bridge shapes (Electron side, not the daemon).
export const BridgeHealthCheckResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["no_port_file", "probe_failed"]).optional(),
    port: z.number().int().positive().optional(),
  }),
]);

export const BridgeHealthDetailResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    pid: z.number().int().nullable(),
    port: z.number().int().positive(),
    version: z.string().nullable(),
    uptimeSeconds: z.number().nullable(),
  }),
  z.object({ ok: z.literal(false) }),
]);

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type BridgeHealthCheckResult = z.infer<typeof BridgeHealthCheckResultSchema>;
export type BridgeHealthDetailResult = z.infer<typeof BridgeHealthDetailResultSchema>;
