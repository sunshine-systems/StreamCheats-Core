"use client";

// Left-side telemetry card. Shows the live daemon snapshot read from
// `/health` (pid, port, version, uptime). Mono-numeric fields use
// JetBrains Mono with tabular-nums so columns don't jitter as values
// tick. Falls back to em-dash placeholders before the first probe
// completes (or when the bridge is missing).

import { useEffect, useState } from "react";
import { formatUptime, useHealthDetail } from "../lib/hooks/useHealthDetail";

export default function StatusRail() {
  const detail = useHealthDetail();

  // Hot-tick the displayed uptime locally between probes so it counts
  // smoothly instead of jumping by 4s. Anchored on the last snapshot.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => (n + 1) % 1_000_000), 1000);
    return () => clearInterval(t);
  }, []);

  const localUptime =
    detail && detail.uptimeSeconds != null
      ? detail.uptimeSeconds + Math.floor(tick) // tick is in seconds
      : null;

  return (
    <aside
      className="kx-rise"
      style={{
        background: "var(--kx-surface)",
        border: "1px solid var(--kx-border)",
        borderRadius: "var(--kx-r-lg)",
        padding: "var(--kx-sp-5)",
        animationDelay: "60ms",
      }}
      aria-label="Daemon telemetry"
    >
      <div
        className="kx-eyebrow"
        style={{ marginBottom: "var(--kx-sp-4)" }}
      >
        Daemon
      </div>

      <Row label="PID"     value={detail?.pid != null ? String(detail.pid) : "—"} />
      <Row label="Port"    value={detail?.port != null ? String(detail.port) : "—"} />
      <Row label="Version" value={detail?.version ? `v${detail.version}` : "—"} />
      <Row label="Uptime"  value={formatUptime(localUptime)} highlight={detail != null} />

      <div className="kx-divider" />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--kx-sp-2)",
          color: "var(--kx-fg-3)",
          fontSize: "var(--kx-fs-12)",
          lineHeight: 1.45,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: detail ? "var(--kx-accent)" : "var(--kx-fg-muted)",
            boxShadow: detail ? "0 0 6px var(--kx-accent)" : "none",
            flex: "0 0 auto",
          }}
        />
        <span>
          {detail
            ? "Snapshot from local daemon."
            : "Awaiting first /health probe."}
        </span>
      </div>
    </aside>
  );
}

function Row({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: "var(--kx-sp-3)",
        padding: "6px 0",
      }}
    >
      <span
        style={{
          fontSize: "var(--kx-fs-12)",
          color: "var(--kx-fg-3)",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </span>
      <span
        className="kx-mono"
        style={{
          fontSize: "var(--kx-fs-13)",
          color: highlight ? "var(--kx-accent)" : "var(--kx-fg-2)",
          fontWeight: 500,
        }}
      >
        {value}
      </span>
    </div>
  );
}
