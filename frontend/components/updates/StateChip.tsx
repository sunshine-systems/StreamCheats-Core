// Small status chip shared between the software and firmware sections
// of the Updates page. Maps a kind ("up_to_date" | "available" |
// "downloading" | "ready" | "failed" | "idle" | "unknown") onto the
// matching foliage / copper / warn / danger / dim tone.
//
// Visual matches the chips used on the Home page (DeviceStatusCard,
// UpdatePendingBanner) — dot + uppercase mono label, 1px border, 3px
// radius. Stays compact so it can sit beside a version string.

import type { ReactNode } from "react";

export type StateChipTone =
  | "foliage"
  | "copper"
  | "warn"
  | "danger"
  | "muted";

export interface StateChipProps {
  tone: StateChipTone;
  children: ReactNode;
  className?: string;
}

const TONE_CLASS: Record<StateChipTone, string> = {
  foliage: "text-foliage border-[color:var(--sc-foliage)]/40",
  copper: "text-copper border-[color:var(--sc-copper)]/40",
  warn: "text-warn border-[color:var(--sc-warn)]/40",
  danger: "text-danger border-[color:var(--sc-danger)]/40",
  muted: "text-ink-dim border-hairline",
};

const DOT_CLASS: Record<StateChipTone, string> = {
  foliage: "bg-foliage",
  copper: "bg-copper",
  warn: "bg-warn",
  danger: "bg-danger",
  muted: "bg-ink-dim",
};

export default function StateChip({
  tone,
  children,
  className = "",
}: StateChipProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={`
        inline-flex items-center gap-2
        px-2.5 py-1
        border rounded-[3px]
        sc-chrome text-[10px]
        shrink-0
        ${TONE_CLASS[tone]}
        ${className}
      `}
    >
      <span
        aria-hidden="true"
        className={`w-1.5 h-1.5 rounded-full ${DOT_CLASS[tone]}`}
      />
      {children}
    </span>
  );
}
