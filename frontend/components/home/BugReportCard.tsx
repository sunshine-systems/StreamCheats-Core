"use client";

// Home > Report a bug card.
//
// Sits directly below the unseen-log card. Provides a single action:
// generate a diagnostic bundle (logs + config snapshot) saved to the
// user's Desktop (Downloads fallback). No automatic upload.
//
// The state machine is owned by `useBugReport` — this component is
// purely presentational. Five button states are restyled to match
// the rest of the home page's design-token palette:
//
//   idle           — hairline foliage outline, JetBrains Mono chrome
//   requesting     — muted with a small spinner
//   saved          — foliage chip with "✓" + filename
//   error_logging  — copper warning
//   error_network  — danger
//
// Visual chrome matches UnseenLogCard / DevicesSection: <Card>
// primitive, Fraunces heading, .sc-chrome subtitle, action below.

import { useBugReport } from "../../lib/hooks/useBugReport";
import { useToast } from "../../lib/toast/toast";
import Card from "../ui/Card";

function basename(p: string): string {
  const ix = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return ix === -1 ? p : p.slice(ix + 1);
}

interface VisualState {
  label: string;
  // Tailwind class fragment for text + border colour.
  tone: string;
  glyph?: string;
  showSpinner: boolean;
  spinnerColor: string;
}

function visualFor(
  state: ReturnType<typeof useBugReport>["state"],
  savedTo: string | null
): VisualState {
  switch (state) {
    case "requesting":
      return {
        label: "Generating bundle…",
        tone: "text-ink-muted border-hairline",
        showSpinner: true,
        spinnerColor: "var(--sc-ink-muted)",
      };
    case "saved":
      return {
        label: savedTo ? `Saved · ${basename(savedTo)}` : "Saved to Desktop",
        tone:
          "text-foliage border-[color:var(--sc-foliage)]/50 bg-[color:var(--sc-foliage)]/10",
        glyph: "✓",
        showSpinner: false,
        spinnerColor: "var(--sc-foliage)",
      };
    case "error_logging":
      return {
        label: "Logging disabled",
        tone:
          "text-copper border-[color:var(--sc-copper)]/50 bg-[color:var(--sc-copper)]/10",
        glyph: "⚠",
        showSpinner: false,
        spinnerColor: "var(--sc-copper)",
      };
    case "error_network":
      return {
        label: "Failed",
        tone:
          "text-danger border-[color:var(--sc-danger)]/50 bg-[color:var(--sc-danger)]/10",
        glyph: "✕",
        showSpinner: false,
        spinnerColor: "var(--sc-danger)",
      };
    case "idle":
    default:
      return {
        label: "Generate diagnostic bundle",
        tone:
          "text-foliage border-[color:var(--sc-foliage)]/40 hover:border-[color:var(--sc-foliage)]/70",
        showSpinner: false,
        spinnerColor: "var(--sc-foliage)",
      };
  }
}

export default function BugReportCard() {
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
    <Card aria-label="Report a bug" static>
      <style>{`
        @keyframes sc-bugreport-spin { to { transform: rotate(360deg); } }
        .sc-bugreport-spinner {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          border: 2px solid rgba(232, 239, 233, 0.18);
          animation: sc-bugreport-spin 0.7s linear infinite;
          display: inline-block;
        }
      `}</style>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col min-w-0">
          <span className="sc-display text-ink text-[18px] leading-tight font-medium">
            Report a bug
          </span>
          <span className="sc-chrome text-[10px] text-ink-dim mt-1">
            Save a diagnostic bundle to your desktop. No personal data,
            no automatic send.
          </span>
        </div>

        <button
          type="button"
          onClick={run}
          disabled={disabled}
          aria-busy={state === "requesting"}
          aria-live="polite"
          data-idle={isIdle ? "true" : "false"}
          className={`
            self-start
            inline-flex items-center gap-2
            px-2.5 py-1.5
            border rounded-[3px]
            sc-chrome text-[10px]
            bg-transparent
            no-underline
            transition-colors
            disabled:cursor-default
            ${v.tone}
          `}
          style={{ transitionDuration: "var(--sc-dur-quick)" }}
        >
          {v.showSpinner && (
            <span
              className="sc-bugreport-spinner"
              aria-hidden="true"
              style={{ borderTopColor: v.spinnerColor }}
            />
          )}
          {v.glyph && (
            <span aria-hidden="true" style={{ fontSize: 12, lineHeight: 1 }}>
              {v.glyph}
            </span>
          )}
          <span>{v.label}</span>
        </button>
      </div>
    </Card>
  );
}
