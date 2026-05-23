"use client";

// Home > Device status card.
//
// Reflects the daemon connection (the only "device" we can query
// from the renderer today — the daemon is what owns the USB / KMBox
// link). When connected we surface the daemon's version + port from
// useHealthDetail; when disconnected we render a short reason line.
//
// Visual: bg-panel, hairline border, 12px radius (via the shared
// <Card>). Icon on the left, label + status chip stacked, details
// row below. No hover lift — this is informational, not interactive.

import { Cable, Unplug } from "lucide-react";

import {
  useConnectionStatus,
  type ConnectionFailureReason,
} from "../../lib/hooks/useConnectionStatus";
import { useHealthDetail } from "../../lib/hooks/useHealthDetail";
import Card from "../ui/Card";

function reasonCopy(reason: ConnectionFailureReason): string {
  switch (reason) {
    case "no_port_file":
      return "Daemon did not start. Check the Electron log for details.";
    case "probe_failed":
      return "Daemon is running but unresponsive.";
    case "no_bridge":
      return "Running outside Electron — IPC bridge unavailable.";
    default:
      return "Daemon unreachable.";
  }
}

export default function DeviceStatusCard() {
  const { status, reason } = useConnectionStatus();
  const detail = useHealthDetail();

  const isConnected = status === "connected";
  const isConnecting = status === "connecting";

  // Chip tone per SC-7: connected → foliage; disconnected → ink-dim.
  // Connecting reads as "ink-dim" too so the chip never flashes red
  // on first paint (matches the 3-failure debounce in the hook).
  const chipLabel = isConnected
    ? "Connected"
    : isConnecting
    ? "Connecting"
    : "Disconnected";
  const chipClass = isConnected
    ? "text-foliage border-[color:var(--sc-foliage)]/40"
    : "text-ink-dim border-hairline";
  const chipDotClass = isConnected ? "bg-foliage" : "bg-ink-dim";

  const Icon = isConnected ? Cable : Unplug;

  return (
    <Card aria-label="StreamCheats device status" static>
      <div className="flex items-start gap-4">
        <div
          aria-hidden="true"
          className="
            shrink-0
            w-10 h-10
            rounded-[8px]
            bg-substrate-2 border border-hairline
            flex items-center justify-center
            text-ink-muted
          "
        >
          <Icon size={18} strokeWidth={1.75} />
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex flex-col min-w-0">
              <span className="text-ink text-[15px] font-medium leading-tight">
                StreamCheats device
              </span>
              <span className="sc-chrome text-[10px] text-ink-dim mt-1">
                local daemon
              </span>
            </div>

            <span
              className={`
                inline-flex items-center gap-2
                px-2.5 py-1
                border rounded-[3px]
                sc-chrome text-[10px]
                shrink-0
                ${chipClass}
              `}
              role="status"
              aria-live="polite"
            >
              <span
                aria-hidden="true"
                className={`w-1.5 h-1.5 rounded-full ${chipDotClass}`}
              />
              {chipLabel}
            </span>
          </div>

          <DetailLine
            connected={isConnected}
            version={detail?.version ?? null}
            port={detail?.port ?? null}
            reason={isConnected ? null : reason}
            connecting={isConnecting}
          />
        </div>
      </div>
    </Card>
  );
}

function DetailLine({
  connected,
  version,
  port,
  reason,
  connecting,
}: {
  connected: boolean;
  version: string | null;
  port: number | null;
  reason: ConnectionFailureReason;
  connecting: boolean;
}) {
  if (connecting && !connected) {
    return (
      <span className="text-ink-dim text-[12px] font-mono">
        Probing daemon…
      </span>
    );
  }

  if (!connected) {
    return (
      <span className="text-ink-dim text-[12px] leading-relaxed">
        {reasonCopy(reason)}
      </span>
    );
  }

  // Connected: surface what the daemon does report (version + loopback
  // port). A proper firmware / USB-port readout is a follow-up — the
  // daemon doesn't expose that yet, and the ticket explicitly allows
  // a graceful degradation here.
  return (
    <div className="flex items-center gap-3 flex-wrap text-[11px] font-mono text-ink-dim">
      <span>
        <span className="text-ink-muted">daemon</span>{" "}
        <span className="text-ink">v{version ?? "—"}</span>
      </span>
      <span aria-hidden="true" className="opacity-40">
        ·
      </span>
      <span>
        <span className="text-ink-muted">port</span>{" "}
        <span className="text-ink">{port ?? "—"}</span>
      </span>
    </div>
  );
}
