"use client";

// WebSocket-backed log stream hook.
//
// Connects to ws://127.0.0.1:<port>/logs/stream via the URL the main
// process resolves through getBackendUrl(). On connect the backend
// dumps its ring buffer (recent history), then streams each new
// `LogEvent` as a JSON text frame.
//
// State the hook exposes:
//   events         - rolling array, capped at MAX_EVENTS (5_000)
//   status         - 'connecting' | 'streaming' | 'paused' | 'disconnected'
//   eventsPerSec   - rolling 1-second event rate (refreshed every 500ms)
//   lagCount       - total events the server told us it had to drop
//   bufferCount    - convenience alias for events.length
//   paused         - whether new events are being appended to `events`
//   clear, pause, resume - imperative controls
//
// When paused the hook still receives events but discards them; the
// idea is that an investigator who wants a stable view doesn't want
// the page to "snap forward" on every new frame and lose their place.

import { useCallback, useEffect, useRef, useState } from "react";

import { getBridge } from "../api/client";

export interface LogEvent {
  ts: string;
  level: string;
  line: string;
}

export type LogStreamStatus =
  | "connecting"
  | "streaming"
  | "paused"
  | "disconnected";

export interface UseLogStreamResult {
  events: LogEvent[];
  status: LogStreamStatus;
  eventsPerSec: number;
  lagCount: number;
  bufferCount: number;
  paused: boolean;
  clear: () => void;
  pause: () => void;
  resume: () => void;
}

const MAX_EVENTS = 5_000;
const RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000];
const RATE_REFRESH_MS = 500;

interface LaggedFrame {
  type: "lagged";
  count: number;
}

function isLaggedFrame(obj: unknown): obj is LaggedFrame {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as { type?: unknown }).type === "lagged" &&
    typeof (obj as { count?: unknown }).count === "number"
  );
}

export function useLogStream(): UseLogStreamResult {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [status, setStatus] = useState<LogStreamStatus>("connecting");
  const [eventsPerSec, setEventsPerSec] = useState(0);
  const [lagCount, setLagCount] = useState(0);
  const [paused, setPaused] = useState(false);

  // Refs whose changes must not retrigger the connect effect.
  const pausedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recentTimestampsRef = useRef<number[]>([]);
  const cancelledRef = useRef(false);

  const pause = useCallback(() => {
    pausedRef.current = true;
    setPaused(true);
    setStatus((prev) =>
      prev === "streaming" || prev === "connecting" ? "paused" : prev
    );
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
    setPaused(false);
    setStatus((prev) => {
      // Don't overwrite a real 'disconnected' state on resume.
      if (prev === "paused") return "streaming";
      return prev;
    });
  }, []);

  const clear = useCallback(() => {
    setEvents([]);
    recentTimestampsRef.current = [];
  }, []);

  useEffect(() => {
    cancelledRef.current = false;

    const bridge = getBridge();

    const connect = async () => {
      if (cancelledRef.current) return;
      setStatus(pausedRef.current ? "paused" : "connecting");

      let wsUrl: string | null = null;
      if (bridge && bridge.getBackendUrl) {
        try {
          const res = await bridge.getBackendUrl();
          if (res.ok) wsUrl = `${res.ws}/logs/stream`;
        } catch {
          /* swallow — handled below */
        }
      } else if (typeof process !== "undefined") {
        const envPort = process.env.NEXT_PUBLIC_STREAMCHEATS_HTTP_PORT;
        if (envPort) wsUrl = `ws://127.0.0.1:${envPort}/logs/stream`;
      }

      if (!wsUrl) {
        if (cancelledRef.current) return;
        setStatus("disconnected");
        scheduleReconnect();
        return;
      }

      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        setStatus("disconnected");
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelledRef.current) return;
        reconnectAttemptRef.current = 0;
        setStatus(pausedRef.current ? "paused" : "streaming");
      };

      ws.onmessage = (msg) => {
        if (cancelledRef.current) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(typeof msg.data === "string" ? msg.data : "");
        } catch {
          return;
        }
        if (isLaggedFrame(parsed)) {
          setLagCount((c) => c + parsed.count);
          return;
        }
        const e = parsed as Partial<LogEvent>;
        if (
          typeof e.ts !== "string" ||
          typeof e.level !== "string" ||
          typeof e.line !== "string"
        ) {
          return;
        }
        const event = e as LogEvent;
        // Always tick the rate counter so an investigator can see the
        // firehose is alive even when paused.
        recentTimestampsRef.current.push(Date.now());
        if (pausedRef.current) return;
        setEvents((prev) => {
          if (prev.length >= MAX_EVENTS) {
            // Drop the oldest 25% in one go to amortize the splice cost.
            const drop = Math.floor(MAX_EVENTS / 4);
            return [...prev.slice(drop), event];
          }
          return [...prev, event];
        });
      };

      ws.onclose = () => {
        if (cancelledRef.current) return;
        wsRef.current = null;
        setStatus("disconnected");
        scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose will fire too — don't double-handle.
      };
    };

    const scheduleReconnect = () => {
      if (cancelledRef.current) return;
      const idx = Math.min(
        reconnectAttemptRef.current,
        RECONNECT_BACKOFF_MS.length - 1
      );
      const delay = RECONNECT_BACKOFF_MS[idx];
      reconnectAttemptRef.current += 1;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    };

    connect();

    // Rate sampler: count timestamps in the trailing 1s window.
    const rateTimer = setInterval(() => {
      const now = Date.now();
      const cutoff = now - 1_000;
      const arr = recentTimestampsRef.current;
      // Trim in place — much cheaper than rebuilding a Vec at 100Hz.
      let drop = 0;
      while (drop < arr.length && arr[drop] < cutoff) drop += 1;
      if (drop > 0) arr.splice(0, drop);
      setEventsPerSec(arr.length);
    }, RATE_REFRESH_MS);

    return () => {
      cancelledRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      clearInterval(rateTimer);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      }
    };
  }, []);

  return {
    events,
    status,
    eventsPerSec,
    lagCount,
    bufferCount: events.length,
    paused,
    clear,
    pause,
    resume,
  };
}
