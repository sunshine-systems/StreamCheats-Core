"use client";

// Home > Software update banner.
//
// Renders only when the daemon's updater reports `available`,
// `downloading`, or `ready`. For every other state we render nothing
// — the Home page should stay quiet when there's no action to take.
//
// Visual per SC-7: copper-accented (copper left border + copper
// download icon). Tap target routes the user to /updates rather than
// triggering the download inline; the Updates page owns the full
// install flow.
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
        relative
        flex items-center gap-4
        bg-panel border border-hairline
        rounded-[12px]
        pl-4 pr-3 py-3
        no-underline
        transition-colors
      "
      style={{
        // Copper left edge — the ONE non-green accent the design
        // system reserves for this pending-update affordance.
        boxShadow: "inset 2px 0 0 0 var(--sc-copper)",
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
          text-copper
        "
        style={{ background: "rgba(213, 130, 88, 0.10)" }}
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
          sc-chrome text-[10px]
          text-copper
          px-3 py-1.5
          border border-[color:var(--sc-copper)]/40
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
