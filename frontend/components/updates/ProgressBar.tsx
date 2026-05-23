// Thin foliage progress bar over a panel-2 track. Used by both the
// software and firmware sections during the `downloading` state.
// Renders an indeterminate stripe when `percent` is null (e.g. the
// daemon hasn't reported a total yet).

export interface ProgressBarProps {
  percent: number | null;
  bytesSoFar?: number;
  totalBytes?: number | null;
  label?: string;
}

function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KiB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MiB`;
}

export default function ProgressBar({
  percent,
  bytesSoFar,
  totalBytes,
  label,
}: ProgressBarProps) {
  const clamped = percent == null ? null : Math.max(0, Math.min(100, percent));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 text-[11px] font-mono text-ink-dim">
        <span className="truncate">{label ?? "Downloading…"}</span>
        <span className="shrink-0 text-ink-muted">
          {formatBytes(bytesSoFar)}{" "}
          <span className="opacity-50">/</span>{" "}
          {formatBytes(totalBytes ?? undefined)}
          {clamped != null ? (
            <>
              {" · "}
              <span className="text-ink">{clamped}%</span>
            </>
          ) : null}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped ?? undefined}
        aria-label={label ?? "Download progress"}
        className="h-1 w-full rounded-full bg-panel-2 overflow-hidden"
      >
        <div
          className="h-full bg-foliage rounded-full"
          style={{
            width: clamped == null ? "33%" : `${clamped}%`,
            transition: "width var(--sc-dur-base) var(--sc-ease-out)",
          }}
        />
      </div>
    </div>
  );
}
