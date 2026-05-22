"use client";

// Full-bleed terminal-style log viewer fed by the /logs/stream WS.
// Lives under /logs so the AppHeader tab strip can navigate to it.

import AppFooter from "../../components/AppFooter";
import AppHeader from "../../components/AppHeader";
import LogViewport from "../../components/LogViewport";
import { useHealthDetail } from "../../lib/hooks/useHealthDetail";

export default function LogsPage() {
  const detail = useHealthDetail();
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        gridTemplateRows: "auto 1fr auto",
      }}
    >
      <AppHeader version={detail?.version ?? null} />
      <div className="kx-diag-rule" aria-hidden="true" />

      <main
        style={{
          padding: "var(--kx-sp-5) var(--kx-sp-7)",
          minWidth: 0,
        }}
      >
        <LogViewport />
      </main>

      <AppFooter />
    </div>
  );
}
