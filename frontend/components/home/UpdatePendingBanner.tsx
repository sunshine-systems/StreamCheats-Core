"use client";

// Home > Software update banner.
//
// Renders only when the daemon's updater reports `available`,
// `downloading`, or `ready`. For every other state we render nothing
// — the Home page should stay quiet when there's no action to take.
//
// Visual: standard panel chrome (bg-panel + hairline border + 12px
// radius) to match the rest of the Home page (DevicesSection,
// UnseenLogCard). The previous one-sided copper inset border read as
// asymmetric / "stickered on"; this version uses the same symmetric
// frame as the other cards with a foliage CTA pill, which keeps the
// banner in the same visual family as its neighbours. The action is
// still clearly an update — Download icon + version text carry the
// signal.
//
// The tap target routes the user to /updates rather than triggering
// the download inline; the Updates page owns the full install flow.
//
// The hook is shared with the global AppHeader / Updates page so we
// do NOT duplicate polling — `useUpdater` debounces refreshes
// internally.

import { Download } from "lucide-react";

import { useUpdater } from "../../lib/hooks/useUpdater";
import { useRelativeHref } from "../../lib/route/href";

export default function UpdatePendingBanner() {
  const { state } = useUpdater();
  const href = useRelativeHref("/updates");

  if (!state) return null;
  if (
    state.kind !== "available" &&
    state.kind !== "downloading" &&
    state.kind !== "ready"
  ) {
    return null;
  }

  const latest = state.latest ?? "";
  const channel = state.channel ?? "stable";

  let title: string;
  if (state.kind === "available") {
    title = `Update available · v${latest}`;
  } else if (state.kind === "downloading") {
    const pct = state.percent != null ? `${state.percent}%` : "…";
    title = `Downloading v${latest} (${pct})`;
  } else {
    title = `Ready to install v${latest}`;
  }

  const ctaLabel =
    state.kind === "ready" ? "Install now" : "Open updates";

  return (
    <a
      href={href}
      role="status"
      aria-live="polite"
      className="
        group
        flex items-center gap-4
        bg-panel border border-hairline
        rounded-[12px]
        px-5 py-4
        no-underline
        transition-colors
        hover:bg-panel-2 hover:border-hairline-2
      "
      style={{
        transitionDuration: "var(--sc-dur-base)",
        transitionTimingFunction: "var(--sc-ease-out)",
      }}
    >
      <div
        aria-hidden="true"
        className="
          shrink-0
          w-9 h-9
          rounded-[8px]
          flex items-center justify-center
          text-foliage
          border border-[color:var(--sc-foliage)]/25
        "
        style={{ background: "rgba(39, 193, 107, 0.10)" }}
      >
        <Download size={18} strokeWidth={1.75} />
      </div>

      <div className="flex-1 min-w-0 flex flex-col">
        <span className="text-ink text-[14px] font-medium leading-tight">
          {title}
        </span>
        <span className="sc-chrome text-[10px] text-ink-dim mt-1">
          channel · {channel}
        </span>
      </div>

      <span
        className="
          shrink-0
          inline-flex items-center
          sc-chrome text-[10px]
          text-foliage
          px-3 py-1.5
          border border-[color:var(--sc-foliage)]/30
          rounded-[3px]
          transition-colors
        "
        style={{
          transitionDuration: "var(--sc-dur-quick)",
        }}
      >
        {ctaLabel} →
      </span>
    </a>
  );
}
