// Mouse page — final v1 content per SC-6. The StreamCheats device
// controls mouse input natively; the configuration surface listed
// here is the eventual shape, not a stub to be replaced. Each setting
// renders with a "planned" chip so users know what's coming without
// believing they can change it today.

import PageHeader from "../../components/ui/PageHeader";
import PlannedSettings from "../../components/ui/PlannedSettings";

export default function MousePage() {
  return (
    <div className="px-5 sm:px-8 py-8 flex flex-col gap-6">
      <PageHeader
        eyebrow="device · mouse"
        title="Mouse"
        sub="Mouse configuration lands in a future release. The StreamCheats device controls mouse input natively today."
      />
      <PlannedSettings
        title="planned settings"
        items={[
          { label: "DPI", hint: "Per-step DPI shifter with hold-to-snipe support." },
          { label: "Polling rate", hint: "125 / 500 / 1000 / 4000 Hz selector." },
          { label: "Lift-off distance", hint: "Sensor cut-off height in 0.1mm steps." },
          { label: "Button remapping", hint: "Re-bind any of the five buttons + tilt." },
          { label: "Motion smoothing", hint: "Optional low-pass filter on raw deltas." },
        ]}
      />
    </div>
  );
}
