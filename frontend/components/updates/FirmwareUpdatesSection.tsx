"use client";

// Updates page > Firmware section.
//
// Drives off two SC-10 endpoints:
//   GET /api/firmware/status  -> installed version + state machine
//   GET /api/firmware/releases -> full release list (sorted newest-first)
//
// Composition:
//   1. Installed firmware card (mirrors the software section's shape
//      so the page reads as one rhythm).
//   2. Update banner — only rendered when state is available /
//      downloading / ready / failed.
//   3. Searchable / filterable releases list with channel chips +
//      substring search across version + commit.
//   4. Manual flash file picker stub (Flash is wired in SC-13).
//
// All flash interactions probe the 501 stubs and surface a clear
// "Coming in SC-13" message — the UI is shape-complete today and
// becomes functional once SC-13 wires teensy_loader_cli.

import { useMemo, useState, type ChangeEvent } from "react";
import {
  Download,
  HardDrive,
  RefreshCw,
  RotateCcw,
  Search,
  Unplug,
  Upload,
  Zap,
} from "lucide-react";

import { useFirmwareReleases } from "../../lib/hooks/useFirmwareReleases";
import { useFirmwareStatus } from "../../lib/hooks/useFirmwareStatus";
import { useUpdater } from "../../lib/hooks/useUpdater";
import {
  flash,
  flashLocal,
  type FirmwareReleaseEntry,
  type FlashResult,
} from "../../lib/api/firmware";
import Card from "../ui/Card";
import Eyebrow from "../ui/Eyebrow";
import ActionButton from "./ActionButton";
import ProgressBar from "./ProgressBar";
import StateChip, { type StateChipTone } from "./StateChip";

type ChannelFilter = "all" | "stable" | "nightly";

function chipForKind(kind: string | undefined): {
  tone: StateChipTone;
  label: string;
} {
  switch (kind) {
    case "up_to_date":
      return { tone: "foliage", label: "Up to date" };
    case "available":
      return { tone: "copper", label: "Update available" };
    case "downloading":
      return { tone: "foliage", label: "Downloading" };
    case "ready":
      return { tone: "copper", label: "Ready to flash" };
    case "failed":
      return { tone: "danger", label: "Failed" };
    default:
      return { tone: "muted", label: "Idle" };
  }
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.round(months / 12);
  return `${years}y ago`;
}

