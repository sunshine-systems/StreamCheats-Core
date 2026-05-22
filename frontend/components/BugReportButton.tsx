"use client";

// "Report Bug" button — a primary action in the redesigned layout.
// State machine is unchanged (delegated to useBugReport); only the
// visual treatment is updated to use the design tokens. The 5 states
// it renders:
//
//   idle           — warm amber CTA, "Generate diagnostic bundle"
//   requesting     — muted, "Generating…" with CSS spinner
//   saved          — mint, "✓ Saved to <Desktop|Downloads>"
//   error_logging  — warning, "⚠ Logging disabled"
//   error_network  — danger, "✕ Failed"

import { useBugReport } from "../lib/hooks/useBugReport";
import { useToast } from "../lib/toast/toast";

function basename(p: string): string {
  const ix = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return ix === -1 ? p : p.slice(ix + 1);
}

interface VisualState {
  bg: string;
  fg: string;
  border: string;
  label: string;
  showSpinner: boolean;
  glyph?: string;
  spinnerColor: string;
}

function visualFor(
  state: ReturnType<typeof useBugReport>["state"],
  savedTo: string | null
): VisualState {
  switch (state) {
    case "requesting":
      return {
        bg: "var(--kx-surface-3)",
        fg: "var(--kx-fg-2)",
        border: "var(--kx-border-strong)",
        label: "Generating bundle…",
        showSpinner: true,
        spinnerColor: "var(--kx-fg)",
      };
    case "saved":
      return {
        bg: "var(--kx-accent-soft)",
        fg: "var(--kx-accent)",
        border: "var(--kx-border-glow)",
        label: savedTo ? `Saved · ${basename(savedTo)}` : "Saved to Desktop",
        showSpinner: false,
        spinnerColor: "var(--kx-accent)",
        glyph: "✓",
      };
    case "error_logging":
      return {
        bg: "var(--kx-warning-soft)",
        fg: "var(--kx-warning)",
        border: "rgba(255, 209, 102, 0.4)",
        label: "Logging disabled",
        showSpinner: false,
        spinnerColor: "var(--kx-warning)",
        glyph: "⚠",
      };
    case "error_network":
      return {
        bg: "var(--kx-danger-soft)",
        fg: "var(--kx-danger)",
        border: "rgba(255, 107, 122, 0.4)",
        label: "Failed",
        showSpinner: false,
        spinnerColor: "var(--kx-danger)",
        glyph: "✕",
      };
    case "idle":
    default:
      return {
        bg: "var(--kx-action)",
        fg: "var(--kx-action-fg)",
        border: "var(--kx-action)",
        label: "Generate diagnostic bundle",
        showSpinner: false,
        spinnerColor: "var(--kx-action-fg)",
      };
  }
}

export default function BugReportButton() {
  const toast = useToast();
  const { state, savedTo, run } = useBugReport({
    onSuccess: (path, fellBack) => {
      const where = fellBack ? "Downloads" : "Desktop";
      toast.show(
        `Bug report saved to ${where}: ${basename(path)}`,
        "success"
      );
    },
    onError: (code, message) => {
      if (code === "file_logging_disabled") {
        toast.show(
          "Enable file logging in config.json to use bug reports.",
          "warning"
        );
      } else if (code === "network" || code === "http_port_unavailable") {
        toast.show(
          "Couldn't reach backend. Is the daemon running?",
          "error"
        );
      } else {
        toast.show(message, "error");
      }
    },
  });

  const v = visualFor(state, savedTo);
  const disabled = state !== "idle";
  const isIdle = state === "idle";

  return (
    <>
      <style>{`
        @keyframes streamcheats-spin { to { transform: rotate(360deg); } }
        .streamcheats-spinner {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.18);
          animation: streamcheats-spin 0.7s linear infinite;
          display: inline-block;
        }
        .kx-cta {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          border: 1px solid var(--btn-border);
          background: var(--btn-bg);
          color: var(--btn-fg);
          font-family: var(--kx-font-sans);
          font-size: var(--kx-fs-14);
          font-weight: 600;
          letter-spacing: 0.01em;
          padding: 14px 22px;
          border-radius: var(--kx-r-md);
          cursor: pointer;
          min-width: 280px;
          transition:
            background 200ms var(--kx-ease),
            color 200ms var(--kx-ease),
            border-color 200ms var(--kx-ease),
            transform 120ms var(--kx-ease),
            box-shadow 200ms var(--kx-ease);
          box-shadow: 0 1px 0 rgba(255,255,255,0.08) inset, 0 6px 18px rgba(0,0,0,0.35);
        }
        .kx-cta[data-idle="true"]:hover {
          background: var(--kx-action-press);
          transform: translateY(-1px);
          box-shadow: 0 1px 0 rgba(255,255,255,0.1) inset, 0 10px 24px rgba(255, 184, 107, 0.18);
        }
        .kx-cta[data-idle="true"]:active {
          transform: translateY(0);
        }
        .kx-cta:focus-visible {
          outline: 2px solid var(--kx-accent);
          outline-offset: 2px;
        }
        .kx-cta:disabled {
          cursor: default;
          pointer-events: none;
        }
        .kx-cta-kbd {
          margin-left: 8px;
          font-family: var(--kx-font-mono);
          font-size: 10px;
          letter-spacing: 0.1em;
          padding: 3px 6px;
          border-radius: 4px;
          border: 1px solid currentColor;
          opacity: 0.55;
        }
      `}</style>
      <button
        type="button"
        onClick={run}
        disabled={disabled}
        aria-busy={state === "requesting"}
        aria-live="polite"
        data-idle={isIdle ? "true" : "false"}
        className="kx-cta"
        style={
          {
            ["--btn-bg" as string]: v.bg,
            ["--btn-fg" as string]: v.fg,
            ["--btn-border" as string]: v.border,
          } as React.CSSProperties
        }
      >
        {v.showSpinner && (
          <span
            className="streamcheats-spinner"
            aria-hidden="true"
            style={{ borderTopColor: v.spinnerColor }}
          />
        )}
        {v.glyph && (
          <span aria-hidden="true" style={{ fontSize: 15, lineHeight: 1 }}>
            {v.glyph}
          </span>
        )}
        <span>{v.label}</span>
      </button>
    </>
  );
}
