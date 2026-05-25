"use client";

// Home > Update status card.
//
// Persistent quiet companion to UpdatePendingBanner: the banner only
// shows while an update is actively pending/downloading/ready; this
// card is ALWAYS visible and reports the current state in one line
// plus a deep link into /updates.
//
// State derivation mirrors /updates/page.tsx (single source of truth):
//   const deviceSeen = fw.status?.installed_version != null;
//   const swPending = ["available","downloading","ready"].includes(sw.state.kind);
//   const fwPending = deviceSeen && ["available","downloading","ready","flashing"]
//                       .includes(fw.status.state.kind);
//
// Visual:
//   - muted Lucide icon (Download for pending, Check for up-to-date)
//   - headline in sc-display, foliage when pending else default ink
//   - sub-line in sc-chrome / ink-dim — either "Software/Firmware update
//     available" or "Last checked <relative time>"
//   - small "Open →" link on the right pointing at /updates

import { Check, Download } from "lucide-react";

import { useUpdater } from "../../lib/hooks/useUpdater";
import { useFirmwareStatus } from "../../lib/hooks/useFirmwareStatus";
import { useRelativeHref } from "../../lib/route/href";
import Card from "../ui/Card";

const SW_PENDING_KINDS = new Set(["available", "downloading", "ready"]);
const FW_PENDING_KINDS = new Set([
  "available",
  "downloading",
  "ready",
  "flashing",
]);

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Math.max(0, Date.now() - then);
  const sec = Math.round(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}

// Pick the later of two ISO timestamps, ignoring null/invalid values.
// Returns null when neither is usable.
function pickLatestIso(
  a: string | undefined | null,
  b: string | undefined | null
): string | null {
  const av = a ? new Date(a).getTime() : NaN;
  const bv = b ? new Date(b).getTime() : NaN;
  const aValid = Number.isFinite(av);
  const bValid = Number.isFinite(bv);
  if (aValid && bValid) return av >= bv ? (a ?? null) : (b ?? null);
  if (aValid) return a ?? null;
  if (bValid) return b ?? null;
  return null;
}

export default function UpdateStatusCard() {
  const sw = useUpdater();
  const fw = useFirmwareStatus();
  const href = useRelativeHref("/updates");

  // Mirror the gating from /updates/page.tsx: firmware UI only counts
  // after a heartbeat has parsed an installed version. Until then
  // firmware kinds (even "available") are not trusted.
  const deviceSeen = fw.status?.installed_version != null;

  const swKind = sw.state?.kind;
  const fwKind = fw.status?.state.kind;
  const swPending = swKind != null && SW_PENDING_KINDS.has(swKind);
  const fwPending = deviceSeen && fwKind != null && FW_PENDING_KINDS.has(fwKind);
  const anyPending = swPending || fwPending;

  const headline = anyPending ? "Update available" : "No updates available";
  const Icon = anyPending ? Download : Check;
  const headlineColor = anyPending ? "text-foliage" : "text-ink";

  let subLine: string;
  if (anyPending) {
    if (swPending && fwPending) {
      subLine = "Software + Firmware updates available";
    } else if (swPending) {
      subLine = "Software update available";
    } else {
      subLine = "Firmware update available";
    }
  } else {
    // Fall back to whichever checked_at we have — software and firmware
    // both expose it inside the state object when the daemon last ran
    // a check.
    const swChecked = sw.state?.checked_at;
    const fwChecked = deviceSeen ? fw.status?.state.checked_at : undefined;
    const lastChecked = pickLatestIso(swChecked, fwChecked);
    subLine = lastChecked
      ? `Last checked ${relativeTime(lastChecked)}`
      : "Not checked yet";
  }

  return (
    <Card aria-label="Update status" static>
      <div className="flex items-center gap-3">
        <Icon
          size={18}
          strokeWidth={1.75}
          aria-hidden="true"
          className="shrink-0 text-ink-dim"
        />
        <div className="flex flex-col min-w-0 flex-1">
          <span
            className={`sc-display text-[15px] leading-tight ${headlineColor}`}
          >
            {headline}
          </span>
          <span className="sc-chrome text-[10px] text-ink-dim mt-1">
            {subLine}
          </span>
        </div>
        <a
          href={href}
          className="
            shrink-0
            inline-flex items-center gap-1
            sc-chrome text-[10px] text-foliage
            px-2.5 py-1.5
            border border-[color:var(--sc-foliage)]/30
            rounded-[3px]
            no-underline
            transition-colors
          "
          style={{ transitionDuration: "var(--sc-dur-quick)" }}
          aria-label="Open Update Center"
        >
          Open Update Center →
        </a>
      </div>
    </Card>
  );
}
