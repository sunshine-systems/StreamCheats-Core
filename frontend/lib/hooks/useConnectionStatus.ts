"use client";

// Polls `window.streamcheats.healthCheck()` every 2s and exposes a 3-state
// connection status the renderer can render as a pill.
//
// State machine:
//   * Initial render → 'connecting'
//   * First successful probe → 'connected'
//   * After 3 consecutive failed probes → 'disconnected'
//   * After 1 successful probe from a 'disconnected' state → 'connected'
//
// The "3 failures before flipping to disconnected" debounce avoids a
// red flash whenever a single probe times out (the daemon could just
// be busy on a long-running tick). The transition back to 'connected'
// is immediate so the UI feels responsive when the daemon comes back.
//
// We also surface a `reason` from the most recent failed probe so the
// pill can render a tooltip distinguishing "daemon never started"
// (`no_port_file`) from "daemon ran but is unresponsive"
// (`probe_failed`). The reason is null while we're still 'connecting'
// or whenever the last probe succeeded.

import { useEffect, useRef, useState } from "react";

import { getBridge } from "../api/client";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type ConnectionFailureReason =
  | "no_port_file"
  | "probe_failed"
  | "no_bridge"
  | null;

export interface ConnectionState {
  status: ConnectionStatus;
  /** Last failure reason; null while connecting or connected. */
  reason: ConnectionFailureReason;
}

const POLL_INTERVAL_MS = 2000;
const FAILURE_THRESHOLD = 3;

export function useConnectionStatus(): ConnectionState {
  const [state, setState] = useState<ConnectionState>({
    status: "connecting",
    reason: null,
  });

  // Track consecutive failures across polls without forcing a re-render
  // every time the counter ticks — only `setState` should re-render.
  const failuresRef = useRef(0);
  // Guards against late responses from a probe that started before the
  // component unmounted (or before the next poll fired).
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const bridge = getBridge();
    if (!bridge) {
      // Browser fallback (next dev without Electron) — we can't reach
      // the daemon via IPC. Render as disconnected; the dev can still
      // exercise the rest of the UI.
      setState({ status: "disconnected", reason: "no_bridge" });
      return () => {
        cancelledRef.current = true;
      };
    }

    let timer: ReturnType<typeof setTimeout> | null = null;

    const runOnce = async () => {
      let ok = false;
      let reason: ConnectionFailureReason = null;
      try {
        const res = (await bridge.healthCheck()) as {
          ok?: boolean;
          reason?: ConnectionFailureReason;
        };
        ok = Boolean(res && res.ok);
        if (!ok && res && res.reason) reason = res.reason;
      } catch {
        ok = false;
        reason = "probe_failed";
      }
      if (cancelledRef.current) return;

      if (ok) {
        failuresRef.current = 0;
        setState((prev) =>
          prev.status === "connected" && prev.reason === null
            ? prev
            : { status: "connected", reason: null }
        );
      } else {
        failuresRef.current += 1;
        if (failuresRef.current >= FAILURE_THRESHOLD) {
          setState((prev) =>
            prev.status === "disconnected" && prev.reason === reason
              ? prev
              : { status: "disconnected", reason }
          );
        }
        // Below the threshold: keep whatever state we're in (initial
        // 'connecting' stays 'connecting'; 'connected' stays connected
        // through transient blips).
      }

      if (!cancelledRef.current) {
        timer = setTimeout(runOnce, POLL_INTERVAL_MS);
      }
    };

    // Kick off immediately so the first probe isn't delayed by 2s.
    runOnce();

    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return state;
}
