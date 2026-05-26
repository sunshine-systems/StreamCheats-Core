"use client";

// Dedicated, full-viewport logs view rendered into a separate Electron
// BrowserWindow (1200x800, freely resizable). The Logs sidebar item in
// AppShell pops this window via `window.streamcheats.openLogsWindow()`
// — see electron/main.js::createLogsWindow.
//
// This route deliberately bypasses the AppShell sidebar (the shell
// short-circuits to a bare children render when `pathname` is
// `/logs/window`) so the detached window has no chrome rail and the
// LogStream gets the full canvas.
//
// `markLogsSeen()` is called on mount so the Home page's unseen-log
// badge resets even when the user reads logs from the detached window
// rather than navigating in-shell.

import { useEffect, useMemo } from "react";

import LogStream from "../../../components/LogStream";
import { markLogsSeen } from "../../../lib/hooks/useUnseenLogCount";

export default function LogsWindowPage() {
  useEffect(() => {
    markLogsSeen();
  }, []);

  // Read ?levels=ERROR,WARN once on mount so deep-links from other
  // surfaces (e.g. the Home unseen-log card) can pre-filter the
  // viewport. `useSearchParams` would force this page to be dynamic
  // under Next's static export, so parse window.location directly.
  const initialLevels = useMemo<readonly string[] | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    const raw = new URLSearchParams(window.location.search).get("levels");
    if (!raw) return undefined;
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }, []);

  return (
    <div
      className="
        h-dvh w-dvw
        flex flex-col
        bg-substrate
        overflow-hidden
      "
    >
      {/* Slim, draggable-styled title bar — visual only. Electron
          frames the window with its own native chrome; this bar just
          gives the content a clean identity stripe so the LogStream's
          status row doesn't crowd the top of the viewport. */}
      <header
        className="
          shrink-0
          px-4 py-2
          border-b border-hairline
          bg-substrate-2
          flex items-center
          sc-chrome text-[11px] text-ink-dim
        "
        style={{ letterSpacing: "0.08em" }}
      >
        StreamCheats Logs
      </header>

      <main className="flex-1 min-h-0 flex flex-col p-4">
        <LogStream initialLevels={initialLevels} />
      </main>
    </div>
  );
}
