"use client";

// Live log stream, restyled against the SC design tokens for SC-11.
//
// Layered top-to-bottom:
//   1. Status row     — stream state + rate + buffer counts, JetBrains Mono
//   2. Filter bar     — severity multi-select chips + substring search + Clear
//   3. Viewport       — bg-substrate-2, hairline border, monospace rows
//
// Severity styling: the body of each row inherits ink-muted; we only
// colour the severity glyph + text (danger / warn / foliage / ink-dim)
// so the wall of text stays visually quiet. No row backgrounds.
//
// Autoscroll behaviour is preserved from the original LogViewport — we
// stick to the bottom unless the user has scrolled away, then resume
// only when they scroll back to the bottom or toggle autoscroll back on.

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowDownToLine,
  Clock,
  Database,
  Eye,
  Gauge,
  Pause,
  Play,
  Tag,
  Trash2,
} from "lucide-react";

import {
  useLogStream,
  type LogEvent,
  type LogStreamStatus,
} from "../lib/hooks/useLogStream";
import { splitPrefix } from "../lib/log/format";

const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"] as const;
type Level = (typeof LEVELS)[number];
type LevelToggleSet = Record<Level, boolean>;

const DEFAULT_LEVELS: LevelToggleSet = {
  ERROR: true,
  WARN: true,
  INFO: true,
  DEBUG: true,
  TRACE: true,
};

const LS_SHOW_LEVEL = "sc:logs:showLevel";
const LS_SHOW_TIMESTAMP = "sc:logs:showTimestamp";

function readBoolPref(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "1" || raw === "true";
  } catch {
    return fallback;
  }
}

function writeBoolPref(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* swallow quota / privacy-mode errors */
  }
}

function parseLevels(initial?: readonly string[]): LevelToggleSet {
  if (!initial || initial.length === 0) return DEFAULT_LEVELS;
  const allow = new Set(
    initial.map((l) => l.trim().toUpperCase()).filter(Boolean),
  );
  return {
    ERROR: allow.has("ERROR"),
    WARN: allow.has("WARN"),
    INFO: allow.has("INFO"),
    DEBUG: allow.has("DEBUG"),
    TRACE: allow.has("TRACE"),
  };
}

export default function LogStream({
  initialLevels,
}: {
  initialLevels?: readonly string[];
} = {}) {
  const stream = useLogStream();
  const [filter, setFilter] = useState("");
  const [levels, setLevels] = useState<LevelToggleSet>(() =>
    parseLevels(initialLevels),
  );
  const [autoscroll, setAutoscroll] = useState(true);
  // Column visibility — persisted via localStorage. Lazy initializer
  // reads once; the LogStream itself is a "use client" island so SSR
  // produces neutral markup and only the client renders the row body.
  const [showLevel, setShowLevel] = useState<boolean>(() =>
    readBoolPref(LS_SHOW_LEVEL, true),
  );
  const [showTimestamp, setShowTimestamp] = useState<boolean>(() =>
    readBoolPref(LS_SHOW_TIMESTAMP, true),
  );

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const userScrolledUpRef = useRef(false);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return stream.events.filter((e) => {
      const lvl = e.level.toUpperCase() as Level;
      if (lvl in levels && !levels[lvl]) return false;
      if (!needle) return true;
      return e.line.toLowerCase().includes(needle);
    });
  }, [stream.events, filter, levels]);

  // Pin to bottom before paint so the viewport doesn't visibly drift.
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
    userScrolledUpRef.current = distFromBottom > 8;
  };

  return (
    <section
      aria-label="Live log viewer"
      className="flex flex-col gap-3 min-h-0 flex-1"
    >
      <StatusRow
        status={stream.status}
        eventsPerSec={stream.eventsPerSec}
        bufferCount={stream.bufferCount}
        lagCount={stream.lagCount}
        visibleCount={visible.length}
        paused={stream.paused}
        onPauseToggle={() =>
          stream.paused ? stream.resume() : stream.pause()
        }
        autoscroll={autoscroll}
        onAutoscrollToggle={() => {
          const next = !autoscroll;
          setAutoscroll(next);
          if (next) userScrolledUpRef.current = false;
        }}
        showLevel={showLevel}
        onShowLevelToggle={() => {
          const next = !showLevel;
          setShowLevel(next);
          writeBoolPref(LS_SHOW_LEVEL, next);
        }}
        showTimestamp={showTimestamp}
        onShowTimestampToggle={() => {
          const next = !showTimestamp;
          setShowTimestamp(next);
          writeBoolPref(LS_SHOW_TIMESTAMP, next);
        }}
      />

      <FilterBar
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
        className="
          flex-1 min-h-0
          overflow-x-auto overflow-y-auto
          bg-substrate-2 border border-hairline rounded-[8px]
          px-4 py-3
          font-mono text-[12.5px]
          text-ink-muted
        "
        style={{ lineHeight: 1.5, fontVariantNumeric: "tabular-nums" }}
      >
        {visible.length === 0 ? (
          <span className="text-ink-dim">(no events)</span>
        ) : (
          visible.map((e, i) => (
            <Row
              key={`${e.ts}-${i}`}
              event={e}
              showLevel={showLevel}
              showTimestamp={showTimestamp}
            />
          ))
        )}
      </div>
    </section>
  );
}

