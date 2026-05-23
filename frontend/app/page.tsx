// Home — the landing page mounted at `/` inside the AppShell.
//
// Composed of three sections per SC-7:
//   1. Software update banner (only when an update is pending)
//   2. Device status card (daemon connection + version/port)
//   3. Unseen warnings / errors card (count + 3 most-recent rows)
//
// The update banner renders at the top when present so a pending
// update is the first thing the user sees on launch. When there's
// nothing to do, the page reads as a calm 2-section column.

import PageHeader from "../components/ui/PageHeader";
import DeviceStatusCard from "../components/home/DeviceStatusCard";
import UpdatePendingBanner from "../components/home/UpdatePendingBanner";
import UnseenLogCard from "../components/home/UnseenLogCard";

export default function HomePage() {
  return (
    <div className="px-5 sm:px-8 py-8 flex flex-col gap-6">
      <PageHeader
        eyebrow="home · status"
        title="Home"
        sub="At-a-glance status for your StreamCheats device and the local daemon."
      />

      <UpdatePendingBanner />
      <DeviceStatusCard />
      <UnseenLogCard />
    </div>
  );
}
