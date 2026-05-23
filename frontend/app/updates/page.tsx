// Updates page — stub at SC-6. SC-9 builds the unified software +
// firmware update view (consuming the SC-4 updater APIs for the
// software half and new firmware endpoints from SC-13 for the
// Teensy half).

import PendingStub from "../../components/ui/PendingStub";

export default function UpdatesPage() {
  return (
    <PendingStub
      eyebrow="updates · software + firmware"
      title="Updates"
      ticket="SC-9"
      blurb="Unified view of the app update channel and Teensy firmware updates, plus manual flash."
    />
  );
}
