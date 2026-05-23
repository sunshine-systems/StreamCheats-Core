// Panel surface with hairline border + 12px radius. Matches the
// marketing-repo Card primitive but tuned for in-app density: padding
// defaults to 20px (var(--sp) equivalent) rather than the marketing
// site's 32px. Hover state lifts to panel-2 / hairline-2.
//
// Render as a `<section>` by default (most uses are top-level page
// regions). Use `as` to switch to e.g. `<article>` or `<div>`.

import type { ElementType, ReactNode } from "react";

export interface CardProps {
  children: ReactNode;
  /** Element to render as. Defaults to `section`. */
  as?: ElementType;
  /** Disable the hover state — use for non-interactive surfaces. */
  static?: boolean;
  className?: string;
  /** ARIA label for the section, optional. */
  "aria-label"?: string;
}

export default function Card({
  children,
  as: Tag = "section",
  static: isStatic = false,
  className = "",
  ...rest
}: CardProps) {
  const base =
    "bg-panel border border-hairline rounded-[12px] p-5";
  const hover = isStatic
    ? ""
    : "transition-colors duration-[var(--sc-dur-base)] ease-[var(--sc-ease-out)] hover:bg-panel-2 hover:border-hairline-2";
  return (
    <Tag className={`${base} ${hover} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}
