// Small chrome label with the canonical `//` prefix. JetBrains Mono,
// tracked uppercase, foliage by default. Use copper variant only for
// the rare cases the design system reserves it (Updates pending,
// Experimental Support status chips).

import type { ReactNode } from "react";

export type EyebrowTone = "foliage" | "copper" | "muted";

export interface EyebrowProps {
  children: ReactNode;
  tone?: EyebrowTone;
  className?: string;
}

const TONE_CLASS: Record<EyebrowTone, string> = {
  foliage: "text-foliage",
  copper: "text-copper",
  muted: "text-ink-dim",
};

export default function Eyebrow({
  children,
  tone = "foliage",
  className = "",
}: EyebrowProps) {
  return (
    <span
      className={`sc-chrome text-[11px] leading-none ${TONE_CLASS[tone]} ${className}`}
    >
      <span aria-hidden="true" className="opacity-60 mr-1">{"//"}</span>
      {children}
    </span>
  );
}
