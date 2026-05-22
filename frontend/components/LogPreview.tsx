"use client";

// Small tasteful card on the Diagnostics page that shows the last 5
// streamed log lines plus a "View full logs →" link to /logs. Shares
// the useLogStream hook with the dedicated Logs route — the WS is
// cheap enough that having two consumers running concurrently isn't
// a concern.

import { useLogStream } from "../lib/hooks/useLogStream";
import { lineColor, prefixColor, splitPrefix } from "../lib/log/format";
import { useRelativeHref } from "../lib/route/href";

const PREVIEW_ROWS = 5;

export default function LogPreview() {
  const { events, status } = useLogStream();
  const tail = events.slice(-PREVIEW_ROWS);
  // file://-safe href to the Logs page — see lib/route/href.ts for why
  // we avoid next/link here.
  const logsHref = useRelativeHref("/logs");

  return (
    <section
      className="kx-rise"
      style={{
        animationDelay: "180ms",
        background: "var(--kx-surface)",
        border: "1px solid var(--kx-border)",
        borderRadius: "var(--kx-r-lg)",
        padding: "var(--kx-sp-5)",
      }}
      aria-label="Live log preview"
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: "var(--kx-sp-4)",
        }}
      >
        <div className="kx-eyebrow">Live log</div>
        <a
          href={logsHref}
          style={{
            fontSize: "var(--kx-fs-12)",
            fontFamily: "var(--kx-font-mono)",
            color: "var(--kx-accent)",
            textDecoration: "none",
            letterSpacing: "0.04em",
          }}
        >
          View full logs →
        </a>
      </div>

      <div
        className="kx-mono"
        style={{
          background: "var(--kx-bg)",
          border: "1px solid var(--kx-border)",
          borderRadius: "var(--kx-r-md)",
          padding: "var(--kx-sp-3)",
          fontSize: 12,
          minHeight: 130,
          maxHeight: 160,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          gap: 2,
        }}
      >
        {tail.length === 0 ? (
          <span style={{ color: "var(--kx-fg-muted)" }}>
            {status === "disconnected"
              ? "(disconnected — waiting for daemon)"
              : "(waiting for events…)"}
          </span>
        ) : (
          tail.map((e, i) => {
            const { prefix, rest } = splitPrefix(e.line);
            return (
              <div
                key={`${e.ts}-${i}`}
                style={{
                  color: lineColor(e.level),
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  lineHeight: 1.5,
                }}
              >
                {prefix && (
                  <span style={{ color: prefixColor(prefix) }}>{prefix} </span>
                )}
                {rest}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
