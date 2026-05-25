"use client";

// Home — the landing page mounted at `/` inside the AppShell.
//
// Composed of four sections per SC-7 (revised after first-user review):
//   1. Software update banner (only when an update is pending)
//   2. Connected Devices section (Mouse + Keyboard cards)
//   3. Unseen warnings / errors card (soft 0-state)
//   4. Update status card (persistent quiet companion to the banner)
//
// (The bug report action moved to the global sidebar.)
//
// Stripped header (v2): no H1 / lede paragraph — the eyebrow + version
// chip alone do the job. Three real cards below carry the content.
//
// The build-version chip sits inline with the eyebrow (justify-between).
// It pulls from useHealthDetail when the daemon is reachable and falls
// back to the bundled frontend package version otherwise — the only
// "always there" version source we have without adding a new endpoint.

import Eyebrow from "../components/ui/Eyebrow";
import DevicesSection from "../components/home/DevicesSection";
import UpdatePendingBanner from "../components/home/UpdatePendingBanner";
import UnseenLogCard from "../components/home/UnseenLogCard";
import UpdateStatusCard from "../components/home/UpdateStatusCard";
import { useHealthDetail } from "../lib/hooks/useHealthDetail";
import pkg from "../package.json";

export default function HomePage() {
  const detail = useHealthDetail();
  const version = detail?.version ?? pkg.version;

  return (
    <div className="px-5 sm:px-8 py-8 flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <Eyebrow>home · status</Eyebrow>
        <span
          className="sc-chrome text-[10px] text-ink-dim shrink-0"
          aria-label={`App version v${version}`}
        >
          v{version}
        </span>
      </div>

      <UpdatePendingBanner />
      <DevicesSection />
      <UnseenLogCard />
      <UpdateStatusCard />
    </div>
  );
}
