"use client";

// Full terminal-style log viewport. Renders the live stream from
// useLogStream and stacks a header bar (status indicators) on top of
// a control bar (pause/autoscroll/filter/levels/clear), then the
// scrolling monospace viewport itself.
//
// Performance: the UI buffer is capped at 5_000 lines (matching the
// backend ring); when the user has the filter unset and all levels on
// we just render every row. Filter / level pruning is done lazily on
// render. For the activity volumes the daemon produces (tens to low
// hundreds of events/sec under load) this comfortably keeps the page
// responsive without a virtual list implementation.

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

// Read `?levels=ERROR,WARN` (or similar) from window.location on first
// render and turn it into a `LevelToggleSet`. Any level not listed in
// the param is treated as filtered out — that's the whole point of
// deep-linking a curated subset from the home page. If the param is
// missing or empty we fall back to "everything on" so existing entry
// points keep working unchanged.
function readLevelsFromUrl(): LevelToggleSet | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("levels");
  if (raw === null) return null;
  const wanted = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
  if (wanted.size === 0) return null;
  const next: LevelToggleSet = { ...DEFAULT_LEVELS };
  for (const lvl of LEVELS) {
    next[lvl] = wanted.has(lvl);
  }
  return next;
}

import {
  useLogStream,
  type LogEvent,
  type LogStreamStatus,
} from "../lib/hooks/useLogStream";
import { lineColor, prefixColor, splitPrefix } from "../lib/log/format";

const LEVELS = ["INFO", "WARN", "ERROR", "DEBUG", "TRACE"] as const;
type LevelToggleSet = Record<(typeof LEVELS)[number], boolean>;

const DEFAULT_LEVELS: LevelToggleSet = {
  INFO: true,
  WARN: true,
  ERROR: true,
  DEBUG: true,
  TRACE: true,
};

export default function LogViewport() {
  const stream = useLogStream();
  const [filter, setFilter] = useState("");
  // Initialiser runs once on mount — deep-link `?levels=ERROR,WARN`
  // from the home page lands us with just those two enabled.
  const [levels, setLevels] = useState<LevelToggleSet>(
    () => readLevelsFromUrl() ?? DEFAULT_LEVELS
  );
  const [autoscroll, setAutoscroll] = useState(true);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Track whether the user has manually scrolled away from the bottom.
  // While they're "anchored" up-page, suppress autoscroll until they
  // either toggle it back on or scroll back to the bottom themselves.
  const userScrolledUpRef = useRef(false);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return stream.events.filter((e) => {
      const lvl = e.level.toUpperCase() as keyof LevelToggleSet;
      if (lvl in levels && !levels[lvl]) return false;
      if (!needle) return true;
      return e.line.toLowerCase().includes(needle);
    });
  }, [stream.events, filter, levels]);

  // Autoscroll on new events. useLayoutEffect so the scroll happens
  // before the browser paints, avoiding a flash where the user sees
  // the bottom drift momentarily before snapping.
  useLayoutEffect(() => {
    if (!autoscroll) return;
    if (userScrolledUpRef.current) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible, autoscroll]);

  const onViewportScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // 8px tolerance so font metric rounding doesn't keep us "scrolled up".
    userScrolledUpRef.current = distFromBottom > 8;
  };

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--kx-sp-3)",
        height: "calc(100vh - 170px)",
        minHeight: 420,
      }}
      aria-label="Live log viewer"
    >
      <HeaderBar
        status={stream.status}
        eventsPerSec={stream.eventsPerSec}
        bufferCount={stream.bufferCount}
        lagCount={stream.lagCount}
        visibleCount={visible.length}
      />

      <ControlBar
        paused={stream.paused}
        onPauseToggle={() => (stream.paused ? stream.resume() : stream.pause())}
        autoscroll={autoscroll}
        onAutoscrollToggle={() => {
          const next = !autoscroll;
          setAutoscroll(next);
          if (next) userScrolledUpRef.current = false;
        }}
        filter={filter}
        onFilterChange={setFilter}
        levels={levels}
        onLevelToggle={(lvl) =>
          setLevels((prev) => ({ ...prev, [lvl]: !prev[lvl] }))
        }
        onClear={stream.clear}
      />

      <div
        ref={scrollerRef}
        onScroll={onViewportScroll}
        className="kx-mono"
        style={{
          flex: 1,
          minHeight: 0,
          background: "var(--kx-bg)",
          border: "1px solid var(--kx-border)",
          borderRadius: "var(--kx-r-md)",
          padding: "var(--kx-sp-3) var(--kx-sp-4)",
          fontSize: 12.5,
          overflow: "auto",
          lineHeight: 1.5,
        }}
      >
        {visible.length === 0 ? (
          <span style={{ color: "var(--kx-fg-muted)" }}>(no events)</span>
        ) : (
          visible.map((e, i) => <Row key={`${e.ts}-${i}`} event={e} />)
        )}
      </div>
    </section>
  );
}

