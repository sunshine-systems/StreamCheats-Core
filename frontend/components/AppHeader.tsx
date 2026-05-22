"use client";

// Top-of-page brand bar. Sets the tone of the app: technical, named,
// versioned, with the daemon connection visible at a glance. The
// diagonal accent line below it intentionally breaks the orthogonal
// grid per the frontend-design skill ("embrace asymmetry, diagonal
// flow, grid-breaking elements").
//
// As of the log-streaming feature the header also carries a two-tab
// strip ("Diagnostics" → `/`, "Logs" → `/logs`) so the Logs page can
// live as a peer route without losing the brand bar context.

import { usePathname } from "next/navigation";

import { type AppRoute, relativeHref } from "../lib/route/href";
import ConnectionStatus from "./ConnectionStatus";

export interface AppHeaderProps {
  version?: string | null;
}

export default function AppHeader({ version }: AppHeaderProps) {
  const pathname = usePathname();

  return (
    <header
      className="kx-rise"
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: "var(--kx-sp-5)",
        padding: "var(--kx-sp-5) var(--kx-sp-7)",
      }}
    >
      {/* Brand mark: the project logo + wordmark. The logo is the real
          streamcheats_app_icon (shared with the Electron splash + tray
          .ico) served as a static asset from `public/`. Single source
          of truth on disk; no inline duplication. */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--kx-sp-3)" }}>
        <img
          src="/logo.svg"
          alt="StreamCheats Core"
          width={34}
          height={34}
          style={{ flex: "0 0 auto", display: "block" }}
        />
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
          <span
            style={{
              fontSize: "var(--kx-fs-16)",
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: "var(--kx-fg)",
            }}
          >
            StreamCheats Core
          </span>
          <span
            className="kx-mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--kx-fg-3)",
              marginTop: 3,
            }}
          >
            HID Bridge · v{version ?? "—"}
          </span>
        </div>
      </div>

      {/* Tab strip centered in the spacer column. */}
      <nav
        aria-label="Primary"
        style={{
          display: "flex",
          justifyContent: "center",
          gap: "var(--kx-sp-1)",
        }}
      >
        <TabLink href="/" label="Diagnostics" pathname={pathname} />
        <TabLink href="/logs" label="Logs" pathname={pathname} />
      </nav>

      <ConnectionStatus />
    </header>
  );
}

function TabLink({
  href,
  label,
  pathname,
}: {
  href: AppRoute;
  label: string;
  pathname: string | null;
}) {
  // Static export adds trailing slashes — normalize both sides.
  const norm = (s: string | null) =>
    (s ?? "/").replace(/\/+$/, "") || "/";
  const active = norm(pathname) === norm(href);
  // Plain <a> + relative href, NOT next/link. Under Electron's file://
  // origin Next's client-side router pushes absolute paths like
  // `/logs/` that resolve against the filesystem root and produce a
  // blank window. A full-page navigation to a relative href just
  // reloads the sibling index.html, which is instantaneous since all
  // chunks are already cached. See lib/route/href.ts for the rationale.
  const resolved = relativeHref(pathname, href);
  return (
    <a
      href={resolved}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "6px 14px",
        fontSize: "var(--kx-fs-13)",
        fontFamily: "var(--kx-font-mono)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        fontWeight: 500,
        color: active ? "var(--kx-accent)" : "var(--kx-fg-3)",
        background: active ? "var(--kx-accent-soft)" : "transparent",
        border: `1px solid ${active ? "var(--kx-border-glow)" : "transparent"}`,
        borderRadius: "var(--kx-r-pill)",
        textDecoration: "none",
        transition:
          "color 160ms var(--kx-ease), background 160ms var(--kx-ease), border-color 160ms var(--kx-ease)",
      }}
    >
      {label}
    </a>
  );
}

