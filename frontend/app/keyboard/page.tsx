// Keyboard page — final v1 content per SC-6. Same shape as the Mouse
// page: header + a planned-settings list. The StreamCheats device
// handles keyboard passthrough natively; this surface is the eventual
// configuration UI, not a stub to be replaced.

import PageHeader from "../../components/ui/PageHeader";
import PlannedSettings from "../../components/ui/PlannedSettings";

export default function KeyboardPage() {
  return (
    <div className="px-5 sm:px-8 py-8 flex flex-col gap-6">
      <PageHeader
        eyebrow="device · keyboard"
        title="Keyboard"
        sub="Keyboard configuration lands in a future release. The StreamCheats device controls keyboard input natively today."
      />
      <PlannedSettings
        title="planned settings"
        items={[
          { label: "Key remapping", hint: "Per-key bind table, including modifiers." },
          { label: "Macros", hint: "Recorded or scripted sequences, layer-scoped." },
          { label: "Layer switching", hint: "Momentary and toggle layer bindings." },
          { label: "Debounce", hint: "Per-key debounce window in milliseconds." },
          { label: "Repeat rate", hint: "Initial delay + repeat interval." },
        ]}
      />
    </div>
  );
}