function Row({
  event,
  showLevel,
  showTimestamp,
}: {
  event: LogEvent;
  showLevel: boolean;
  showTimestamp: boolean;
}) {
  const { prefix, rest } = splitPrefix(event.line);
  const levelColor = levelTone(event.level);
  const bodyColor = bodyTone(event.level);
  // HH:MM:SS.mmm slice from the ISO timestamp — full ISO is too noisy.
  const ts = event.ts.length >= 23 ? event.ts.substring(11, 23) : event.ts;
  return (
    // Single-line rows — long messages extend the row's intrinsic width
    // so the viewport scrolls horizontally instead of breaking the
    // log's structure across multiple visual lines.
    <div
      className="flex gap-2"
      style={{ whiteSpace: "nowrap" }}
    >
      {showTimestamp && (
        <span className="text-ink-dim shrink-0">{ts}</span>
      )}
      {showLevel && (
        <span
          className="shrink-0 sc-chrome text-[10.5px]"
          style={{ color: levelColor, width: 44, letterSpacing: "0.08em" }}
        >
          {event.level.toUpperCase()}
        </span>
      )}
      <span className="shrink-0" style={{ color: bodyColor }}>
        {prefix && (
          <span className="text-foliage sc-chrome text-[11px] mr-1">
            {prefix}
          </span>
        )}
        {highlightBody(rest)}
      </span>
    </div>
  );
}

// Subtle per-level body tint. ERROR/WARN rows get a desaturated tint
// of their severity color so the row reads as that severity at a
// glance without screaming. INFO/DEBUG/TRACE stay in the neutral
// muted/dim ink palette so the bulk of the stream stays quiet.
function bodyTone(level: string): string {
  switch (level.toUpperCase()) {
    case "ERROR":
      // ~75% opacity blend of --sc-danger over substrate-2.
      return "rgba(196, 106, 106, 0.85)";
    case "WARN":
      // ~75% opacity blend of --sc-warn over substrate-2.
      return "rgba(212, 168, 87, 0.85)";
    case "INFO":
      return "var(--sc-ink-muted)";
    case "DEBUG":
    case "TRACE":
    default:
      return "var(--sc-ink-dim)";
  }
}

// Conservative numeric / bracketed-content highlight. We bump runs of
// digits (and bracketed numbers like "[42]" / "(115200)") up to the
// brighter --sc-ink so packet counts, ports, and IDs pop out of the
// body color. Punctuation and bracket characters themselves stay in
// the body color so we don't paint over the visual rhythm of the line.
const NUM_RE = /(\d+(?:\.\d+)?)/g;

