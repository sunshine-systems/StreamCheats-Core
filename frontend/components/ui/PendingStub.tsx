// Shared "implementation pending" stub used by routes that get real
// content in a later sub-issue (Home, Updates, Experimental Support,
// Logs at SC-6 land). One primitive so the empty-state typography
// stays consistent and so the sub-issue PRs can grep for it and rip
// it out in one pass.

import Card from "./Card";
import Eyebrow from "./Eyebrow";
import PageHeader from "./PageHeader";

export interface PendingStubProps {
  eyebrow: string;
  title: string;
  /** Linear sub-issue identifier this page belongs to, e.g. "SC-7". */
  ticket: string;
  /** One-line summary of what the real page will do. */
  blurb: string;
}

export default function PendingStub({
  eyebrow,
  title,
  ticket,
  blurb,
}: PendingStubProps) {
  return (
    <div className="px-5 sm:px-8 py-8 flex flex-col gap-6">
      <PageHeader eyebrow={eyebrow} title={title} sub={blurb} />
      <Card aria-label="Implementation pending" static>
        <div className="flex flex-col gap-2">
          <Eyebrow tone="muted">implementation pending</Eyebrow>
          <p className="text-ink-muted text-[14px] leading-relaxed">
            This page is a placeholder. The real implementation lands in{" "}
            <span className="font-mono text-ink">{ticket}</span>.
          </p>
        </div>
      </Card>
    </div>
  );
}
