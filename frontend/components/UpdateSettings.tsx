"use client";

// Settings card: exposes the nightly-channel toggle and the manual
// "Check for updates now" button. Lives on the main page below the
// CTA card so the user can find it without a separate settings route.

import { useUpdater } from "../lib/hooks/useUpdater";

export default function UpdateSettings() {
  const u = useUpdater();
  const s = u.state;

  let statusLine = "No checks have run yet.";
  if (s) {
    switch (s.kind) {
      case "up_to_date":
        statusLine = `Up to date · v${s.installed}`;
        break;
      case "available":
        statusLine = `Update available · v${s.latest} (${s.channel})`;
        break;
      case "downloading":
        statusLine = `Downloading v${s.latest}…`;
        break;
      case "ready":
        statusLine = `Ready to install · v${s.latest}`;
        break;
      case "failed":
        statusLine = `Last check failed: ${s.error ?? "unknown"}`;
        break;
      case "idle":
      default:
        statusLine = "No checks have run yet.";
    }
  }

  return (
    <section
      style={{
        background: "var(--kx-surface)",
        border: "1px solid var(--kx-border)",
        borderRadius: "var(--kx-r-lg, 12px)",
        padding: "var(--kx-sp-5, 20px)",
      }}
      aria-label="Update settings"
    >
      <div
        className="kx-eyebrow"
        style={{ marginBottom: "var(--kx-sp-3, 12px)" }}
      >
        Updates
      </div>
      <h2
        style={{
          margin: 0,
          marginBottom: "var(--kx-sp-2, 8px)",
          fontSize: "var(--kx-fs-20, 20px)",
          letterSpacing: "-0.01em",
          fontWeight: 600,
          color: "var(--kx-fg)",
        }}
      >
        Update channel
      </h2>
      <p
        style={{
          margin: 0,
          marginBottom: "var(--kx-sp-4, 16px)",
          fontSize: "var(--kx-fs-13, 13px)",
          color: "var(--kx-fg-3)",
          lineHeight: 1.55,
        }}
      >
        {statusLine}
      </p>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: "var(--kx-sp-4, 16px)",
          cursor: u.busy ? "wait" : "pointer",
          fontSize: "var(--kx-fs-13, 13px)",
          color: "var(--kx-fg-2)",
        }}
      >
        <input
          type="checkbox"
          checked={u.experimental}
          disabled={u.busy}
          onChange={(e) => u.setNightly(e.target.checked)}
        />
        Receive nightly / experimental builds
      </label>

      <button
        type="button"
        onClick={u.runCheck}
        disabled={u.busy}
        style={{
          background: "var(--kx-surface-2)",
          color: "var(--kx-fg)",
          border: "1px solid var(--kx-border-strong, var(--kx-border))",
          borderRadius: "var(--kx-r-sm, 6px)",
          padding: "8px 14px",
          fontFamily: "var(--kx-font-sans)",
          fontSize: "var(--kx-fs-13, 13px)",
          fontWeight: 600,
          cursor: u.busy ? "wait" : "pointer",
        }}
      >
        {u.busy ? "Working…" : "Check for updates now"}
      </button>
    </section>
  );
}
