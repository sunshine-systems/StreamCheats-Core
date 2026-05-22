// Helpers for colouring log lines in the terminal viewport.
//
// The daemon emits its own conventional prefixes (`STATE:`,
// `MONITOR:`, `IN (KMBOX NET):`, `IN (COMx):`, `OUT (COMx):`) — we
// pull them off the front of the line so we can tint the prefix in
// one of the design-token colors and the body in the per-level color.

export interface SplitLine {
  prefix: string | null;
  rest: string;
}

const PREFIX_RE = /^(STATE:|MONITOR:|IN \(KMBOX NET\):|IN \(COM\d+\):|OUT \(COM\d+\):|HEARTBEAT:|HB:)\s*/;

export function splitPrefix(line: string): SplitLine {
  const m = PREFIX_RE.exec(line);
  if (!m) return { prefix: null, rest: line };
  return { prefix: m[1], rest: line.slice(m[0].length) };
}

export function lineColor(level: string): string {
  switch (level.toUpperCase()) {
    case "ERROR":
      return "var(--kx-danger)";
    case "WARN":
      return "var(--kx-warning)";
    case "DEBUG":
    case "TRACE":
      return "var(--kx-fg-muted)";
    case "INFO":
    default:
      return "var(--kx-fg-2)";
  }
}

export function prefixColor(prefix: string): string {
  if (prefix.startsWith("STATE")) return "var(--kx-accent)";
  if (prefix.startsWith("MONITOR")) return "var(--kx-action)";
  if (prefix.startsWith("IN")) return "var(--kx-accent)";
  if (prefix.startsWith("OUT")) return "var(--kx-action)";
  if (prefix.startsWith("HB") || prefix.startsWith("HEARTBEAT"))
    return "var(--kx-fg-muted)";
  return "var(--kx-fg-3)";
}
