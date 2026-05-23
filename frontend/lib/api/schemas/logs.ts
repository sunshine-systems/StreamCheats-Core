// Zod schemas for the WebSocket `/logs/stream` wire frames.
//
// Mirrors `backend/src/services/log_stream/event.rs::LogEvent` plus the
// in-band `{type: "lagged", count: N}` control frame the route handler
// emits when the broadcast receiver lags.

import { z } from "zod";

export const LogEventSchema = z.object({
  ts: z.string().min(1),
  // Daemon uppercases via `LogEvent::new`, but accept any case — the
  // hook does its own `.toUpperCase()`.
  level: z.string().min(1),
  line: z.string(),
});

export const LogLaggedFrameSchema = z.object({
  type: z.literal("lagged"),
  count: z.number().int().nonnegative(),
});

export const LogStreamFrameSchema = z.union([
  LogLaggedFrameSchema,
  LogEventSchema,
]);

export type LogEvent = z.infer<typeof LogEventSchema>;
export type LogLaggedFrame = z.infer<typeof LogLaggedFrameSchema>;
export type LogStreamFrame = z.infer<typeof LogStreamFrameSchema>;
