"use client";

// Home > Connected Devices section.
//
// Replaces the prior "StreamCheats device = local daemon" framing with
// two physical-device cards: Mouse (Teensy 4.1, live) and Keyboard
// (Teensy 4.1, permanently coming-soon).
//
// Mouse status chip:
//   * Connected (foliage) — daemon is talking to us
//   * Detecting… (muted) — daemon is unreachable for < 30s
//   * Not detected for Xm Ys (copper) — ≥ 30s since last heartbeat
// When not detected, photo + body are greyed via opacity-50; chip
// keeps full color so the state itself remains legible.
//
// The window is narrow (~730–970px), so when the two-column grid
// can't fit, cards stack — visible content beats horizontal layout.

import Image from "next/image";

import {
  formatDeviceUptime,
  useDeviceUptime,
} from "../../lib/hooks/useDeviceUptime";
import Card from "../ui/Card";

const NOT_DETECTED_GRACE_SECONDS = 30;

export default function DevicesSection() {
  const { detected, notDetectedFor } = useDeviceUptime();

  return (
    <section
      aria-label="Connected devices"
      className="grid gap-4 grid-cols-1 [@media(min-width:640px)]:grid-cols-2"
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
}

function DeviceCardChrome({
  label,
  subtitle,
  greyed,
  chip,
  imgAlt,
}: DeviceCardChromeProps) {
  return (
    <Card aria-label={`${label} device`} static>
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
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
            sizes="(max-width: 640px) 100vw, 50vw"
            style={{ objectFit: "cover" }}
            priority={false}
          />
        </div>
      </div>
    </Card>
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
        px-2.5 py-1
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

  return (
    <DeviceCardChrome
      label="Mouse"
      subtitle="Teensy 4.1"
      greyed={greyed}
      chip={chip}
      imgAlt="Teensy 4.1 microcontroller acting as the mouse device"
    />
  );
}

function KeyboardCard() {
  const chip = (
    <span
      className="
        inline-flex items-center gap-2
        px-2.5 py-1
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
    />
  );
}
