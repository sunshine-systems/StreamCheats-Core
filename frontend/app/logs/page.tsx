// Logs page — stub at SC-6. SC-11 ports the existing terminal-style
// log viewport (LogViewport / useLogStream) into the new shell, so
// the old `frontend/app/logs/page.tsx` content has been replaced
// with a placeholder. The underlying components and the
// `/logs/stream` WebSocket plumbing remain untouched.

import PendingStub from "../../components/ui/PendingStub";

export default function LogsPage() {
  return (
    <PendingStub
      eyebrow="logs · live stream"
      title="Logs"
      ticket="SC-11"
      blurb="Live tail of the daemon's structured logs with filter chips and a copy-line affordance."
    />
  );
}
