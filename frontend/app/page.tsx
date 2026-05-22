"use client";

// Single-screen layout — header / two-column main / footer. The left
// rail carries live daemon telemetry; the right stage is currently
// dominated by the diagnostic CTA + roadmap. As real features arrive
// they'll slot into the stage between the CTA card and the roadmap.

import AppFooter from "../components/AppFooter";
import AppHeader from "../components/AppHeader";
import BugReportButton from "../components/BugReportButton";
import LogPreview from "../components/LogPreview";
import StatusRail from "../components/StatusRail";
import UpdateBanner from "../components/UpdateBanner";
import UpdateSettings from "../components/UpdateSettings";
import { useHealthDetail } from "../lib/hooks/useHealthDetail";

export default function Home() {
  // Bubble version up to the header so the wordmark shows "v0.6.2" not
  // a hardcoded number. Cheap — the hook is already mounted in the rail
  // too but the cost is one extra subscription, no extra polling.
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
      <UpdateBanner />

      <main
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(260px, 320px) 1fr",
          gap: "var(--kx-sp-6)",
          padding: "var(--kx-sp-6) var(--kx-sp-7)",
          alignItems: "start",
        }}
      >
        <StatusRail />

        <section
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--kx-sp-6)",
            minWidth: 0,
          }}
        >
          <CtaCard />
          <UpdateSettings />
          <LogPreview />
        </section>
      </main>

      <AppFooter />
    </div>
  );
}

function CtaCard() {
  return (
    <section
      className="kx-rise"
      style={{
        position: "relative",
        background: "var(--kx-surface)",
        border: "1px solid var(--kx-border)",
        borderRadius: "var(--kx-r-lg)",
        padding: "var(--kx-sp-6)",
        overflow: "hidden",
        animationDelay: "120ms",
      }}
      aria-label="Diagnostic bundle"
    >
      {/* Soft accent halo at top-right — gives the card a focal point
          without resorting to a heavy gradient header. */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          top: -120,
          right: -120,
          width: 320,
          height: 320,
          background:
            "radial-gradient(circle, rgba(255, 184, 107, 0.10), transparent 60%)",
          pointerEvents: "none",
        }}
      />

      <div
        className="kx-eyebrow"
        style={{ marginBottom: "var(--kx-sp-3)", position: "relative" }}
      >
        Primary action
      </div>
      <h2
        style={{
          margin: 0,
          marginBottom: "var(--kx-sp-2)",
          fontSize: "var(--kx-fs-28)",
          letterSpacing: "-0.02em",
          fontWeight: 600,
          color: "var(--kx-fg)",
          lineHeight: 1.15,
          position: "relative",
        }}
      >
        Bundle today&apos;s logs for a bug report
      </h2>
      <p
        style={{
          margin: 0,
          marginBottom: "var(--kx-sp-5)",
          fontSize: "var(--kx-fs-14)",
          color: "var(--kx-fg-3)",
          maxWidth: 560,
          lineHeight: 1.55,
          position: "relative",
        }}
      >
        Zips the daemon&apos;s log files and your{" "}
        <code
          className="kx-mono"
          style={{
            color: "var(--kx-fg-2)",
            background: "var(--kx-surface-2)",
            padding: "1px 6px",
            borderRadius: 4,
            border: "1px solid var(--kx-border)",
            fontSize: "0.875em",
          }}
        >
          config.json
        </code>{" "}
        (secrets redacted) to your Desktop. Drop the file into a Discord
        thread or issue when reporting a bug.
      </p>

      <div style={{ position: "relative" }}>
        <BugReportButton />
      </div>
    </section>
  );
}
