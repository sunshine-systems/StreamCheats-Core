// Compute file://-safe relative hrefs for the app's sidebar routes.
//
// Why this exists: the static export is loaded into Electron via a
// `file://` URL (and over `http://127.0.0.1` once the daemon serves
// it). An anchor like `<a href="/logs/">` resolves against the
// filesystem root (e.g. `file:///C:/logs/`) instead of the app's
// `resources/frontend/` directory — yielding a blank window. Even
// Next's `<Link>` ends up emitting the same root-anchored href in the
// SSR'd HTML.
//
// The fix: from each current pathname, emit a *relative* href that
// the browser resolves against the current document's URL. With
// `trailingSlash: true`, every route lives at `<name>/index.html`,
// so all sidebar routes are siblings under the same parent and the
// relative path from any sibling to the root is `../` and from root
// to any sibling is `./<name>/`.
//
// SC-6 broadened the route table from {/, /logs} to the seven
// sidebar entries. Keep the AppRoute union in lockstep with the
// `app/<route>/page.tsx` files that exist on disk — adding a new
// route here without a matching page (or vice versa) will produce a
// broken link.

"use client";

import { usePathname } from "next/navigation";

export type AppRoute =
  | "/"
  | "/mouse"
  | "/keyboard"
  | "/experimental"
  | "/updates"
  // Sub-page of /updates that hosts the full release archive + manual
  // .hex picker. Added in the Updates restructure to keep the main
  // /updates page focused on newer-versions-available.
  | "/updates/firmware"
  | "/logs"
  | "/settings";

const KNOWN_ROUTES: ReadonlyArray<Exclude<AppRoute, "/">> = [
  "/mouse",
  "/keyboard",
  "/experimental",
  "/updates",
  "/updates/firmware",
  "/logs",
  "/settings",
];

// Normalize a pathname to one of the known app routes by stripping
// trailing slashes. Returns "/" for unknown/empty input — the safe
// default since "/" is the index page.
export function normalizeRoute(pathname: string | null): AppRoute {
  const stripped = (pathname ?? "/").replace(/\/+$/, "") || "/";
  if (stripped === "/") return "/";
  for (const r of KNOWN_ROUTES) {
    if (stripped === r) return r;
  }
  return "/";
}

// Pure function form — exported for unit-testability and for callers
// that have the pathname already in hand.
//
// With `trailingSlash: true`, every route lives at <segments>/index.html.
// To go from `from` to `to`, we walk up by the segment count of `from`
// (each segment of `from` is a directory we need to escape), then
// append the segments of `to`.
//
// Examples (depth 1 routes are siblings, depth 2 routes nest):
//   from "/"                 -> "/foo"            =>  "./foo/"
//   from "/foo/"             -> "/"               =>  "../"
//   from "/foo/"             -> "/bar"            =>  "../bar/"
//   from "/"                 -> "/updates/firmware" =>  "./updates/firmware/"
//   from "/updates/"         -> "/updates/firmware" =>  "../updates/firmware/"
//   from "/updates/firmware/" -> "/updates"       =>  "../../updates/"
//   from "/updates/firmware/" -> "/"              =>  "../../"
export function relativeHref(from: string | null, to: AppRoute): string {
  const cur = normalizeRoute(from);
  if (cur === to) return "./";
  const fromSegments = cur === "/" ? [] : cur.slice(1).split("/");
  const toSegments = to === "/" ? [] : to.slice(1).split("/");
  // Walk up one level for each segment of the current path. We can't
  // get cleverer (e.g. share a common prefix) because Next emits one
  // index.html per route directory and the browser resolves against
  // the *document URL*, not a synthetic base. The simpler "up-out
  // then back down" form is correct in every case.
  const ups = fromSegments.length === 0 ? "./" : "../".repeat(fromSegments.length);
  const downs = toSegments.length === 0 ? "" : `${toSegments.join("/")}/`;
  return `${ups}${downs}`;
}

// React hook form: reads the current pathname from Next's router.
export function useRelativeHref(to: AppRoute): string {
  const pathname = usePathname();
  return relativeHref(pathname, to);
}
