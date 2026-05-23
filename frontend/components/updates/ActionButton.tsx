// Compact action button used throughout the Updates page. Two tones:
//   - foliage (the default — "Check now", "Download", "Install")
//   - copper  (reserved for the single most-urgent next step, e.g.
//             "Install & restart" once a download is ready)
// Plus a `ghost` variant for low-emphasis chrome (filter chips don't
// use this — they're their own component).
//
// Disabled state surfaces with reduced opacity + `cursor: not-allowed`
// + an optional `data-tooltip` attribute consumers can hang a tooltip
// off. Keep this primitive small — anything richer (icons, complex
// composition) builds on top.

import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ActionButtonTone = "foliage" | "copper" | "ghost";

export interface ActionButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  tone?: ActionButtonTone;
  children: ReactNode;
}

const TONE_CLASS: Record<ActionButtonTone, string> = {
  foliage:
    "text-foliage border-[color:var(--sc-foliage)]/45 hover:bg-[color:var(--sc-foliage)]/10",
  copper:
    "text-copper border-[color:var(--sc-copper)]/45 hover:bg-[color:var(--sc-copper)]/10",
  ghost:
    "text-ink-muted border-hairline hover:text-ink hover:border-hairline-2",
};

export default function ActionButton({
  tone = "foliage",
  className = "",
  disabled,
  children,
  ...rest
}: ActionButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`
        inline-flex items-center gap-2
        sc-chrome text-[10px]
        px-3 py-1.5
        border rounded-[3px]
        bg-transparent
        transition-colors
        ${TONE_CLASS[tone]}
        ${disabled ? "opacity-50 cursor-not-allowed hover:bg-transparent" : "cursor-pointer"}
        ${className}
      `}
      style={{
        transitionDuration: "var(--sc-dur-quick)",
        transitionTimingFunction: "var(--sc-ease-out)",
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
