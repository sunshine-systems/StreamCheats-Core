"use client";

// Top-of-page banner shown when the daemon's update poller reports an
// Available, Downloading, Ready or Failed state. Idle / UpToDate
// render nothing. Dismiss is per-session — the hook re-surfaces the
// banner whenever the `latest` version changes (i.e. a new release
// dropped after the user closed it).

import { useUpdater } from "../lib/hooks/useUpdater";

function bytesToHuman(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export default function UpdateBanner() {
  const u = useUpdater();
  const s = u.state;
  if (!s) return null;
  if (s.kind === "idle" || s.kind === "up_to_date") return null;
  if (s.kind === "failed") return null; // surface failures elsewhere; banner stays calm
  if (u.dismissed && s.kind === "available") return null;

  const isAvailable = s.kind === "available";
  const isDownloading = s.kind === "downloading";
  const isReady = s.kind === "ready";

  let title = "";
  let body = "";
  let actionLabel = "";
  let onAction: (() => void) | null = null;
  let accent = "var(--kx-accent)";
  let accentSoft = "var(--kx-accent-soft)";

  if (isAvailable) {
    const ch = s.channel === "nightly" ? "nightly" : "stable";
    title = `Update available · v${s.latest} (${ch})`;
    body = `Installed v${s.installed}. ${bytesToHuman(s.asset_size)} download.`;
    actionLabel = u.busy ? "Starting…" : "Download update";
    onAction = u.busy ? null : u.runDownload;
  } else if (isDownloading) {
    title = `Downloading v${s.latest}…`;
    const pct = s.percent != null ? `${s.percent}%` : "—";
    body = `${bytesToHuman(s.bytes_so_far)} of ${bytesToHuman(s.total_bytes ?? null)} (${pct})`;
    actionLabel = "Downloading…";
    onAction = null;
  } else if (isReady) {
    title = `Ready to install v${s.latest}`;
    body = `Downloaded ${bytesToHuman(s.size)}. The app will close while the installer runs.`;
    actionLabel = u.busy ? "Launching…" : "Install now";
    onAction = u.busy ? null : u.runInstall;
    accent = "var(--kx-action)";
    accentSoft = "var(--kx-action-press, rgba(255,184,107,0.15))";
  }

  return (
    <section
      role="status"
      aria-live="polite"
      style={{
        position: "relative",
        margin: "var(--kx-sp-4) var(--kx-sp-7) 0",
        padding: "var(--kx-sp-4) var(--kx-sp-5)",
        background: accentSoft,
        border: `1px solid ${accent}`,
        borderRadius: "var(--kx-r-md)",
        display: "flex",
        alignItems: "center",
        gap: "var(--kx-sp-4)",
        color: "var(--kx-fg)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "var(--kx-fs-14)",
            fontWeight: 600,
            marginBottom: 2,
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: "var(--kx-fs-12)", color: "var(--kx-fg-3)" }}>
          {body}
          {isAvailable && s.notes_url ? (
            <>
              {" · "}
              <a
                href={s.notes_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: accent }}
              >
                Release notes
              </a>
            </>
          ) : null}
        </div>
        {isDownloading && s.percent != null ? (
          <div
            aria-hidden
            style={{
              marginTop: 8,
              height: 4,
              background: "var(--kx-surface-2)",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${s.percent}%`,
                height: "100%",
                background: accent,
                transition: "width 250ms ease",
              }}
            />
          </div>
        ) : null}
      </div>

      {onAction ? (
        <button
          type="button"
          onClick={onAction}
          style={{
            border: `1px solid ${accent}`,
            background: accent,
            color: "var(--kx-action-fg, #1a1a1a)",
            fontFamily: "var(--kx-font-sans)",
            fontSize: "var(--kx-fs-13, 13px)",
            fontWeight: 600,
            padding: "8px 14px",
            borderRadius: "var(--kx-r-sm, 6px)",
            cursor: "pointer",
          }}
        >
          {actionLabel}
        </button>
      ) : null}

      {isAvailable ? (
        <button
          type="button"
          onClick={u.dismiss}
          aria-label="Dismiss update banner"
          style={{
            background: "transparent",
            border: "none",
            color: "var(--kx-fg-3)",
            cursor: "pointer",
            fontSize: 18,
            lineHeight: 1,
            padding: 4,
          }}
        >
          ×
        </button>
      ) : null}
    </section>
  );
}
