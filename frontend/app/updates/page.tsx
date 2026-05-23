// Updates page (SC-9). Unifies the existing SC-4 software updater
// with the SC-10 firmware updater under one scroll. Two stacked
// sections — software on top, firmware below — to match the reading
// rhythm SC-9 specifies (no tabs; the window is too narrow for hidden
// state to pay for itself).
//
// Each section owns its own data hooks; the page is purely
// composition. Flash actions probe the SC-10 501 stubs and surface a
// clear "coming in SC-13" message when the daemon hasn't been
// upgraded yet.

import PageHeader from "../../components/ui/PageHeader";
import SoftwareUpdatesSection from "../../components/updates/SoftwareUpdatesSection";
import FirmwareUpdatesSection from "../../components/updates/FirmwareUpdatesSection";

export default function UpdatesPage() {
  return (
    <div className="px-5 sm:px-8 py-8 flex flex-col gap-8">
      <PageHeader
        eyebrow="updates · software + firmware"
        title="Updates"
        sub="Keep the app and your StreamCheats device firmware on the latest stable (or nightly, if you opt in)."
      />

      <SoftwareUpdatesSection />

      <div aria-hidden="true" className="sc-hairline" />

      <FirmwareUpdatesSection />
    </div>
  );
}
