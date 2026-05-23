// Canonical page header: eyebrow + Fraunces H1 + optional sub. Sits
// at the top of every routed page inside the app shell. Tighter than
// the marketing-site equivalent because the app window is a narrow
// vertical panel (~730–970px wide) — Fraunces is reserved for the
// page title only; everything else is sans/mono.

import type { ReactNode } from "react";
import Eyebrow, { type EyebrowTone } from "./Eyebrow";

export interface PageHeaderProps {
  /** Short chrome label rendered above the title, e.g. `device · mouse`. */
  eyebrow?: ReactNode;
  eyebrowTone?: EyebrowTone;
  /** Page title — set in Fraunces via `.sc-display`. */
  title: ReactNode;
  /** Optional one-line lede beneath the title. */
  sub?: ReactNode;
  className?: string;
}

export default function PageHeader({
  eyebrow,
  eyebrowTone = "foliage",
  title,
  sub,
  className = "",
}: PageHeaderProps) {
  return (
    <header className={`flex flex-col gap-3 ${className}`}>
      {eyebrow ? <Eyebrow tone={eyebrowTone}>{eyebrow}</Eyebrow> : null}
      <h1
        className="sc-display text-ink font-medium leading-[1.1]"
        style={{ fontSize: "clamp(1.75rem, 4vw, 2.5rem)" }}
      >
        {title}
      </h1>
      {sub ? (
        <p className="text-ink-muted text-[15px] leading-relaxed max-w-prose">
          {sub}
        </p>
      ) : null}
    </header>
  );
}
