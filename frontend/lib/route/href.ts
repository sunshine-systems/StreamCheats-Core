// Compute file://-safe relative hrefs for the app's two routes.
//
// Why this exists: the static export is loaded into Electron via a
// `file://` URL. An anchor like `<a href="/logs/">` resolves against
// the filesystem root (e.g. `file:///C:/logs/`) instead of the app's
// `resources/frontend/` directory — yielding a blank window. Even
// Next's `<Link>` ends up emitting the same root-anchored href in the
// SSR'd HTML, and its client-side router likewise pushes a root path
// it cannot resolve under file://.
//
// The fix: from each current pathname, emit a *relative* href that the
// browser resolves against the current document's URL. With
// `trailingSlash: true`, `out/index.html` lives at `./` and
// `out/logs/index.html` lives at `./logs/`, so:
//
//   from "/"      -> "/"      => "./"
//   from "/"      -> "/logs"  => "./logs/"
//   from "/logs/" -> "/"      => "../"
//   from "/logs/" -> "/logs"  => "./"
//
// We deliberately keep this tiny and route-table-driven. If a third
// route is added, extend the switch — there is no general "compute
// relative path from A to B" helper here on purpose, because we want
// the mapping to fail loudly when a route doesn't exist.

"use client";

import { usePathname } from "next/navigation";

export type AppRoute = "/" | "/logs";

// Normalize a pathname to one of the known app routes by stripping
// trailing slashes. Returns "/" for unknown/empty input — the safe
// default since "/" is the index page.
function normalize(pathname: string | null): AppRoute {
  const stripped = (pathname ?? "/").replace(/\/+$/, "") || "/";
  if (stripped === "/logs") return "/logs";
  return "/";
}

// Pure function form — exported for unit-testability and for callers
// that have the pathname already in hand.
export function relativeHref(from: string | null, to: AppRoute): string {
  const cur = normalize(from);
  if (cur === to) return "./";
  if (cur === "/" && to === "/logs") return "./logs/";
  if (cur === "/logs" && to === "/") return "../";
  // Fallback — should not be reachable given the route table above.
  return "./";
}

// React hook form: reads the current pathname from Next's router.
export function useRelativeHref(to: AppRoute): string {
  const pathname = usePathname();
  return relativeHref(pathname, to);
}
