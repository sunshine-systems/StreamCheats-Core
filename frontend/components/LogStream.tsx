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
} from "react";

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

export default function LogStream() {
  const stream = useLogStream();
  const [filter, setFilter] = useState("");
  const [levels, setLevels] = useState<LevelToggleSet>(DEFAULT_LEVELS);
  const [autoscroll, setAutoscroll] = useState(true);

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
          flex-1 min-h-0 overflow-auto
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
          visible.map((e, i) => <Row key={`${e.ts}-${i}`} event={e} />)
        )}
      </div>
    </section>
  );
}

function Row({ event }: { event: LogEvent }) {
  const { prefix, rest } = splitPrefix(event.line);
  const levelColor = levelTone(event.level);
  // HH:MM:SS.mmm slice from the ISO timestamp — full ISO is too noisy.
  const ts = event.ts.length >= 23 ? event.ts.substring(11, 23) : event.ts;
  return (
    <div
      className="flex gap-2"
      style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}
    >
      <span className="text-ink-dim shrink-0">{ts}</span>
      <span
        className="shrink-0 sc-chrome text-[10.5px]"
        style={{ color: levelColor, width: 44, letterSpacing: "0.08em" }}
      >
        {event.level.toUpperCase()}
      </span>
      <span className="flex-1 min-w-0">
        {prefix && (
          <span className="text-foliage sc-chrome text-[11px] mr-1">
            {prefix}
          </span>
        )}
        {rest}
      </span>
    </div>
  );
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
}) {
  const s = statusVisual(status);
  return (
    <div
      className="
        flex flex-wrap items-center gap-x-4 gap-y-2
        px-3 py-2 rounded-[8px]
        bg-panel border border-hairline
        sc-chrome text-[10.5px]
      "
    >
      <span className="inline-flex items-center gap-2" style={{ color: s.color }}>
        <span aria-hidden="true">{s.glyph}</span>
        <span>{s.label}</span>
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
            color="var(--sc-copper)"
          />
        </>
      )}
      <div className="ml-auto flex items-center gap-2">
        <ToggleChip
          on={!paused}
          onClick={onPauseToggle}
          label={paused ? "paused" : "live"}
          title={paused ? "Resume appending events" : "Pause the stream"}
        />
        <ToggleChip
          on={autoscroll}
          onClick={onAutoscrollToggle}
          label={autoscroll ? "autoscroll" : "scroll free"}
          title="Toggle stick-to-bottom"
        />
      </div>
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
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-ink-dim">{label}</span>
      <span style={{ color: color ?? "var(--sc-ink)" }}>{value}</span>
    </span>
  );
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
        title="Clear the UI buffer (daemon ring is unaffected)"
        className="
          sc-chrome text-[10.5px] text-ink-dim
          px-2.5 py-1.5 rounded-[6px]
          border border-hairline bg-substrate-2
          hover:text-ink-muted hover:border-hairline-2
          transition-colors
        "
        style={{
          transitionDuration: "var(--sc-dur-quick)",
          transitionTimingFunction: "var(--sc-ease-out)",
        }}
      >
        clear
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
  const tone = levelTone(level);
  const style: CSSProperties = on
    ? { color: tone, borderColor: "var(--sc-hairline-2)" }
    : {
        color: "var(--sc-ink-dim)",
        borderColor: "var(--sc-hairline)",
        opacity: 0.55,
      };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={`Toggle ${level}`}
      className="
        sc-chrome text-[10px]
        px-2 py-1 rounded-[4px]
        bg-substrate-2 border
        transition-colors
      "
      style={{
        ...style,
        transitionDuration: "var(--sc-dur-quick)",
        transitionTimingFunction: "var(--sc-ease-out)",
      }}
    >
      {level}
    </button>
  );
}

function ToggleChip({
  on,
  onClick,
  label,
  title,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className="
        sc-chrome text-[10px]
        px-2 py-1 rounded-[4px]
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
      {label}
    </button>
  );
}
