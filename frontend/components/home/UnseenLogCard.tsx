"use client";

// Home > Unseen warnings / errors card.
//
// Renders a big Fraunces count + a "view all" deep link into /logs.
// When the count is zero we still render the card (acts as a calm
// "all clear" indicator) — empty state matters on a home page.
//
// The preview entries below the count are pulled from the same hook
// so they stay consistent with the badge. Each row is severity chip
// + message + relative timestamp.

import { ArrowUpRight } from "lucide-react";

import { getBridge } from "../../lib/api/client";
import { useUnseenLogSummary } from "../../lib/hooks/useUnseenLogCount";
import { useRelativeHref } from "../../lib/route/href";
import Card from "../ui/Card";

/**
 * Open the dedicated logs window pre-filtered to WARN + ERROR. In
 * Electron the bridge spawns a BrowserWindow at `/logs/window/?levels=...`;
 * in a plain browser dev session we fall back to a same-tab navigation
 * so the link is still useful.
 */
async function openLogsFiltered(fallbackHref: string) {
  const params = "ERROR,WARN";
  const bridge = getBridge();
  if (bridge && typeof bridge.openLogsWindow === "function") {
    try {
      await bridge.openLogsWindow({ levels: params });
      return;
    } catch {
      /* fall through */
    }
  }
  if (typeof window !== "undefined") {
    const sep = fallbackHref.includes("?") ? "&" : "?";
    window.location.href = `${fallbackHref}${sep}levels=${encodeURIComponent(
      params,
    )}`;
  }
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function severityTone(level: string): string {
  const u = level.toUpperCase();
  if (u === "ERROR") return "text-danger";
  if (u === "WARN") return "text-warn";
  return "text-ink-muted";
}

export default function UnseenLogCard() {
  const summary = useUnseenLogSummary(3);
  const href = useRelativeHref("/logs/window");
  const onViewAll = () => {
    void openLogsFiltered(href);
  };

  const hasUnseen = summary.count > 0;

  // 0-state per SC-7 follow-up: drop the big Fraunces "0" — a fresh
  // install shouldn't shout a numeric badge at the user. Render a
  // single muted line in JetBrains Mono and keep the card chrome.
  if (!hasUnseen) {
    return (
      <Card aria-label="Unseen warnings and errors" static>
        <div className="flex items-center justify-between gap-4">
          <span
            className="sc-chrome text-[11px] text-ink-muted"
            aria-live="polite"
          >
            No unseen warnings or errors
          </span>
          <button
            type="button"
            onClick={onViewAll}
            className="
              shrink-0
              inline-flex items-center gap-1.5
              sc-chrome text-[10px] text-foliage
              px-2.5 py-1.5
              border border-[color:var(--sc-foliage)]/30
              rounded-[3px]
              transition-colors
              cursor-pointer bg-transparent
            "
            style={{
              transitionDuration: "var(--sc-dur-quick)",
            }}
          >
            view all
            <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card aria-label="Unseen warnings and errors" static>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col min-w-0">
          <span
            className="sc-display text-ink leading-none"
            style={{
              fontSize: "clamp(2.25rem, 7vw, 3rem)",
              // Count-up flourish per SC-7: foliage tinted when there
              // are unseen items. The numeric value updates as the log
              // stream feeds new events into the hook — no separate
              // animation loop required.
              color: "var(--sc-foliage)",
              fontVariantNumeric: "tabular-nums",
              transition:
                "color var(--sc-dur-base) var(--sc-ease-out)",
            }}
            aria-live="polite"
          >
            {summary.count}
          </span>
          <span className="sc-chrome text-[10px] text-ink-dim mt-2">
            unseen warnings / errors
          </span>
        </div>

        <button
          type="button"
          onClick={onViewAll}
          className="
            shrink-0
            inline-flex items-center gap-1.5
            sc-chrome text-[10px] text-foliage
            px-2.5 py-1.5
            border border-[color:var(--sc-foliage)]/30
            rounded-[3px]
            transition-colors
            cursor-pointer bg-transparent
          "
          style={{
            transitionDuration: "var(--sc-dur-quick)",
          }}
        >
          view all
          <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <ul className="mt-5 flex flex-col divide-y divide-hairline">
          {summary.preview
            .slice()
            .reverse()
            .map((entry, idx) => (
              <li
                key={`${entry.ts}-${idx}`}
                className="
                  flex items-center gap-3
                  py-2.5 first:pt-0 last:pb-0
                  min-w-0
                "
              >
                <span
                  className={`
                    sc-chrome text-[9px]
                    px-1.5 py-0.5
                    border border-hairline rounded-[2px]
                    shrink-0
                    ${severityTone(entry.level)}
                  `}
                >
                  {entry.level.toLowerCase()}
                </span>
                <span
                  className="text-ink-muted text-[12px] font-mono truncate min-w-0 flex-1"
                  title={entry.line}
                >
                  {entry.line}
                </span>
                <span className="text-ink-dim text-[11px] font-mono shrink-0">
                  {relativeTime(entry.ts)}
                </span>
              </li>
            ))}
        </ul>

      <div className="mt-4 flex items-center gap-4 sc-chrome text-[10px] text-ink-dim">
        <span>
          <span className="text-danger">{summary.errorCount}</span>{" "}
          error{summary.errorCount === 1 ? "" : "s"}
        </span>
        <span aria-hidden="true" className="opacity-40">
          ·
        </span>
        <span>
          <span className="text-warn">{summary.warnCount}</span>{" "}
          warning{summary.warnCount === 1 ? "" : "s"}
        </span>
      </div>
    </Card>
  );
}