function highlightBody(text: string): ReactNode {
  if (!text) return text;
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  let i = 0;
  for (const m of text.matchAll(NUM_RE)) {
    const start = m.index ?? 0;
    if (start > lastIdx) parts.push(text.slice(lastIdx, start));
    parts.push(
      <span key={i++} style={{ color: "var(--sc-ink)" }}>
        {m[0]}
      </span>,
    );
    lastIdx = start + m[0].length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

function levelTone(level: string): string {
  switch (level.toUpperCase()) {
    case "ERROR":
      return "var(--sc-danger)";
    case "WARN":
      return "var(--sc-copper)";
    case "INFO":
      return "var(--sc-ink-muted)";
    case "DEBUG":
    case "TRACE":
    default:
      return "var(--sc-ink-dim)";
  }
}

/* ────────────────────────── Status row ────────────────────────── */

function StatusRow({
  status,
  eventsPerSec,
  bufferCount,
  lagCount,
  visibleCount,
  paused,
  onPauseToggle,
  autoscroll,
  onAutoscrollToggle,
  showLevel,
  onShowLevelToggle,
  showTimestamp,
  onShowTimestampToggle,
}: {
  status: LogStreamStatus;
  eventsPerSec: number;
  bufferCount: number;
  lagCount: number;
  visibleCount: number;
  paused: boolean;
  onPauseToggle: () => void;
  autoscroll: boolean;
  onAutoscrollToggle: () => void;
  showLevel: boolean;
  onShowLevelToggle: () => void;
  showTimestamp: boolean;
  onShowTimestampToggle: () => void;
}) {
  const s = statusVisual(status);
  // Compact, single-line row. At 730px CSS the previous layout wrapped
  // because the labeled "rate / buffer / visible / autoscroll" stack
  // overflowed; we now drop the labels in favour of icons + tabular
  // numerics and collapse the toggles to icon-only with tooltips.
  return (
    <div
      className="
        flex flex-nowrap items-center gap-x-3
        px-3 py-2 rounded-[8px]
        bg-panel border border-hairline
        sc-chrome text-[10.5px]
        min-w-0
      "
    >
      <span
        className="inline-flex items-center gap-1.5 shrink-0"
        style={{ color: s.color }}
        title={s.label}
        aria-label={`Stream status: ${s.label}`}
      >
        <span aria-hidden="true">{s.glyph}</span>
      </span>
      <Sep />
      <CompactMetric
        Icon={Gauge}
        value={`${eventsPerSec}/s`}
        title={`Events per second: ${eventsPerSec}/s`}
      />
      <Sep />
      <CompactMetric
        Icon={Database}
        value={fmtNum(bufferCount)}
        title={`Buffered events: ${fmtNum(bufferCount)}`}
      />
      <Sep />
      <CompactMetric
        Icon={Eye}
        value={fmtNum(visibleCount)}
        title={`Visible events after filtering: ${fmtNum(visibleCount)}`}
      />
      {lagCount > 0 && (
        <>
          <Sep />
          <CompactMetric
            Icon={Database}
            value={fmtNum(lagCount)}
            title={`Dropped events (lagged): ${fmtNum(lagCount)}`}
            color="var(--sc-copper)"
          />
        </>
      )}
      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        <IconToggle
          on={!paused}
          onClick={onPauseToggle}
          Icon={paused ? Play : Pause}
          label={paused ? "Resume stream" : "Pause stream"}
        />
        <IconToggle
          on={autoscroll}
          onClick={onAutoscrollToggle}
          Icon={ArrowDownToLine}
          label={autoscroll ? "Disable autoscroll" : "Enable autoscroll"}
        />
        <IconToggle
          on={showTimestamp}
          onClick={onShowTimestampToggle}
          Icon={Clock}
          label={showTimestamp ? "Hide timestamp" : "Show timestamp"}
        />
        <IconToggle
          on={showLevel}
          onClick={onShowLevelToggle}
          Icon={Tag}
          label={showLevel ? "Hide level" : "Show level"}
        />
      </div>
    </div>
  );
}

function CompactMetric({
  Icon,
  value,
  title,
  color,
}: {
  Icon: typeof Gauge;
  value: string;
  title: string;
  color?: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 shrink-0"
      title={title}
      aria-label={title}
      style={{ color: color ?? "var(--sc-ink)" }}
    >
      <Icon
        size={11}
        strokeWidth={1.75}
        aria-hidden="true"
        style={{ color: "var(--sc-ink-dim)" }}
      />
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </span>
  );
}

function IconToggle({
  on,
  onClick,
  Icon,
  label,
}: {
  on: boolean;
  onClick: () => void;
  Icon: typeof Pause;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      aria-label={label}
      title={label}
      className="
        inline-flex items-center justify-center
        h-6 w-6 rounded-[4px]
        border bg-substrate-2
        transition-colors
      "
      style={{
        color: on ? "var(--sc-foliage)" : "var(--sc-ink-dim)",
        borderColor: on ? "var(--sc-hairline-2)" : "var(--sc-hairline)",
        transitionDuration: "var(--sc-dur-quick)",
        transitionTimingFunction: "var(--sc-ease-out)",
      }}
    >
      <Icon size={12} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

function statusVisual(status: LogStreamStatus): {
  glyph: string;
  label: string;
  color: string;
} {
  switch (status) {
    case "streaming":
      return { glyph: "●", label: "streaming", color: "var(--sc-foliage)" };
    case "paused":
      return { glyph: "■", label: "paused", color: "var(--sc-copper)" };
    case "disconnected":
      return { glyph: "✕", label: "disconnected", color: "var(--sc-danger)" };
    case "connecting":
    default:
      return { glyph: "…", label: "connecting", color: "var(--sc-ink-dim)" };
  }
}

function Sep() {
  return (
    <span aria-hidden="true" className="text-ink-dim opacity-60">
      ·
    </span>
  );
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

/* ────────────────────────── Filter bar ────────────────────────── */

function FilterBar({
  filter,
  onFilterChange,
  levels,
  onLevelToggle,
  onClear,
}: {
  filter: string;
  onFilterChange: (v: string) => void;
  levels: LevelToggleSet;
  onLevelToggle: (lvl: Level) => void;
  onClear: () => void;
}) {
  return (
    <div
      className="
        flex flex-wrap items-center gap-2
        px-3 py-2 rounded-[8px]
        bg-panel border border-hairline
      "
    >
      <input
        type="text"
        value={filter}
        placeholder="filter messages…"
        onChange={(e) => onFilterChange(e.target.value)}
        aria-label="Filter logs by substring"
        className="
          flex-1 min-w-[160px]
          bg-substrate-2 border border-hairline rounded-[6px]
          px-2.5 py-1.5
          font-mono text-[12px] text-ink
          placeholder:text-ink-dim
          outline-none focus:border-hairline-2
        "
        style={{ transitionDuration: "var(--sc-dur-quick)" }}
      />
      <div className="flex items-center gap-1">
        {LEVELS.map((lvl) => (
          <LevelChip
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
        aria-label="Clear log buffer"
        title="Clear the UI buffer (daemon ring is unaffected)"
        className="
          inline-flex items-center justify-center shrink-0
          h-7 w-7 rounded-[6px] text-ink-dim
          border border-hairline bg-substrate-2
          hover:text-ink-muted hover:border-hairline-2
          transition-colors
        "
        style={{
          transitionDuration: "var(--sc-dur-quick)",
          transitionTimingFunction: "var(--sc-ease-out)",
        }}
      >
        <Trash2 size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

function LevelChip({
  level,
  on,
  onClick,
}: {
  level: Level;
  on: boolean;
  onClick: () => void;
}) {
  // For ON: tint the chip with the level's tone (12% fill + 45% border)
  // and bolden the label. For OFF: opacity-recede with a neutral
  // hairline so disabled levels read as visibly inactive — especially
  // important when the home page deep-links to logs with only ERROR +
  // WARN preselected, the other three need to look obviously off.
  const tone = levelTone(level); // CSS var: --sc-danger / --sc-warn / --sc-foliage / --sc-ink-dim
  const style: CSSProperties = on
    ? {
        color: tone,
        backgroundColor: `color-mix(in srgb, ${tone} 12%, transparent)`,
        borderColor: `color-mix(in srgb, ${tone} 45%, transparent)`,
        fontWeight: 600,
      }
    : {
        color: "var(--sc-ink-dim)",
        backgroundColor: "transparent",
        borderColor: "var(--sc-hairline)",
        opacity: 0.45,
      };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={`Toggle ${level}`}
      className="
        sc-chrome text-[10px]
        inline-flex items-center gap-1.5
        px-2 py-1 rounded-[4px]
        border
        transition-colors
      "
      style={{
        ...style,
        transitionDuration: "var(--sc-dur-quick)",
        transitionTimingFunction: "var(--sc-ease-out)",
      }}
    >
      <span
        aria-hidden="true"
        className="inline-block rounded-full"
        style={{
          width: 6,
          height: 6,
          backgroundColor: on ? tone : "transparent",
          border: on ? "none" : "1.5px solid currentColor",
          boxSizing: "border-box",
        }}
      />
      {level}
    </button>
  );
}

