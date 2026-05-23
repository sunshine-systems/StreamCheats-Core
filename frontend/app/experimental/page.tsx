// Experimental Support page — stub at SC-6. SC-8 builds the real
// page: API selector dropdown (kmbox-net only for now), enable /
// disable toggle wired to new daemon control endpoints.

import PendingStub from "../../components/ui/PendingStub";

export default function ExperimentalPage() {
  return (
    <PendingStub
      eyebrow="experimental · support"
      title="Experimental Support"
      ticket="SC-8"
      blurb="Toggle additional protocol listeners (kmbox-net and friends) so other tools can drive the device."
    />
  );
}
