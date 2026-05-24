// Mouse page — placeholder until native mouse configuration ships.
// Intentionally bare: just the eyebrow + a muted "Coming soon" line.

import Eyebrow from "../../components/ui/Eyebrow";

export default function MousePage() {
  return (
    <div className="px-5 sm:px-8 py-8 flex flex-col gap-3">
      <Eyebrow>device · mouse</Eyebrow>
      <p className="sc-chrome text-ink-muted">Coming soon</p>
    </div>
  );
}
