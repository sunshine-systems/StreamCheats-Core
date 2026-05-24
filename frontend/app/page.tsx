"use client";

// Home — the landing page mounted at `/` inside the AppShell.
//
// Composed of three sections per SC-7 (revised after first-user review):
//   1. Software update banner (only when an update is pending)
//   2. Connected Devices section (Mouse + Keyboard cards)
//   3. Unseen warnings / errors card (soft 0-state)
//
// A small build-version chip sits top-right of the PageHeader. It
// pulls from useHealthDetail when the daemon is reachable and falls
// back to the bundled frontend package version otherwise — the only
// "always there" version source we have without adding a new endpoint.

import PageHeader from "../components/ui/PageHeader";
import DevicesSection from "../components/home/DevicesSection";
import UpdatePendingBanner from "../components/home/UpdatePendingBanner";
import UnseenLogCard from "../components/home/UnseenLogCard";
import { useHealthDetail } from "../lib/hooks/useHealthDetail";
import pkg from "../package.json";

export default function HomePage() {
  const detail = useHealthDetail();
  const version = detail?.version ?? pkg.version;

  return (
    <div className="px-5 sm:px-8 py-8 flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          eyebrow="home · status"
          title="Home"
          sub="At-a-glance status for your StreamCheats device and the local daemon."
          className="flex-1 min-w-0"
        />
        <span
          className="sc-chrome text-[10px] text-ink-dim shrink-0 pt-1"
          aria-label={`App version v${version}`}
        >
          v{version}
        </span>
      </div>

      <UpdatePendingBanner />
      <DevicesSection />
      <UnseenLogCard />
    </div>
  );
}
