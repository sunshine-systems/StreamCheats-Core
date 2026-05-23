// Read-only list of settings we intend to expose on a peripheral page
// (Mouse, Keyboard) but haven't built yet. Renders each row as a
// label on the left + a "planned" chip on the right. Visually loud
// enough to communicate "this is the shape of the eventual surface"
// without pretending the controls are interactive.

import Card from "./Card";

export interface PlannedSetting {
  /** Human-facing setting name. */
  label: string;
  /** Short one-line description, optional. */
  hint?: string;
}

export interface PlannedSettingsProps {
  items: PlannedSetting[];
  /** Optional title rendered above the list (eyebrow-style). */
  title?: string;
}

export default function PlannedSettings({ items, title }: PlannedSettingsProps) {
  return (
    <Card aria-label={title ?? "Planned settings"} static>
      {title ? (
        <div className="sc-chrome text-[11px] text-ink-dim mb-3">
          {title}
        </div>
      ) : null}
      <ul className="flex flex-col divide-y divide-hairline">
        {items.map((item) => (
          <li
            key={item.label}
            className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
          >
            <div className="flex flex-col min-w-0">
              <span className="text-ink-muted text-[14px]">{item.label}</span>
              {item.hint ? (
                <span className="text-ink-dim text-[12px] mt-0.5">
                  {item.hint}
                </span>
              ) : null}
            </div>
            <span className="sc-chrome text-[10px] text-ink-dim px-2 py-1 border border-hairline rounded-[3px] shrink-0">
              planned
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
