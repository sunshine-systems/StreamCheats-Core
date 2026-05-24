// Zod schemas for `/api/experimental/*` — SC-8.
//
// Mirrors `backend/src/experimental/mod.rs::Status` and
// `backend/src/experimental/registry.rs::ApiDescriptor`. The route
// bodies in `backend/src/http/routes/experimental.rs` wrap the status
// snapshot in `{ ok, status, error? }` on write endpoints.

import { z } from "zod";

export const ExperimentalApiDescriptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
});

export const ExperimentalRegistryResponseSchema = z.object({
  apis: z.array(ExperimentalApiDescriptorSchema),
});

export const ExperimentalStatusSchema = z.object({
  active: z.string().min(1),
  enabled: z.boolean(),
  running: z.boolean(),
  // `Option<String>` in Rust serialises to `null` when absent.
  bound: z.string().nullable(),
  // Configured listen IP + UDP port + device MAC. Always present so the
  // Experimental UI can show external clients (e.g. kmbox-net consumers)
  // exactly which interface, port, and device id to dial — sourced from
  // `config.json` (`listen_addr`, `udp_port`, `device_mac`).
  listen_ip: z.string().min(1),
  udp_port: z.number().int().min(1).max(65535),
  device_mac: z.string().min(1),
  last_error: z.string().nullable(),
});

// All three write endpoints (set_active / enable / disable) return the
// same envelope. `error` is only present on the 409 / 400 paths.
export const ExperimentalActionResponseSchema = z.object({
  ok: z.boolean(),
  status: ExperimentalStatusSchema,
  error: z.string().optional(),
});

// Request bodies.
export const ExperimentalSetActiveRequestSchema = z.object({
  id: z.string().min(1),
});

export type ExperimentalApiDescriptor = z.infer<
  typeof ExperimentalApiDescriptorSchema
>;
export type ExperimentalRegistryResponse = z.infer<
  typeof ExperimentalRegistryResponseSchema
>;
export type ExperimentalStatus = z.infer<typeof ExperimentalStatusSchema>;
export type ExperimentalActionResponse = z.infer<
  typeof ExperimentalActionResponseSchema
>;