function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KiB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MiB`;
}

function flashErrorCopy(result: FlashResult): string {
  if (result.ok) return "";
  switch (result.reason) {
    case "not_implemented":
      return "Flash integration is coming in SC-13. The button surface is in place; the daemon command isn't wired yet.";
    case "device_not_connected":
      return "Connect your StreamCheats device first — no heartbeat detected.";
    case "hex_not_downloaded":
      return "Download the firmware first, then flash.";
    case "already_flashing":
      return "Another flash is already in progress.";
    case "network":
      return "Couldn't reach the daemon. Is StreamCheats running?";
    default:
      return result.detail ?? "Flash failed.";
  }
}

export default function FirmwareUpdatesSection() {
  const { status, busy, loaded, runCheck, runDownload } = useFirmwareStatus();
  const { releases, loaded: releasesLoaded, refresh: refreshReleases } =
    useFirmwareReleases();
  // Reuse the existing experimental_builds flag so the nightly chip
  // visibility is consistent with the software section's gate.
  const { experimental } = useUpdater();

  const state = status?.state;
  const kind = state?.kind;
  const installedVersion = status?.installed_version ?? null;
  const installedChannel = status?.channel ?? "unknown";
  const board = status?.board ?? null;
  const chip = chipForKind(kind);

  // Filter state
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("stable");
  const [search, setSearch] = useState("");

  // Derive the *effective* channel filter rather than syncing into
  // state via an effect. If the user disabled experimental_builds in
  // another surface, a stored "nightly" selection is silently treated
  // as "stable" until they pick again — no cascading render.
  const effectiveChannelFilter: ChannelFilter =
    !experimental && channelFilter === "nightly" ? "stable" : channelFilter;

  const visibleReleases = useMemo(() => {
    const q = search.trim().toLowerCase();
    return releases.filter((r) => {
      if (
        effectiveChannelFilter !== "all" &&
        r.channel !== effectiveChannelFilter
      )
        return false;
      if (!experimental && r.channel === "nightly") return false;
      if (q.length > 0) {
        const hay = `${r.version} ${r.commit ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [releases, effectiveChannelFilter, search, experimental]);

  const onCheck = async () => {
    await runCheck();
    await refreshReleases();
  };

  return (
    <section
      aria-label="Firmware updates"
      className="flex flex-col gap-4"
    >
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <Eyebrow>firmware</Eyebrow>
        <StateChip tone={chip.tone}>{chip.label}</StateChip>
      </header>

      <InstalledFirmwareCard
        loaded={loaded}
        installedVersion={installedVersion}
        installedChannel={installedChannel}
        board={board}
        busy={busy}
        onCheck={() => void onCheck()}
      />

      {state && (kind === "available" || kind === "ready") ? (
        <AvailableBanner
          latest={state.latest}
          channel={state.channel}
          notesUrl={state.notes_url ?? null}
          assetSize={state.asset_size}
          ready={kind === "ready"}
          busy={busy}
          onDownload={() => state.latest && void runDownload(state.latest)}
        />
      ) : null}

      {kind === "downloading" ? (
        <Card aria-label="Firmware download progress" static>
          <ProgressBar
            percent={state?.percent ?? null}
            bytesSoFar={state?.bytes_so_far}
            totalBytes={state?.total_bytes ?? null}
            label={`Downloading ${state?.latest ?? ""}`}
          />
        </Card>
      ) : null}

      {kind === "failed" ? (
        <Card aria-label="Firmware update error" static>
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0 flex flex-col gap-2">
              <span className="sc-chrome text-[10px] text-danger">error</span>
              <p
                className="text-[12px] text-danger font-mono break-all"
                role="alert"
              >
                {state?.error ?? "Unknown error."}
              </p>
            </div>
            <ActionButton tone="ghost" onClick={() => void onCheck()} disabled={busy}>
              <RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" />
              Try again
            </ActionButton>
          </div>
        </Card>
      ) : null}

      <ReleasesList
        releases={releases}
        visibleReleases={visibleReleases}
        releasesLoaded={releasesLoaded}
        channelFilter={effectiveChannelFilter}
        setChannelFilter={setChannelFilter}
        search={search}
        setSearch={setSearch}
        experimental={experimental}
        installedVersion={installedVersion}
        busy={busy}
        onDownload={(v) => void runDownload(v)}
        downloadingVersion={
          kind === "downloading" ? state?.latest ?? null : null
        }
      />

      <ManualFlashCard />
    </section>
  );
}

function InstalledFirmwareCard({
  loaded,
  installedVersion,
  installedChannel,
  board,
  busy,
  onCheck,
}: {
  loaded: boolean;
  installedVersion: string | null;
  installedChannel: "stable" | "nightly" | "unknown";
  board: string | null;
  busy: boolean;
  onCheck: () => void;
}) {
  const connected = installedVersion != null;
  return (
    <Card aria-label="Installed firmware" static>
      <div className="flex items-start gap-4 flex-wrap">
        <div
          aria-hidden="true"
          className="
            shrink-0
            w-10 h-10
            rounded-[8px]
            bg-substrate-2 border border-hairline
            flex items-center justify-center
            text-ink-muted
          "
        >
          {connected ? (
            <HardDrive size={18} strokeWidth={1.75} />
          ) : (
            <Unplug size={18} strokeWidth={1.75} />
          )}
        </div>

        <div className="flex flex-col min-w-0 flex-1">
          <span className="sc-chrome text-[10px] text-ink-dim">
            installed firmware
          </span>
          {connected ? (
            <>
              <span className="font-mono text-ink text-[20px] leading-tight mt-1 break-all">
                {installedVersion}
              </span>
              <span className="sc-chrome text-[10px] text-ink-dim mt-2">
                {board ? `board · ${board}` : "board · —"}
                {installedChannel !== "unknown" ? (
                  <>
                    {" · channel · "}
                    {installedChannel}
                  </>
                ) : null}
              </span>
            </>
          ) : (
            <>
              <span className="text-ink text-[14px] leading-snug mt-1">
                {loaded
                  ? "Connect your StreamCheats device to detect firmware."
                  : "Reading device…"}
              </span>
              <span className="sc-chrome text-[10px] text-ink-dim mt-2">
                no heartbeat
              </span>
            </>
          )}
        </div>

        <div className="flex flex-col items-stretch gap-2 shrink-0">
          <ActionButton tone="ghost" onClick={onCheck} disabled={busy}>
            <RefreshCw size={12} strokeWidth={1.75} aria-hidden="true" />
            Check now
          </ActionButton>
        </div>
      </div>
    </Card>
  );
}