function Row({ event }: { event: LogEvent }) {
  const { prefix, rest } = splitPrefix(event.line);
  const color = lineColor(event.level);
  // Render the timestamp as HH:MM:SS.mmm — full ISO is too noisy.
  const ts = event.ts.length >= 23 ? event.ts.substring(11, 23) : event.ts;
  return (
    <div
      style={{
        color,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        display: "flex",
        gap: 8,
      }}
    >
      <span style={{ color: "var(--kx-fg-dim)", flex: "0 0 auto" }}>{ts}</span>
      <span
        style={{
          color: levelBadgeColor(event.level),
          flex: "0 0 auto",
          width: 36,
        }}
      >
        {event.level.toUpperCase()}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        {prefix && (
          <span style={{ color: prefixColor(prefix) }}>{prefix} </span>
        )}
        {rest}
      </span>
    </div>
  );
}

function levelBadgeColor(level: string): string {
  switch (level.toUpperCase()) {
    case "ERROR":
      return "var(--kx-danger)";
    case "WARN":
      return "var(--kx-warning)";
    case "DEBUG":
    case "TRACE":
      return "var(--kx-fg-muted)";
    default:
      return "var(--kx-accent)";
  }
}

function HeaderBar({
  status,
  eventsPerSec,
  bufferCount,
  lagCount,
  visibleCount,
}: {
  status: LogStreamStatus;
  eventsPerSec: number;
  bufferCount: number;
  lagCount: number;
  visibleCount: number;
}) {
  const s = statusVisual(status);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--kx-sp-4)",
        padding: "var(--kx-sp-3) var(--kx-sp-4)",
        background: "var(--kx-surface)",
        border: "1px solid var(--kx-border)",
        borderRadius: "var(--kx-r-md)",
        fontFamily: "var(--kx-font-mono)",
        fontSize: "var(--kx-fs-12)",
      }}
    >
      <span style={{ color: s.color, fontWeight: 600 }}>
        {s.glyph} {s.label}
      </span>
      <Sep />
      <Metric label="rate" value={`${eventsPerSec}/s`} />
      <Sep />
      <Metric label="buffer" value={fmtNum(bufferCount)} />
      <Sep />
      <Metric label="visible" value={fmtNum(visibleCount)} />
      {lagCount > 0 && (
        <>
          <Sep />
          <Metric
            label="lagged"
            value={`${fmtNum(lagCount)} dropped`}
            color="var(--kx-warning)"
          />
        </>
      )}
    </div>
  );
}

function statusVisual(status: LogStreamStatus): {
  glyph: string;
  label: string;
  color: string;
} {
  switch (status) {
    case "streaming":
      return { glyph: "●", label: "Streaming", color: "var(--kx-accent)" };
    case "paused":
      return { glyph: "■", label: "Paused", color: "var(--kx-warning)" };
    case "disconnected":
      return { glyph: "✕", label: "Disconnected", color: "var(--kx-danger)" };
    case "connecting":
    default:
      return { glyph: "…", label: "Connecting", color: "var(--kx-fg-3)" };
  }
}

function Metric({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        gap: 6,
        alignItems: "baseline",
      }}
    >
      <span style={{ color: "var(--kx-fg-muted)" }}>{label}</span>
      <span style={{ color: color ?? "var(--kx-fg-2)" }}>{value}</span>
    </span>
  );
}

