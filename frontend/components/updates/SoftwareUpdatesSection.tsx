"use client";

// Updates page > Software section. Consumes the existing SC-4
// `useUpdater` hook as-is — no refactor — so the channel toggle and
// state machine match the rest of the app exactly.
//
// Layout:
//   1. eyebrow + section title
//   2. card body:
//      - left column: current version (mono, large) + channel chip
//      - right column: state-dependent CTA stack
//   3. when state == downloading: ProgressBar across the full row
//   4. when state == failed: danger error line + retry CTA
//   5. footer row: channel toggle ("stable" / "nightly") gated by
//      experimental_builds.
//
// State copy per SC-9:
//   up_to_date  -> "You're on the latest <channel>" + Check now
//   available   -> "Update available — <version>" + Download (+ notes)
//   downloading -> progress bar
//   ready       -> "Ready to install" + Install & restart (copper tone)
//   failed      -> error + Try again

import { Download, RefreshCw, RotateCcw, Sparkles } from "lucide-react";

import { useUpdater } from "../../lib/hooks/useUpdater";
import Card from "../ui/Card";
import Eyebrow from "../ui/Eyebrow";
import ActionButton from "./ActionButton";
import ProgressBar from "./ProgressBar";
import StateChip, { type StateChipTone } from "./StateChip";

function chipForKind(kind: string | undefined): {
  tone: StateChipTone;
  label: string;
} {
  switch (kind) {
    case "up_to_date":
      return { tone: "foliage", label: "Up to date" };
    case "available":
      return { tone: "copper", label: "Update available" };
    case "downloading":
      return { tone: "foliage", label: "Downloading" };
    case "ready":
      return { tone: "copper", label: "Ready to install" };
    case "failed":
      return { tone: "danger", label: "Failed" };
    default:
      return { tone: "muted", label: "Idle" };
  }
}

export default function SoftwareUpdatesSection() {
  const {
    state,
    experimental,
    busy,
    runCheck,
    runDownload,
    runInstall,
    setNightly,
  } = useUpdater();

  const kind = state?.kind;
  const chip = chipForKind(kind);
  const installed = state?.installed ?? "—";
  const channel = state?.channel ?? (experimental ? "nightly" : "stable");

  return (
    <section
      aria-label="Software updates"
      className="flex flex-col gap-4"
    >
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <Eyebrow>software</Eyebrow>
        <StateChip tone={chip.tone}>{chip.label}</StateChip>
      </header>

      <Card aria-label="Software update status" static>
        <div className="flex items-start gap-4 flex-wrap">
          <div className="flex flex-col min-w-0 flex-1">
            <span className="sc-chrome text-[10px] text-ink-dim">
              installed
            </span>
            <span className="font-mono text-ink text-[20px] leading-tight mt-1 break-all">
              v{installed}
            </span>
            <span className="sc-chrome text-[10px] text-ink-dim mt-2">
              channel · {channel}
            </span>
          </div>

          <div className="flex flex-col items-stretch gap-2 shrink-0">
            <ActionButton
              tone="ghost"
              onClick={() => void runCheck()}
              disabled={busy || kind === "downloading"}
            >
              <RefreshCw size={12} strokeWidth={1.75} aria-hidden="true" />
              Check now
            </ActionButton>

            {kind === "available" ? (
              <ActionButton
                tone="foliage"
                onClick={() => void runDownload()}
                disabled={busy}
              >
                <Download size={12} strokeWidth={1.75} aria-hidden="true" />
                Download v{state?.latest}
              </ActionButton>
            ) : null}

            {kind === "ready" ? (
              <ActionButton
                tone="copper"
                onClick={() => void runInstall()}
                disabled={busy}
              >
                <Sparkles size={12} strokeWidth={1.75} aria-hidden="true" />
                Install &amp; restart
              </ActionButton>
            ) : null}

            {kind === "failed" ? (
              <ActionButton
                tone="ghost"
                onClick={() => void runCheck()}
                disabled={busy}
              >
                <RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" />
                Try again
              </ActionButton>
            ) : null}
          </div>
        </div>

        {kind === "downloading" ? (
          <div className="mt-4">
            <ProgressBar
              percent={state?.percent ?? null}
              bytesSoFar={state?.bytes_so_far}
              totalBytes={state?.total_bytes ?? null}
              label={`Downloading v${state?.latest ?? "—"}`}
            />
          </div>
        ) : null}

        {kind === "available" && state?.notes_url ? (
          <p className="mt-3 text-[12px] text-ink-dim">
            <a
              href={state.notes_url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-foliage underline decoration-[color:var(--sc-foliage)]/40 underline-offset-2 hover:decoration-[color:var(--sc-foliage)]"
            >
              View release notes →
            </a>
          </p>
        ) : null}

        {kind === "ready" ? (
          <p className="mt-3 text-[12px] text-ink-muted leading-relaxed">
            Installing closes the app and runs the new installer. Save any
            work elsewhere first.
          </p>
        ) : null}

        {kind === "failed" ? (
          <p
            className="mt-3 text-[12px] text-danger font-mono break-all"
            role="alert"
          >
            {state?.error ?? "Unknown error."}
          </p>
        ) : null}

        <div className="mt-5 pt-4 border-t border-hairline flex items-center justify-between gap-3 flex-wrap">
          <div className="flex flex-col">
            <span className="sc-chrome text-[10px] text-ink-dim">
              experimental builds
            </span>
            <span className="text-[12px] text-ink-muted mt-1 max-w-prose">
              Receive nightly builds. Unstable — recommended for testing only.
            </span>
          </div>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={experimental}
              disabled={busy}
              onChange={(e) => void setNightly(e.target.checked)}
            />
            <span
              aria-hidden="true"
              className="
                relative inline-block w-9 h-5
                rounded-full border border-hairline-2
                bg-substrate-2
                peer-checked:bg-[color:var(--sc-foliage)]/25
                peer-checked:border-[color:var(--sc-foliage)]/60
                transition-colors
              "
              style={{ transitionDuration: "var(--sc-dur-quick)" }}
            >
              <span
                className={`
                  absolute top-0.5 left-0.5
                  w-3.5 h-3.5 rounded-full
                  ${experimental ? "bg-foliage" : "bg-ink-dim"}
                  transition-transform
                `}
                style={{
                  transform: experimental ? "translateX(16px)" : "translateX(0)",
                  transitionDuration: "var(--sc-dur-quick)",
                }}
              />
            </span>
            <span className="sc-chrome text-[10px] text-ink-muted">
              {experimental ? "nightly" : "stable"}
            </span>
          </label>
        </div>
      </Card>
    </section>
  );
}
