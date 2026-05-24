// Keyboard page — placeholder until native keyboard configuration ships.
// Intentionally bare: just the eyebrow + a muted "Coming soon" line.

import Eyebrow from "../../components/ui/Eyebrow";

export default function KeyboardPage() {
  return (
    <div className="px-5 sm:px-8 py-8 flex flex-col gap-3">
      <Eyebrow>device · keyboard</Eyebrow>
      <p className="sc-chrome text-ink-muted">Coming soon</p>
    </div>
  );
}
