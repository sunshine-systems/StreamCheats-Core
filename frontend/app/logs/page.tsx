"use client";

// Logs page (SC-11). Live tail of the daemon's structured log stream
// inside the redesign shell. Pulls from the existing useLogStream
// WebSocket hook untouched; the UI is the new LogStream component
// styled against SC design tokens.
//
// On mount we fire `POST /api/logs/mark_seen` (via useMarkLogsSeen) so
// the Home page (SC-7) badge of unseen warnings/errors resets. The
// endpoint may not yet exist if SC-7 hasn't merged — the hook treats
// that as a quiet no-op.

import LogStream from "../../components/LogStream";
import PageHeader from "../../components/ui/PageHeader";
import { useMarkLogsSeen } from "../../lib/hooks/useMarkLogsSeen";

export default function LogsPage() {
  useMarkLogsSeen();

  return (
    <div
      className="
        px-5 sm:px-8 py-8
        flex flex-col gap-6
        min-h-screen
      "
    >
      <PageHeader eyebrow="system · logs" title="Logs" />
      <div className="flex-1 min-h-0 flex flex-col">
        <LogStream />
      </div>
    </div>
  );
}
