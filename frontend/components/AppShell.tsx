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
  Download,
  FlaskConical,
  Home,
  Keyboard,
  Mouse,
  Settings,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { useAnyUpdatePending } from "../lib/hooks/useAnyUpdatePending";
import { useExperimentalActive } from "../lib/hooks/useExperimentalStatus";
import { useFirmwareStatus } from "../lib/hooks/useFirmwareStatus";
import { type AppRoute, normalizeRoute, relativeHref } from "../lib/route/href";

interface NavItem {
  route: AppRoute;
  label: string;
  Icon: LucideIcon;
}

// Top group renders in this order, with Settings pinned to the
// bottom by a flex spacer + hairline separator above it.
const TOP_ITEMS: NavItem[] = [
  { route: "/", label: "Home", Icon: Home },
  { route: "/mouse", label: "Mouse", Icon: Mouse },
  { route: "/keyboard", label: "Keyboard", Icon: Keyboard },
  { route: "/experimental", label: "Experimental Support", Icon: FlaskConical },
  { route: "/updates", label: "Updates", Icon: Download },
  { route: "/logs", label: "Logs", Icon: Terminal },
];

const BOTTOM_ITEM: NavItem = {
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
              key={item.route}
              item={item}
              active={current === item.route}
              pathname={pathname}
              pending={
                (item.route === "/updates" &&
                  (updatesPending || firmwareFlashing)) ||
                (item.route === "/experimental" && experimentalActive)
              }
              flashing={item.route === "/updates" && firmwareFlashing}
            />
          ))}
        </nav>

        <div className="flex-1" aria-hidden="true" />

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
    </div>
  );
}

function SidebarItem({
  item,
  active,
  pathname,
  pending,
  flashing,
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
}) {
  const { Icon, label, route } = item;
  // Plain <a> + relative href: see lib/route/href.ts for why we don't
  // use next/link under the file:// origin Electron loads.
  const href = relativeHref(pathname, route);
  return (
    <a
      href={href}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={label}
      className={`
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
      `}
      style={{
        transitionDuration: "var(--sc-dur-quick)",
        transitionTimingFunction: "var(--sc-ease-out)",
      }}
    >
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
    </a>
  );
}