function AvailableBanner({
  latest,
  channel,
  notesUrl,
  assetSize,
  ready,
  busy,
  onDownload,
}: {
  latest: string | undefined;
  channel: string | undefined;
  notesUrl: string | null;
  assetSize: number | undefined;
  ready: boolean;
  busy: boolean;
  onDownload: () => void;
}) {
  const [flashing, setFlashing] = useState(false);
  const [flashError, setFlashError] = useState<string | null>(null);

  const onFlash = async () => {
    if (!latest) return;
    setFlashing(true);
    setFlashError(null);
    try {
      const r = await flash(latest);
      if (!r.ok) setFlashError(flashErrorCopy(r));
    } finally {
      setFlashing(false);
    }
  };

  return (
    <Card aria-label="Firmware update available" static>
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex flex-col flex-1 min-w-0">
          <span className="sc-chrome text-[10px] text-copper">
            {ready ? "ready to flash" : "available"}
          </span>
          <span className="font-mono text-ink text-[18px] leading-tight mt-1 break-all">
            {latest ?? "—"}
          </span>
          <span className="sc-chrome text-[10px] text-ink-dim mt-2">
            {channel ? `channel · ${channel}` : null}
            {assetSize ? ` · ${formatBytes(assetSize)}` : null}
          </span>
          {notesUrl ? (
            <a
              href={notesUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-2 text-[12px] text-foliage underline decoration-[color:var(--sc-foliage)]/40 underline-offset-2 hover:decoration-[color:var(--sc-foliage)]"
            >
              View release notes →
            </a>
          ) : null}
        </div>

        <div className="flex flex-col items-stretch gap-2 shrink-0">
          {!ready ? (
            <ActionButton
              tone="foliage"
              onClick={onDownload}
              disabled={busy || !latest}
            >
              <Download size={12} strokeWidth={1.75} aria-hidden="true" />
              Download
            </ActionButton>
          ) : null}
          <ActionButton
            tone={ready ? "copper" : "ghost"}
            onClick={() => void onFlash()}
            disabled={flashing}
            title={ready ? "Flash to device" : "Download first, then flash"}
          >
            <Zap size={12} strokeWidth={1.75} aria-hidden="true" />
            Flash
          </ActionButton>
        </div>
      </div>
      {flashError ? (
        <p className="mt-3 text-[12px] text-warn leading-relaxed" role="alert">
          {flashError}
        </p>
      ) : null}
    </Card>
  );
}

function ReleasesList({
  releases,
  visibleReleases,
  releasesLoaded,
  channelFilter,
  setChannelFilter,
  search,
  setSearch,
  experimental,
  installedVersion,
  busy,
  onDownload,
  downloadingVersion,
}: {
  releases: FirmwareReleaseEntry[];
  visibleReleases: FirmwareReleaseEntry[];
  releasesLoaded: boolean;
  channelFilter: ChannelFilter;
  setChannelFilter: (c: ChannelFilter) => void;
  search: string;
  setSearch: (s: string) => void;
  experimental: boolean;
  installedVersion: string | null;
  busy: boolean;
  onDownload: (version: string) => void;
  downloadingVersion: string | null;
}) {
  return (
    <Card aria-label="Firmware releases" static>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Eyebrow>all releases</Eyebrow>
          <span className="sc-chrome text-[10px] text-ink-dim">
            {visibleReleases.length} of {releases.length}
          </span>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-2 flex-wrap">
          <ChannelChip
            current={channelFilter}
            value="all"
            label="All"
            onChange={setChannelFilter}
          />
          <ChannelChip
            current={channelFilter}
            value="stable"
            label="Stable"
            onChange={setChannelFilter}
          />
          {experimental ? (
            <ChannelChip
              current={channelFilter}
              value="nightly"
              label="Nightly"
              onChange={setChannelFilter}
            />
          ) : null}
        </div>

        {/* Search input */}
        <label className="flex items-center gap-2 px-3 py-2 border border-hairline rounded-[6px] bg-substrate-2 focus-within:border-hairline-2 transition-colors"
          style={{ transitionDuration: "var(--sc-dur-quick)" }}
        >
          <Search
            size={14}
            strokeWidth={1.75}
            aria-hidden="true"
            className="text-foliage shrink-0"
          />
          <span className="sr-only">Search firmware releases</span>
          <span
            aria-hidden="true"
            className="font-mono text-foliage text-[12px] select-none"
          >
            &gt;
          </span>
          <input
            type="search"
            value={search}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setSearch(e.target.value)
            }
            placeholder="rel-5.17  ca8298b…"
            className="
              flex-1 min-w-0
              bg-transparent outline-none
              font-mono text-[12px] text-ink
              placeholder:text-ink-dim
            "
          />
        </label>

        {/* List */}
        {!releasesLoaded ? (
          <p className="text-[12px] text-ink-dim font-mono py-4">
            Loading releases…
          </p>
        ) : releases.length === 0 ? (
          <p className="text-[12px] text-ink-muted leading-relaxed py-4">
            No firmware releases found. Either no internet or the daemon
            hasn&apos;t completed its first check yet — give it a moment.
          </p>
        ) : visibleReleases.length === 0 ? (
          <p className="text-[12px] text-ink-muted leading-relaxed py-4">
            No releases match the current filters.
          </p>
        ) : (
          <ul className="flex flex-col">
            {visibleReleases.map((r) => (
              <ReleaseRow
                key={`${r.version}-${r.asset_name}`}
                release={r}
                installed={installedVersion === r.version}
                busy={busy}
                downloading={downloadingVersion === r.version}
                onDownload={() => onDownload(r.version)}
              />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function ChannelChip({
  current,
  value,
  label,
  onChange,
}: {
  current: ChannelFilter;
  value: ChannelFilter;
  label: string;
  onChange: (next: ChannelFilter) => void;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      aria-pressed={active}
      className={`
        sc-chrome text-[10px]
        px-2.5 py-1
        border rounded-[3px]
        transition-colors cursor-pointer
        ${
          active
            ? "text-foliage border-[color:var(--sc-foliage)]/50 bg-[color:var(--sc-foliage)]/10"
            : "text-ink-dim border-hairline hover:text-ink-muted hover:border-hairline-2"
        }
      `}
      style={{ transitionDuration: "var(--sc-dur-quick)" }}
    >
      {label}
    </button>
  );
}

function ReleaseRow({
  release,
  installed,
  busy,
  downloading,
  onDownload,
}: {
  release: FirmwareReleaseEntry;
  installed: boolean;
  busy: boolean;
  downloading: boolean;
  onDownload: () => void;
}) {
  const [flashing, setFlashing] = useState(false);
  const [flashError, setFlashError] = useState<string | null>(null);

  const onFlash = async () => {
    setFlashing(true);
    setFlashError(null);
    try {
      const r = await flash(release.version);
      if (!r.ok) setFlashError(flashErrorCopy(r));
    } finally {
      setFlashing(false);
    }
  };

  return (
    <li
      className={`
        flex flex-col gap-2
        py-3 px-3 -mx-3
        border-t border-hairline first:border-t-0
        ${installed ? "bg-[color:var(--sc-foliage)]/[0.04]" : ""}
      `}
      style={
        installed ? { boxShadow: "inset 2px 0 0 0 var(--sc-foliage)" } : undefined
      }
    >
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-ink text-[13px] break-all">
              {release.version}
            </span>
            <span
              className={`
                sc-chrome text-[9px] px-1.5 py-0.5 border rounded-[3px]
                ${
                  release.channel === "nightly"
                    ? "text-copper border-[color:var(--sc-copper)]/40"
                    : "text-foliage border-[color:var(--sc-foliage)]/40"
                }
              `}
            >
              {release.channel}
            </span>
            {installed ? (
              <span className="sc-chrome text-[9px] text-foliage">
                installed
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-1 text-[11px] font-mono text-ink-dim">
            <span>{relativeTime(release.published_at)}</span>
            <span aria-hidden="true" className="opacity-40">
              ·
            </span>
            <span>{formatBytes(release.asset_size)}</span>
            {release.commit ? (
              <>
                <span aria-hidden="true" className="opacity-40">
                  ·
                </span>
                <span className="text-ink-muted">{release.commit}</span>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <ActionButton
            tone="ghost"
            onClick={onDownload}
            disabled={busy || downloading}
            aria-label={`Download ${release.version}`}
          >
            <Download size={12} strokeWidth={1.75} aria-hidden="true" />
            {downloading ? "Downloading…" : "Download"}
          </ActionButton>
          <ActionButton
            tone="ghost"
            onClick={() => void onFlash()}
            disabled={flashing}
            aria-label={`Flash ${release.version}`}
            title="Flash integration ships in SC-13"
          >
            <Zap size={12} strokeWidth={1.75} aria-hidden="true" />
            Flash
          </ActionButton>
        </div>
      </div>
      {flashError ? (
        <p className="text-[11px] text-warn leading-relaxed" role="alert">
          {flashError}
        </p>
      ) : null}
    </li>
  );
}

function ManualFlashCard() {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await flashLocal(path.trim());
      if (!r.ok) setError(flashErrorCopy(r));
    } finally {
      setBusy(false);
    }
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    // Browsers don't expose a real filesystem path for security
    // reasons, so we surface the filename here; SC-13 will replace
    // this control with an Electron-native picker that hands the
    // daemon an absolute path. For now we accept a typed-in path
    // alongside the picker so dev mode is usable.
    setPath(f.name);
  };

  return (
    <Card aria-label="Manual firmware flash" static>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Eyebrow tone="muted">manual flash</Eyebrow>
          <span className="sc-chrome text-[10px] text-ink-dim">.hex</span>
        </div>
        <p className="text-[12px] text-ink-muted leading-relaxed">
          Flash any local <span className="font-mono text-ink">.hex</span>{" "}
          file, including older firmware. Useful for downgrading.
        </p>

        <form onSubmit={onSubmit} className="flex flex-col gap-2">
          <label className="flex items-center gap-2 px-3 py-2 border border-hairline rounded-[6px] bg-substrate-2">
            <Upload
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              className="text-ink-dim shrink-0"
            />
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="C:\path\to\firmware.hex"
              className="
                flex-1 min-w-0
                bg-transparent outline-none
                font-mono text-[12px] text-ink
                placeholder:text-ink-dim
              "
            />
            <label className="cursor-pointer sc-chrome text-[10px] text-ink-muted hover:text-ink transition-colors"
              style={{ transitionDuration: "var(--sc-dur-quick)" }}
            >
              Browse
              <input
                type="file"
                accept=".hex"
                onChange={onPick}
                className="sr-only"
              />
            </label>
          </label>
          <div className="flex justify-end">
            <ActionButton
              tone="ghost"
              type="submit"
              disabled={busy || !path.trim()}
              title="Flash integration ships in SC-13"
            >
              <Zap size={12} strokeWidth={1.75} aria-hidden="true" />
              Flash file
            </ActionButton>
          </div>
        </form>

        {error ? (
          <p className="text-[12px] text-warn leading-relaxed" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
