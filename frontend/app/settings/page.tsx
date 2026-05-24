"use client";

// Settings page — the live home for the existing nightly-channel
// toggle, re-wrapped in the new design tokens per SC-6. The explicit
// "Check for updates now" affordance lives on the Update Center
// ("Check again") instead; toggling the channel here re-runs an
// update check automatically so the status line reflects the new
// channel without an extra click.

import { useUpdater } from "../../lib/hooks/useUpdater";
import Card from "../../components/ui/Card";
import PageHeader from "../../components/ui/PageHeader";

export default function SettingsPage() {
  const u = useUpdater();
  const s = u.state;

  let statusLine = "No checks have run yet.";
  if (s) {
    switch (s.kind) {
      case "up_to_date":
        statusLine = `Up to date · v${s.installed}`;
        break;
      case "available":
        statusLine = `Update available · v${s.latest} (${s.channel})`;
        break;
      case "downloading":
        statusLine = `Downloading v${s.latest}…`;
        break;
      case "ready":
        statusLine = `Ready to install · v${s.latest}`;
        break;
      case "failed":
        statusLine = `Last check failed: ${s.error ?? "unknown"}`;
        break;
      case "idle":
      default:
        statusLine = "No checks have run yet.";
    }
  }

  return (
    <div className="px-5 sm:px-8 py-8 flex flex-col gap-6">
      <PageHeader
        eyebrow="settings"
        title="Settings"
        sub="Configuration knobs for the daemon and the in-app updater."
      />

      <Card aria-label="Update channel" static>
        <div className="flex flex-col gap-3">
          <span className="sc-chrome text-[11px] text-foliage">
            update channel
          </span>
          <h2 className="sc-display text-ink text-[20px] font-medium leading-tight">
            Build channel
          </h2>
          <p className="text-ink-muted text-[13px] leading-relaxed">
            {statusLine}
          </p>

          <label
            className={`flex items-center gap-2.5 text-[13px] text-ink-muted mt-1 ${u.busy ? "cursor-wait" : "cursor-pointer"}`}
          >
            <input
              type="checkbox"
              checked={u.experimental}
              disabled={u.busy}
              onChange={async (e) => {
                // Toggle the channel, then re-run an update check so
                // the status line above reflects what's available on
                // the newly-selected channel (nightly users want to
                // see the latest pre-release surface immediately, and
                // users opting back out want any stale nightly
                // notification to clear). The Update Center owns the
                // explicit "Check again" button for manual re-checks.
                await u.setNightly(e.target.checked);
                await u.runCheck();
              }}
              className="accent-[var(--sc-foliage)]"
            />
            Receive nightly / experimental builds
          </label>
        </div>
      </Card>
    </div>
  );
}