function Sep() {
  return (
    <span style={{ color: "var(--kx-fg-dim)" }} aria-hidden="true">
      │
    </span>
  );
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

function ControlBar({
  paused,
  onPauseToggle,
  autoscroll,
  onAutoscrollToggle,
  filter,
  onFilterChange,
  levels,
  onLevelToggle,
  onClear,
}: {
  paused: boolean;
  onPauseToggle: () => void;
  autoscroll: boolean;
  onAutoscrollToggle: () => void;
  filter: string;
  onFilterChange: (v: string) => void;
  levels: LevelToggleSet;
  onLevelToggle: (lvl: keyof LevelToggleSet) => void;
  onClear: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "var(--kx-sp-3)",
        padding: "var(--kx-sp-3) var(--kx-sp-4)",
        background: "var(--kx-surface)",
        border: "1px solid var(--kx-border)",
        borderRadius: "var(--kx-r-md)",
      }}
    >
      <PillButton
        active={paused}
        onClick={onPauseToggle}
        label={paused ? "Resume" : "Pause"}
        title={paused ? "Resume appending events" : "Stop appending events"}
      />
      <PillButton
        active={autoscroll}
        onClick={onAutoscrollToggle}
        label={autoscroll ? "Autoscroll: ON" : "Autoscroll: OFF"}
      />
      <input
        type="text"
        value={filter}
        placeholder="Filter (substring, case-insensitive)"
        onChange={(e) => onFilterChange(e.target.value)}
        style={inputStyle}
        aria-label="Filter logs"
      />
      <div
        style={{
          display: "inline-flex",
          gap: 4,
          alignItems: "center",
        }}
      >
        {LEVELS.map((lvl) => (
          <LevelToggle
            key={lvl}
            level={lvl}
            on={levels[lvl]}
            onClick={() => onLevelToggle(lvl)}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onClear}
        style={{
          marginLeft: "auto",
          ...pillStyle(false),
          color: "var(--kx-fg-3)",
        }}
        title="Clear the UI buffer (backend ring is unaffected)"
      >
        Clear
      </button>
    </div>
  );
}

function PillButton({
  active,
  onClick,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
}) {
  return (
    <button type="button" onClick={onClick} title={title} style={pillStyle(active)}>
      {label}
    </button>
  );
}

function LevelToggle({
  level,
  on,
  onClick,
}: {
  level: string;
  on: boolean;
  onClick: () => void;
}) {
  // Selected state: tinted bg at low alpha + matching border + tone-
  // colored text + a small filled dot indicator. ERROR / WARN keep
  // their danger / warning hues so the chip's role stays legible at
  // a glance. INFO / DEBUG / TRACE use the accent (foliage) hue.
  //
  // Unselected state: half-opacity, neutral border, dim text, no
  // fill — clearly "off". This makes deep-linking from the home
  // page with `?levels=ERROR,WARN` read correctly: ERROR + WARN
  // pop, the other three obviously recede.
  const tone = levelTone(level);
  const tint = levelTint(level);
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "4px 10px",
        fontSize: 11,
        fontFamily: "var(--kx-font-mono)",
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        color: on ? tone : "var(--kx-fg-muted)",
        background: on ? tint : "transparent",
        border: `1px solid ${on ? tone : "var(--kx-border)"}`,
        borderRadius: "var(--kx-r-pill)",
        cursor: "pointer",
        opacity: on ? 1 : 0.5,
        fontWeight: on ? 600 : 400,
        transition: "all 160ms var(--kx-ease)",
      }}
      aria-pressed={on}
      title={on ? `${level} (visible) — click to hide` : `${level} (hidden) — click to show`}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: on ? tone : "transparent",
          border: on ? "none" : "1px solid var(--kx-fg-muted)",
          flex: "0 0 auto",
        }}
      />
      {level}
    </button>
  );
}

function levelTone(level: string): string {
  switch (level.toUpperCase()) {
    case "ERROR":
      return "var(--kx-danger)";
    case "WARN":
      return "var(--kx-warning)";
    case "DEBUG":
    case "TRACE":
      return "var(--kx-fg-muted)";
    default:
      return "var(--kx-accent)";
  }
}

// Background tint that matches the tone color at low alpha. Mirrors
// the `*-soft` design tokens so the chip blends with the surface
// palette instead of looking pasted on.
function levelTint(level: string): string {
  switch (level.toUpperCase()) {
    case "ERROR":
      return "var(--kx-danger-soft)";
    case "WARN":
      return "var(--kx-warning-soft)";
    case "DEBUG":
    case "TRACE":
      // No dedicated muted-soft token — use a subtle surface bump so
      // selected DEBUG / TRACE chips read as "on" without competing
      // with the accent colors.
      return "var(--kx-surface-2)";
    default:
      return "var(--kx-accent-soft)";
  }
}

function pillStyle(active: boolean): CSSProperties {
  return {
    padding: "5px 12px",
    fontSize: "var(--kx-fs-12)",
    fontFamily: "var(--kx-font-mono)",
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: active ? "var(--kx-accent)" : "var(--kx-fg-2)",
    background: active ? "var(--kx-accent-soft)" : "var(--kx-surface-2)",
    border: `1px solid ${active ? "var(--kx-border-glow)" : "var(--kx-border)"}`,
    borderRadius: "var(--kx-r-pill)",
    cursor: "pointer",
    transition: "all 160ms var(--kx-ease)",
  };
}

const inputStyle: CSSProperties = {
  flex: "1 1 220px",
  minWidth: 180,
  padding: "6px 10px",
  fontSize: "var(--kx-fs-13)",
  fontFamily: "var(--kx-font-mono)",
  color: "var(--kx-fg)",
  background: "var(--kx-bg)",
  border: "1px solid var(--kx-border)",
  borderRadius: "var(--kx-r-md)",
  outline: "none",
};
