"use client";

// Compact pill that reflects the renderer ↔ daemon connection. Three
// visual states map 1:1 to the hook's `ConnectionStatus`:
//
//   connecting    → amber dot + "Connecting…"
//   connected     → mint dot (with pulse) + "Connected"
//   disconnected  → red dot + "Disconnected"
//
// Styling pulls from the design tokens in globals.css so the pill
// stays coherent with the rest of the UI. Behavior is unchanged from
// the previous implementation.

import {
  useConnectionStatus,
  type ConnectionFailureReason,
  type ConnectionStatus,
} from "../lib/hooks/useConnectionStatus";

interface Visual {
  dot: string;
  bg: string;
  border: string;
  fg: string;
  label: string;
  pulse: boolean;
}

function visualFor(s: ConnectionStatus): Visual {
  switch (s) {
    case "connected":
      return {
        dot: "var(--kx-accent)",
        bg: "var(--kx-accent-soft)",
        border: "var(--kx-border-glow)",
        fg: "var(--kx-accent)",
        label: "Live",
        pulse: true,
      };
    case "disconnected":
      return {
        dot: "var(--kx-danger)",
        bg: "var(--kx-danger-soft)",
        border: "rgba(255, 107, 122, 0.35)",
        fg: "var(--kx-danger)",
        label: "Offline",
        pulse: false,
      };
    case "connecting":
    default:
      return {
        dot: "var(--kx-warning)",
        bg: "var(--kx-warning-soft)",
        border: "rgba(255, 209, 102, 0.35)",
        fg: "var(--kx-warning)",
        label: "Linking…",
        pulse: false,
      };
  }
}

function tooltipFor(
  status: ConnectionStatus,
  reason: ConnectionFailureReason
): string | undefined {
  if (status !== "disconnected") return undefined;
  switch (reason) {
    case "no_port_file":
      return "Daemon did not start (no http_port file). Check %APPDATA%\\streamcheats-core-electron\\logs\\electron.log.";
    case "probe_failed":
      return "Daemon is running but not responding to /health within 1s.";
    case "no_bridge":
      return "Not running inside Electron — IPC bridge unavailable.";
    default:
      return "Daemon unreachable.";
  }
}

export default function ConnectionStatus() {
  const { status, reason } = useConnectionStatus();
  const v = visualFor(status);
  const title = tooltipFor(status, reason);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Daemon ${v.label}`}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--kx-sp-2)",
        background: v.bg,
        color: v.fg,
        border: `1px solid ${v.border}`,
        borderRadius: "var(--kx-r-pill)",
        padding: "5px 11px 5px 9px",
        fontSize: "var(--kx-fs-12)",
        fontFamily: "var(--kx-font-mono)",
        fontWeight: 500,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        transition: "background 220ms var(--kx-ease), color 220ms var(--kx-ease), border-color 220ms var(--kx-ease)",
        userSelect: "none",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: v.dot,
          boxShadow: `0 0 8px ${v.dot}`,
          animation: v.pulse ? "kx-pulse 2.2s var(--kx-ease) infinite" : "none",
          transition: "background 220ms var(--kx-ease)",
        }}
      />
      <span>{v.label}</span>
    </div>
  );
}
