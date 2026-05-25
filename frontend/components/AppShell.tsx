"use client";

// Persistent app chrome: a narrow icon-only sidebar on the left and a
// flexible content area on the right. Mounted by `app/layout.tsx`
// around every route so navigation is one click away on every page.
//
// The window is fixed-width and narrow (~730–970px in the Electron
// host) — the sidebar stays at 52px so the content stage keeps as
// much horizontal real-estate as possible. No labels in the rail; the
// page name surfaces on hover as a tooltip in JetBrains Mono.
//
// Active state: a 2px foliage accent bar on the left edge + foliage
// icon color. Inactive: text-ink-dim, hover lifts to text-ink-muted
// over --sc-dur-quick.

import { usePathname } from "next/navigation";
import {
  Bug,
  Download,
  FlaskConical,
  Home,
  Keyboard,
  Mouse,
  Settings,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { getBridge } from "../lib/api/client";
import { useAnyUpdatePending } from "../lib/hooks/useAnyUpdatePending";
import { useExperimentalActive } from "../lib/hooks/useExperimentalStatus";
import { useFirmwareStatus } from "../lib/hooks/useFirmwareStatus";
import { type AppRoute, normalizeRoute, relativeHref } from "../lib/route/href";
import BugReportModal from "./BugReportModal";

// Sidebar entries are either navigation targets (rendered as <a> with
// relative hrefs) or actions (rendered as <button> that fire an
// imperative side-effect — currently only "open the dedicated Logs
// window"). The kind discriminator keeps the rendering logic for the
// two trivially distinguishable without sprinkling typeof checks.
interface NavLinkItem {
  kind: "link";
  route: AppRoute;
  label: string;
  Icon: LucideIcon;
}
interface NavActionItem {
  kind: "action";
  /**
   * Stable key used in place of `route` for React identity. Not a real
   * routable path — clicking the item fires an IPC call instead.
   */
  id: string;
  label: string;
  Icon: LucideIcon;
}
type NavItem = NavLinkItem | NavActionItem;

// Top group renders in this order, with Settings pinned to the
// bottom by a flex spacer + hairline separator above it.
const TOP_ITEMS: NavItem[] = [
  { kind: "link", route: "/", label: "Home", Icon: Home },
  { kind: "link", route: "/mouse", label: "Mouse", Icon: Mouse },
  { kind: "link", route: "/keyboard", label: "Keyboard", Icon: Keyboard },
  {
    kind: "link",
    route: "/experimental",
    label: "Experimental Support",
    Icon: FlaskConical,
  },
  { kind: "link", route: "/updates", label: "Updates", Icon: Download },
  // Logs is an action, not a route: clicking pops a dedicated
  // BrowserWindow at 1200x800 via `window.streamcheats.openLogsWindow()`
  // (which loads the `/logs/window/` static route). The in-shell
  // `/logs` page is kept as a fallback target for callers that link
  // there directly (LogPreview, the Home unseen-log card) and for
  // browser-only dev sessions without the Electron bridge.
  { kind: "action", id: "logs", label: "Logs", Icon: Terminal },
];

// Bug report sits just above the separator-then-Settings block at the
// bottom of the rail. It's an action (opens an in-app modal), not a
// route — same shape as the Logs action above.
const BUG_REPORT_ITEM: NavActionItem = {
  kind: "action",
  id: "bug-report",
  label: "Report a bug",
  Icon: Bug,
};

const BOTTOM_ITEM: NavLinkItem = {
  kind: "link",
  route: "/settings",
  label: "Settings",
  Icon: Settings,
};

export interface AppShellProps {
  children: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const current = normalizeRoute(pathname);
  // Derived flag for the Updates icon. SC-5 reserves copper for the
  // one-and-only "you have something pending" affordance — we honour
  // that by tinting the icon copper (and adding a soft glow halo)
  // exclusively for /updates.
  const updatesPending = useAnyUpdatePending();
  // SC-8: parallel signal for the Experimental Support item. Copper
  // means "a listener is currently running" — the state change with
  // side-effects users want unmistakable feedback on.
  const experimentalActive = useExperimentalActive();
  // Updates restructure: distinct visual treatment for the active
  // flash. Copper-tinted icon (matches `pending`) plus an animated
  // pulse halo so the user can tell at a glance that the device is
  // mid-flash and nav back to /updates/firmware will re-open the
  // stepper modal. We deliberately extend with a new `flashing` flag
  // rather than overload `pending` — same colour, different intensity.
  const firmwareFlashing =
    useFirmwareStatus().status?.state.kind === "flashing";

  // Local open flag for the bug-report modal. The modal itself owns
  // the useBugReport hook + visible state machine — AppShell just
  // toggles visibility.
  const [bugReportOpen, setBugReportOpen] = useState(false);

  // The dedicated Logs BrowserWindow loads `/logs/window/` — a
  // full-viewport renderer of <LogStream /> with no shell chrome. We
  // detect that route here and bypass the sidebar entirely so the
  // detached window doesn't render a tiny, useless navigation rail
  // pointing back at routes that don't exist in its own context.
  // The bypass is placed AFTER the hooks above (rules-of-hooks) so
  // every render path calls the same hooks in the same order; the
  // wasted work in the detached window is one tick of cached
  // selectors and is otherwise free.
  if (pathname && pathname.replace(/\/+$/, "") === "/logs/window") {
    return <>{children}</>;
  }

  return (
    // h-dvh + per-pane scrolling so the sidebar stays pinned while the
    // content area scrolls independently. (Previously this was
    // `min-h-screen` which let the whole window — sidebar included —
    // scroll with long content like the live log viewer.)
    <div className="sc-grain h-dvh flex overflow-hidden">
      <aside
        aria-label="Primary"
        className="
          w-[52px] shrink-0
          h-dvh
          flex flex-col items-stretch
          bg-substrate-2
          border-r border-hairline
          py-3
          relative z-10
        "
      >
        <nav className="flex flex-col">
          {TOP_ITEMS.map((item) => (
            <SidebarItem
              key={item.kind === "link" ? item.route : item.id}
              item={item}
              active={item.kind === "link" && current === item.route}
              pathname={pathname}
              pending={
                item.kind === "link" &&
                ((item.route === "/updates" &&
                  (updatesPending || firmwareFlashing)) ||
                  (item.route === "/experimental" && experimentalActive))
              }
              flashing={
                item.kind === "link" &&
                item.route === "/updates" &&
                firmwareFlashing
              }
            />
          ))}
        </nav>

        <div className="flex-1" aria-hidden="true" />

        {/* Bug Report sits just above the separator + Settings — it's
            a sidebar-level concern (always reachable), not a per-page
            feature, so it lives in the bottom group like Settings but
            without an active-route indicator. */}
        <nav>
          <SidebarItem
            item={BUG_REPORT_ITEM}
            active={false}
            pathname={pathname}
            pending={false}
            flashing={false}
            onAction={() => setBugReportOpen(true)}
          />
        </nav>

        <div
          aria-hidden="true"
          className="mx-2 mb-1 h-px bg-hairline"
        />
        <nav>
          <SidebarItem
            item={BOTTOM_ITEM}
            active={current === BOTTOM_ITEM.route}
            pathname={pathname}
            pending={false}
            flashing={false}
          />
        </nav>
      </aside>

      <main className="flex-1 min-w-0 relative h-dvh overflow-y-auto">
        {children}
      </main>

      <BugReportModal
        open={bugReportOpen}
        onClose={() => setBugReportOpen(false)}
      />
    </div>
  );
}

function SidebarItem({
  item,
  active,
  pathname,
  pending,
  flashing,
  onAction,
}: {
  item: NavItem;
  active: boolean;
  pathname: string | null;
  /**
   * Render the icon in copper to indicate "something to act on" (e.g.
   * an update is available). Active state still wins for the accent
   * bar; this only changes the icon color + adds a subtle glow halo.
   */
  pending: boolean;
  /**
   * Stronger variant of `pending` reserved for the Updates item while
   * a firmware flash is in flight. Adds an animated pulse on top of
   * the copper tint so the user can tell at a glance the device is
   * mid-flash and clicking will re-open the stepper modal.
   */
  flashing: boolean;
  /**
   * Optional click handler for action items. If supplied, takes
   * precedence over the built-in `openLogsWindow` fallback — this is
   * how the bug-report item opens its modal without needing a
   * dedicated render path.
   */
  onAction?: () => void;
}) {
  const { Icon, label } = item;

  // Resolve a fallback URL for the dedicated logs window. This is
  // used in two places: (1) as the href on a `<a>` element when the
  // Electron bridge is missing (browser dev fallback), and (2) as the
  // location.assign target when the bridge call rejects at runtime.
  //
  // The static export emits `/logs/window/index.html`, so we walk up
  // from the current pathname and into `logs/window/` to produce a
  // file://-safe relative URL. We can't use `relativeHref` here
  // because `/logs/window` isn't in the AppRoute union (intentionally
  // — it's not a navigable in-shell route, just a static target the
  // Electron main process loads into a separate BrowserWindow).
  const logsWindowHref = (() => {
    const cur = pathname ?? "/";
    const stripped = cur.replace(/\/+$/, "") || "/";
    const fromSegments =
      stripped === "/" ? [] : stripped.slice(1).split("/");
    const ups =
      fromSegments.length === 0 ? "./" : "../".repeat(fromSegments.length);
    return `${ups}logs/window/`;
  })();

  const className = `
    group relative
    flex items-center justify-center
    h-11 w-full
    text-[20px]
    transition-colors
    ${
      active
        ? "text-foliage"
        : pending
          ? "text-copper hover:text-copper"
          : "text-ink-dim hover:text-ink-muted"
    }
  `;

  const style = {
    transitionDuration: "var(--sc-dur-quick)",
    transitionTimingFunction: "var(--sc-ease-out)",
  };

  const innerContent = (
    <>
      {/* Active accent bar — flush left, 2px wide, foliage. */}
      <span
        aria-hidden="true"
        className={`
          absolute left-0 top-1/2 -translate-y-1/2
          w-[2px] h-6 rounded-r
          bg-foliage
          transition-opacity
          ${active ? "opacity-100" : "opacity-0"}
        `}
        style={{
          transitionDuration: "var(--sc-dur-quick)",
        }}
      />
      <Icon
        size={20}
        strokeWidth={1.75}
        aria-hidden="true"
        // Soft copper halo when something is pending. Pure-CSS glow so
        // we don't pull motion deps into the shell. Suppressed when
        // the item is the active route to avoid double-emphasis.
        //
        // Flashing variant pulses via Tailwind's animate-pulse — same
        // copper colour, brighter shadow, looping opacity. Cheap and
        // CSS-only so we don't have to plumb motion through here.
        className={flashing && !active ? "animate-pulse" : undefined}
        style={
          flashing && !active
            ? { filter: "drop-shadow(0 0 8px rgba(213, 130, 88, 0.75))" }
            : pending && !active
              ? { filter: "drop-shadow(0 0 6px rgba(213, 130, 88, 0.55))" }
              : undefined
        }
      />
      {flashing && !active ? (
        <span className="sr-only"> (firmware flash in progress)</span>
      ) : pending && !active ? (
        <span className="sr-only"> (update pending)</span>
      ) : null}

      {/* Tooltip — hover only, short delay via CSS. JetBrains Mono. */}
      <span
        role="tooltip"
        className="
          pointer-events-none
          absolute left-full ml-2 top-1/2 -translate-y-1/2
          whitespace-nowrap
          px-2 py-1
          rounded-[4px]
          bg-substrate-2 border border-hairline-2
          text-ink text-[11px] font-mono
          opacity-0 group-hover:opacity-100
          translate-x-[-4px] group-hover:translate-x-0
          transition
          z-20
        "
        style={{
          transitionDuration: "var(--sc-dur-base)",
          transitionTimingFunction: "var(--sc-ease-out)",
          transitionDelay: "120ms",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </span>
    </>
  );

  if (item.kind === "action") {
    // Action items either fire a caller-supplied handler (preferred —
    // see the bug-report item which toggles an in-shell modal) or
    // fall back to the legacy Logs behaviour: pop a dedicated
    // BrowserWindow via the Electron bridge, with a same-window URL
    // assign as the bridge-absent dev fallback.
    const handleClick = async () => {
      if (onAction) {
        onAction();
        return;
      }
      const bridge = getBridge();
      if (bridge && typeof bridge.openLogsWindow === "function") {
        try {
          await bridge.openLogsWindow();
          return;
        } catch {
          /* fall through to URL fallback */
        }
      }
      // Dev fallback only — assigns the current window's location.
      if (typeof window !== "undefined") {
        window.location.href = logsWindowHref;
      }
    };
    return (
      <button
        type="button"
        onClick={handleClick}
        aria-label={label}
        title={label}
        className={className}
        style={style}
      >
        {innerContent}
      </button>
    );
  }

  // Plain <a> + relative href: see lib/route/href.ts for why we don't
  // use next/link under the file:// origin Electron loads.
  const href = relativeHref(pathname, item.route);
  return (
    <a
      href={href}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={label}
      className={className}
      style={style}
    >
      {innerContent}
    </a>
  );
}
