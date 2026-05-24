"use client";

// Home > Connected Devices section.
//
// Two physical-device cards: Mouse (Teensy 4.1, live heartbeat) and
// Keyboard (Teensy 4.1, permanently coming-soon).
//
// Card content (top → bottom):
//   1. Title (Fraunces)             — "Mouse" / "Keyboard"
//   2. Subtitle (.sc-chrome dim)    — "Teensy 4.1"
//   3. Image                        — `/teensy-4.1.jpg`
//   4. Configure link (.sc-chrome)  — routes to /mouse or /keyboard
// The status chip sits in the card's top-right corner. Mouse keeps
// its full-colour chip even when the body is greyed, so the actual
// status remains legible.
//
// Mouse status chip — driven by `useDeviceUptime()` which now reads
// the heartbeat-derived `installed_version` field rather than the
// daemon loopback connection:
//   * Connected (foliage) — heartbeat fresh (< 10s)
//   * Detecting… (muted) — < 30s since heartbeat lost OR < 30s since
//     page mount with no heartbeat ever seen
//   * Not detected for Xm Ys (copper) — ≥ 30s with no heartbeat
//
// Layout: ALWAYS two columns side-by-side. The Electron window is
// ~730px wide on 1080p; stacking would push the unseen-log card
// below the fold. The image scales down with the column instead.

import Image from "next/image";
import { ArrowUpRight } from "lucide-react";

import {
  formatDeviceUptime,
  useDeviceUptime,
} from "../../lib/hooks/useDeviceUptime";
import { useRelativeHref } from "../../lib/route/href";
import Card from "../ui/Card";

const NOT_DETECTED_GRACE_SECONDS = 30;

export default function DevicesSection() {
  const { detected, notDetectedFor } = useDeviceUptime();

  return (
    <section
      aria-label="Connected devices"
      className="grid grid-cols-2 gap-3"
    >
      <MouseCard detected={detected} notDetectedFor={notDetectedFor} />
      <KeyboardCard />
    </section>
  );
}

interface DeviceCardChromeProps {
  label: string;
  subtitle: string;
  greyed: boolean;
  chip: React.ReactNode;
  imgAlt: string;
  action: React.ReactNode;
}

function DeviceCardChrome({
  label,
  subtitle,
  greyed,
  chip,
  imgAlt,
  action,
}: DeviceCardChromeProps) {
  return (
    <Card aria-label={`${label} device`} static>
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div
            className={`flex flex-col min-w-0 ${greyed ? "opacity-50" : ""}`}
          >
            <span className="sc-display text-ink text-[18px] leading-tight font-medium">
              {label}
            </span>
            <span className="sc-chrome text-[10px] text-ink-dim mt-1">
              {subtitle}
            </span>
          </div>
          {chip}
        </div>

        <div
          className={`
            relative w-full
            aspect-[4/3]
            rounded-[8px]
            overflow-hidden
            bg-substrate-2 border border-hairline
            ${greyed ? "opacity-50" : ""}
          `}
        >
          <Image
            src="/teensy-4.1.jpg"
            alt={imgAlt}
            fill
            sizes="(max-width: 970px) 50vw, 480px"
            style={{ objectFit: "cover" }}
            priority={false}
          />
        </div>

        {action}
      </div>
    </Card>
  );
}

// Shared visual treatment for the bottom-of-card action. Renders as an
// <a> when enabled (preserves navigation semantics + middle-click) and
// a real disabled <button> when not — both look identical apart from
// the muted ink and not-allowed cursor.
const ACTION_BASE_CLASS = `
  self-start
  inline-flex items-center gap-1
  px-2 py-1
  border rounded-[3px]
  sc-chrome text-[10px]
  bg-transparent
  no-underline
  transition-colors
`;

function ConfigureAction({
  href,
  ariaLabel,
}: {
  href: string;
  ariaLabel: string;
}) {
  return (
    <a
      href={href}
      className={`${ACTION_BASE_CLASS} text-foliage border-[color:var(--sc-foliage)]/40 hover:border-[color:var(--sc-foliage)]/70`}
      style={{ transitionDuration: "var(--sc-dur-quick)" }}
      aria-label={ariaLabel}
      role="button"
    >
      Configure
      <ArrowUpRight size={11} strokeWidth={2} aria-hidden="true" />
    </a>
  );
}

function DisabledAction({
  label,
  ariaLabel,
}: {
  label: string;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      disabled
      className={`${ACTION_BASE_CLASS} text-ink-dim border-hairline opacity-50 cursor-not-allowed`}
      aria-label={ariaLabel}
    >
      {label}
    </button>
  );
}

function MouseCard({
  detected,
  notDetectedFor,
}: {
  detected: boolean;
  notDetectedFor: number | null;
}) {
  const greyed = !detected;
  const configureHref = useRelativeHref("/mouse");

  let chipLabel: string;
  let chipClass: string;
  let chipDotClass: string;

  if (detected) {
    chipLabel = "Connected";
    chipClass = "text-foliage border-[color:var(--sc-foliage)]/40";
    chipDotClass = "bg-foliage";
  } else if ((notDetectedFor ?? 0) < NOT_DETECTED_GRACE_SECONDS) {
    chipLabel = "Detecting…";
    chipClass = "text-ink-dim border-hairline";
    chipDotClass = "bg-ink-dim";
  } else {
    chipLabel = `Not detected for ${formatDeviceUptime(notDetectedFor)}`;
    chipClass = "text-copper border-[color:var(--sc-copper)]/40";
    chipDotClass = "bg-copper";
  }

  const chip = (
    <span
      className={`
        inline-flex items-center gap-2
        px-2 py-1
        border rounded-[3px]
        sc-chrome text-[10px]
        shrink-0 whitespace-nowrap
        ${chipClass}
      `}
      role="status"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className={`w-1.5 h-1.5 rounded-full ${chipDotClass}`}
      />
      {chipLabel}
    </span>
  );

  const action = detected ? (
    <ConfigureAction href={configureHref} ariaLabel="Configure mouse" />
  ) : (
    <DisabledAction label="Not detected" ariaLabel="Mouse not detected" />
  );

  return (
    <DeviceCardChrome
      label="Mouse"
      subtitle="Teensy 4.1"
      greyed={greyed}
      chip={chip}
      imgAlt="Teensy 4.1 microcontroller acting as the mouse device"
      action={action}
    />
  );
}

function KeyboardCard() {
  // Keyboard is permanently coming-soon — the action is a disabled
  // button so the user can see the state at a glance rather than
  // following a link into a placeholder page.
  const chip = (
    <span
      className="
        inline-flex items-center gap-2
        px-2 py-1
        border border-hairline rounded-[3px]
        sc-chrome text-[10px] text-ink-dim
        shrink-0 whitespace-nowrap
      "
    >
      <span
        aria-hidden="true"
        className="w-1.5 h-1.5 rounded-full bg-ink-dim"
      />
      Coming soon
    </span>
  );

  return (
    <DeviceCardChrome
      label="Keyboard"
      subtitle="Teensy 4.1"
      greyed={true}
      chip={chip}
      imgAlt="Teensy 4.1 microcontroller (keyboard role, not yet available)"
      action={
        <DisabledAction label="Coming soon" ariaLabel="Keyboard coming soon" />
      }
    />
  );
}
