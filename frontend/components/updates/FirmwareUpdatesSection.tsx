"use client";

// Updates page > Firmware section.
//
// Drives off three SC-10 endpoints + two SC-13 endpoints:
//   GET  /api/firmware/status       — installed version + state machine
//   GET  /api/firmware/releases     — full release list (sorted newest-first)
//   POST /api/firmware/check        — re-poll GitHub now
//   POST /api/firmware/download     — start downloading a release
//   POST /api/firmware/flash        — flash a previously-downloaded release (SC-13)
//   POST /api/firmware/flash_local  — flash an arbitrary local .hex (SC-13)
//
// Composition:
//   1. Installed firmware card (mirrors the software section's shape).
//   2. Update banner — only rendered when state is available / ready / failed.
//   3. Active flash card — only rendered when state is flashing.
//   4. Searchable / filterable releases list.
//   5. Manual flash card with a native (Electron) .hex picker.
//
// Flash UX (SC-13):
//   * Clicking Flash on a row OR on the AvailableBanner triggers a
//     confirmation modal first. The modal shows the version delta
//     (downgrades are called out in copper). The action button reads
//     "I understand, flash" — typed-confirm felt heavy for a normal
//     up-version flash where downgrade-warning language doesn't apply.
//   * Manual flash uses the same modal with stronger copy about
//     unsigned-firmware risk.
//   * While state.kind === "flashing", buttons are disabled across
//     the section and an "elapsed time" stripe shows above the list.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from "react";
import {
  AlertTriangle,
  Download,
  HardDrive,
  Loader2,
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
  ensureLoader,
  flash,
  flashLocal,
  pickHexFile,
  type EnsureLoaderResult,
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
    case "flashing":
      return { tone: "copper", label: "Flashing" };
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
    case "flash_in_progress":
      return "Another flash is already in progress.";
    case "hex_not_downloaded":
      return "Download this release first, then flash.";
    case "unknown_version":
      return "Couldn't find that release in the daemon's cache.";
    case "unsupported_board":
      return "This board isn't supported by the bundled flasher yet.";
    case "invalid_hex":
      return result.detail
        ? `Hex file rejected: ${result.detail}`
        : "Hex file rejected — must exist, be non-empty, and end in .hex.";
    case "loader_unavailable":
      return "Flash tool isn't ready — download it first from the confirmation dialog.";
    case "not_implemented":
      return "Flash endpoint isn't wired in this daemon build.";
    case "network":
      return "Couldn't reach the daemon. Is StreamCheats running?";
    default:
      return result.detail ?? "Flash failed.";
  }
}

/**
 * SC-14: human-readable copy for each ensure_loader failure code. Keeps
 * the strings co-located with the action so the modal can render them
 * inline without an indirect lookup.
 */
function loaderErrorCopy(result: EnsureLoaderResult): string {
  if (result.ready) return "";
  switch (result.error) {
    case "loader_url_not_configured":
      return (
        "The flash tool download URL isn't configured yet. The maintainer " +
        "needs to host a Windows build of teensy_loader_cli and set " +
        "firmware.loader_url in config.json."
      );
    case "network_error":
      return result.message || "Couldn't reach the download server.";
    case "sha256_mismatch":
      return (
        "Downloaded file didn't match the expected checksum and was " +
        "discarded. Retry, or check firmware.loader_sha256 in config.json."
      );
    case "download_failed":
      return result.message || "Download failed.";
    default:
      return result.message || "Couldn't fetch the flash tool.";
  }
}

// Parse "rel-5.17" / "rel-5.17-ca8298b" → { major, minor }.
function parseRelMajorMinor(
  version: string | null | undefined
): { major: number; minor: number } | null {
  if (!version) return null;
  const stripped = version.replace(/^rel-/, "");
  const base = stripped.split("-")[0]; // drop nightly commit
  const [maj, min] = base.split(".").map((n) => Number.parseInt(n, 10));
  if (Number.isNaN(maj) || Number.isNaN(min)) return null;
  return { major: maj, minor: min };
}

/**
 * Is `target` strictly older than `installed`? Major.minor compare,
 * commit suffix ignored. Returns false when either is unparseable.
 */
function isDowngrade(
  installed: string | null | undefined,
  target: string | null | undefined
): boolean {
  const a = parseRelMajorMinor(installed);
  const b = parseRelMajorMinor(target);
  if (!a || !b) return false;
  if (b.major < a.major) return true;
  if (b.major === a.major && b.minor < a.minor) return true;
  return false;
}

export default function FirmwareUpdatesSection() {
  const { status, busy, loaded, refresh, runCheck, runDownload } =
    useFirmwareStatus();
  const { releases, loaded: releasesLoaded, refresh: refreshReleases } =
    useFirmwareReleases();
  const { experimental } = useUpdater();

  const state = status?.state;
  const kind = state?.kind;
  const installedVersion = status?.installed_version ?? null;
  const installedChannel = status?.channel ?? "unknown";
  const board = status?.board ?? null;
  const chip = chipForKind(kind);
  const flashing = kind === "flashing";
  // SC-14: when false, the confirm modal swaps the flash button for a
  // "Download flash tool" button that POSTs ensure_loader. Default to
  // true while loading so we don't briefly flash the wrong button.
  const loaderReady = status?.loader_ready ?? true;

  // Modal-driven flash confirmation. Holds the pending intent until
  // the user confirms or cancels.
  const [confirm, setConfirm] = useState<FlashConfirmIntent | null>(null);
  const [flashError, setFlashError] = useState<string | null>(null);
  const [flashOk, setFlashOk] = useState<string | null>(null);
  // SC-14: loader-download UI state. `loaderBusy` drives the spinner +
  // disables the confirm button; `loaderError` shows the copper-tinted
  // error card with a Retry inside the modal.
  const [loaderBusy, setLoaderBusy] = useState(false);
  const [loaderError, setLoaderError] = useState<string | null>(null);

  // Detect a flashing → up_to_date transition by stashing the previous
  // kind in component state. `setPrevKind` during render is the
  // documented React pattern for cheap derived-state updates, and is
  // preferable to a useEffect here (we want the success banner up on
  // the same paint that the state machine transitions).
  const [prevKind, setPrevKind] = useState<string | undefined>(undefined);
  if (prevKind !== kind) {
    setPrevKind(kind);
    if (prevKind === "flashing" && kind === "up_to_date") {
      setFlashOk("Flash complete.");
    } else if (kind === "flashing" && flashOk) {
      setFlashOk(null);
    }
  }

  const onCheck = async () => {
    await runCheck();
    await refreshReleases();
  };

  const onConfirm = useCallback(async () => {
    if (!confirm) return;
    setFlashError(null);
    setFlashOk(null);
    const r =
      confirm.kind === "release"
        ? await flash(confirm.version)
        : await flashLocal(confirm.path);
    setConfirm(null);
    if (!r.ok) {
      setFlashError(flashErrorCopy(r));
    }
  }, [confirm]);

  // SC-14: pre-flight download of `teensy_loader_cli.exe`. Called from
  // the confirm modal when `loader_ready` is false. On success we
  // refresh status so the modal flips back to the normal flash CTA;
  // on failure we render the copper-tinted error card with Retry.
  const onEnsureLoader = useCallback(async () => {
    setLoaderError(null);
    setLoaderBusy(true);
    try {
      const r = await ensureLoader();
      if (r.ready) {
        await refresh();
      } else {
        setLoaderError(loaderErrorCopy(r));
      }
    } finally {
      setLoaderBusy(false);
    }
  }, [refresh]);

  // Filter state
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("stable");
  const [search, setSearch] = useState("");

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

  return (
    <section aria-label="Firmware updates" className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <Eyebrow>firmware</Eyebrow>
        <StateChip tone={chip.tone}>{chip.label}</StateChip>
      </header>

      <InstalledFirmwareCard
        loaded={loaded}
        installedVersion={installedVersion}
        installedChannel={installedChannel}
        board={board}
        busy={busy || flashing}
        onCheck={() => void onCheck()}
      />

      {state && (kind === "available" || kind === "ready") ? (
        <AvailableBanner
          latest={state.latest}
          channel={state.channel}
          notesUrl={state.notes_url ?? null}
          assetSize={state.asset_size}
          ready={kind === "ready"}
          busy={busy || flashing}
          flashing={flashing}
          onDownload={() => state.latest && void runDownload(state.latest)}
          onFlash={() => {
            if (!state.latest) return;
            setConfirm({
              kind: "release",
              version: state.latest,
              installed: installedVersion,
              downgrade: isDowngrade(installedVersion, state.latest),
            });
          }}
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

      {flashing ? (
        <FlashingCard
          version={state?.version ?? state?.latest ?? "—"}
          hexPath={state?.hex_path ?? null}
          startedAt={state?.started_at ?? null}
        />
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
            <ActionButton
              tone="ghost"
              onClick={() => void onCheck()}
              disabled={busy || flashing}
            >
              <RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" />
              Try again
            </ActionButton>
          </div>
        </Card>
      ) : null}

      {flashError ? (
        <Card aria-label="Flash error" static>
          <p
            className="text-[12px] text-danger leading-relaxed"
            role="alert"
          >
            {flashError}
          </p>
        </Card>
      ) : null}

      {flashOk && !flashing && kind !== "failed" ? (
        <Card aria-label="Flash success" static>
          <p className="text-[12px] text-foliage leading-relaxed" role="status">
            {flashOk}
          </p>
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
        busy={busy || flashing}
        flashing={flashing}
        onDownload={(v) => void runDownload(v)}
        downloadingVersion={
          kind === "downloading" ? state?.latest ?? null : null
        }
        onFlash={(release) => {
          setConfirm({
            kind: "release",
            version: release.version,
            installed: installedVersion,
            downgrade: isDowngrade(installedVersion, release.version),
          });
        }}
      />

      <ManualFlashCard
        busy={flashing}
        onFlash={(path) => {
          setConfirm({
            kind: "manual",
            path,
            installed: installedVersion,
            downgrade: false,
          });
        }}
      />

      {confirm ? (
        <ConfirmFlashModal
          intent={confirm}
          loaderReady={loaderReady}
          loaderBusy={loaderBusy}
          loaderError={loaderError}
          onCancel={() => {
            setConfirm(null);
            setLoaderError(null);
          }}
          onConfirm={() => void onConfirm()}
          onEnsureLoader={() => void onEnsureLoader()}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

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
  flashing,
  onDownload,
  onFlash,
}: {
  latest: string | undefined;
  channel: string | undefined;
  notesUrl: string | null;
  assetSize: number | undefined;
  ready: boolean;
  busy: boolean;
  flashing: boolean;
  onDownload: () => void;
  onFlash: () => void;
}) {
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
            onClick={onFlash}
            disabled={!ready || flashing || !latest}
            title={ready ? "Flash to device" : "Download first, then flash"}
          >
            <Zap size={12} strokeWidth={1.75} aria-hidden="true" />
            Flash
          </ActionButton>
        </div>
      </div>
    </Card>
  );
}

function FlashingCard({
  version,
  hexPath,
  startedAt,
}: {
  version: string;
  hexPath: string | null;
  startedAt: string | null;
}) {
  // Compute elapsed time client-side, ticking every second. The
  // daemon emits an RFC3339 timestamp at flash start so we don't
  // depend on host clock drift between renderer and daemon.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsedSec = useMemo(() => {
    if (!startedAt) return null;
    const t = new Date(startedAt).getTime();
    if (Number.isNaN(t)) return null;
    return Math.max(0, Math.floor((now - t) / 1000));
  }, [startedAt, now]);

  return (
    <Card aria-label="Firmware flash in progress" static>
      <div className="flex items-center gap-3 flex-wrap">
        <Loader2
          size={18}
          strokeWidth={1.75}
          aria-hidden="true"
          className="text-copper animate-spin shrink-0"
        />
        <div className="flex flex-col min-w-0 flex-1">
          <span className="sc-chrome text-[10px] text-copper">
            flashing — do not unplug
          </span>
          <span className="font-mono text-ink text-[14px] mt-1 break-all">
            {version}
          </span>
          {hexPath ? (
            <span
              className="font-mono text-[10px] text-ink-dim mt-1 break-all"
              title={hexPath}
            >
              {hexPath}
            </span>
          ) : null}
        </div>
        <span
          className="sc-chrome text-[10px] text-ink-muted shrink-0 font-mono tabular-nums"
          aria-live="polite"
        >
          {elapsedSec != null ? `${elapsedSec}s elapsed` : "starting…"}
        </span>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Releases list
// ---------------------------------------------------------------------------

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
  flashing,
  onDownload,
  downloadingVersion,
  onFlash,
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
  flashing: boolean;
  onDownload: (version: string) => void;
  downloadingVersion: string | null;
  onFlash: (release: FirmwareReleaseEntry) => void;
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

        <label
          className="flex items-center gap-2 px-3 py-2 border border-hairline rounded-[6px] bg-substrate-2 focus-within:border-hairline-2 transition-colors"
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
                flashing={flashing}
                downloading={downloadingVersion === r.version}
                onDownload={() => onDownload(r.version)}
                onFlash={() => onFlash(r)}
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
  flashing,
  downloading,
  onDownload,
  onFlash,
}: {
  release: FirmwareReleaseEntry;
  installed: boolean;
  busy: boolean;
  flashing: boolean;
  downloading: boolean;
  onDownload: () => void;
  onFlash: () => void;
}) {
  return (
    <li
      className={`
        flex flex-col gap-2
        py-3 px-3 -mx-3
        border-t border-hairline first:border-t-0
        ${installed ? "bg-[color:var(--sc-foliage)]/[0.04]" : ""}
      `}
      style={
        installed
          ? { boxShadow: "inset 2px 0 0 0 var(--sc-foliage)" }
          : undefined
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
            onClick={onFlash}
            disabled={flashing}
            aria-label={`Flash ${release.version}`}
            title={
              flashing
                ? "Another flash is in progress"
                : "Download then confirm — flash writes this firmware to the device"
            }
          >
            <Zap size={12} strokeWidth={1.75} aria-hidden="true" />
            Flash
          </ActionButton>
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Manual flash card
// ---------------------------------------------------------------------------

function ManualFlashCard({
  busy,
  onFlash,
}: {
  busy: boolean;
  onFlash: (absolutePath: string) => void;
}) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Lazy initializer so SSR sees `true` (avoiding hydration mismatch
  // would also work, but we never SSR the Electron renderer) and the
  // client first paint reads the real bridge presence. Browser dev
  // mode lands as `false` → the Browse button disables with a tooltip.
  const [bridgeAvailable] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const w = window as unknown as { streamcheats?: { pickHexFile?: unknown } };
    return typeof w.streamcheats?.pickHexFile === "function";
  });

  const onBrowse = async () => {
    setError(null);
    const picked = await pickHexFile();
    if (picked) setPath(picked);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = path.trim();
    if (!trimmed) return;
    setError(null);
    onFlash(trimmed);
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
            <button
              type="button"
              onClick={() => void onBrowse()}
              disabled={!bridgeAvailable}
              title={
                bridgeAvailable
                  ? "Open OS file picker"
                  : "Native picker only available inside the StreamCheats app"
              }
              className="
                cursor-pointer sc-chrome text-[10px] text-ink-muted
                hover:text-ink transition-colors
                disabled:opacity-50 disabled:cursor-not-allowed
              "
              style={{ transitionDuration: "var(--sc-dur-quick)" }}
            >
              Browse
            </button>
          </label>
          <div className="flex justify-end">
            <ActionButton
              tone="ghost"
              type="submit"
              disabled={busy || !path.trim()}
              title="Flash file"
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

// ---------------------------------------------------------------------------
// Confirm modal
// ---------------------------------------------------------------------------

type FlashConfirmIntent =
  | {
      kind: "release";
      version: string;
      installed: string | null;
      downgrade: boolean;
    }
  | {
      kind: "manual";
      path: string;
      installed: string | null;
      downgrade: boolean;
    };

function ConfirmFlashModal({
  intent,
  loaderReady,
  loaderBusy,
  loaderError,
  onCancel,
  onConfirm,
  onEnsureLoader,
}: {
  intent: FlashConfirmIntent;
  loaderReady: boolean;
  loaderBusy: boolean;
  loaderError: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  onEnsureLoader: () => void;
}) {
  // Close on ESC. Accessibility nicety — modal traps elsewhere are
  // overkill for a confirmation overlay in our two-button case.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const isManual = intent.kind === "manual";
  const target =
    intent.kind === "release" ? intent.version : `local file`;
  const warnTone =
    isManual || intent.downgrade
      ? "text-copper"
      : "text-ink-muted";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm firmware flash"
      className="
        fixed inset-0 z-50
        flex items-center justify-center
        bg-black/60 backdrop-blur-sm
        px-5
      "
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="
          w-full max-w-[420px]
          bg-panel-2 border border-hairline-2 rounded-[10px]
          p-5 flex flex-col gap-4
          shadow-xl
        "
      >
        <div className="flex items-start gap-3">
          <AlertTriangle
            size={20}
            strokeWidth={1.75}
            aria-hidden="true"
            className={`shrink-0 ${warnTone}`}
          />
          <div className="flex flex-col gap-1 min-w-0 flex-1">
            <span className="sc-chrome text-[10px] text-copper">
              confirm firmware flash
            </span>
            <h2 className="text-ink text-[15px] font-medium">
              Flash {target}?
            </h2>
          </div>
        </div>

        <div className="flex flex-col gap-3 text-[12px] text-ink-muted leading-relaxed">
          {intent.kind === "release" ? (
            <p>
              About to write{" "}
              <span className="font-mono text-ink">{intent.version}</span>{" "}
              to your StreamCheats device.{" "}
              {intent.installed ? (
                <>
                  Current:{" "}
                  <span className="font-mono text-ink">{intent.installed}</span>
                  .
                </>
              ) : (
                <>No installed version detected (no heartbeat yet).</>
              )}
            </p>
          ) : (
            <p>
              About to flash a local{" "}
              <span className="font-mono text-ink">.hex</span> file. This is
              not from the StreamCheats release stream — downgrades and
              modified firmware are not validated and can leave your device
              in an unusable state.
            </p>
          )}

          {intent.kind === "release" && intent.downgrade ? (
            <p className="text-copper">
              This is a <strong>downgrade</strong>. Older firmware may
              behave differently — proceed only if you know why.
            </p>
          ) : null}

          {intent.kind === "manual" && intent.installed ? (
            <p>
              File:{" "}
              <span className="font-mono text-ink break-all">
                {intent.path}
              </span>
            </p>
          ) : intent.kind === "manual" ? (
            <p className="font-mono text-ink break-all">{intent.path}</p>
          ) : null}

          <p>
            Your device will be unresponsive for ~30 seconds.{" "}
            <strong>Do not unplug.</strong>
          </p>
        </div>

        {/* SC-14: when the loader isn't cached, the action button
            becomes "Download flash tool" instead of "I understand,
            flash". On error we surface the structured copy plus a
            Retry — the same button stays in place. */}
        {!loaderReady && loaderError ? (
          <div
            className="
              rounded-[6px] border border-[color:var(--sc-copper)]/40
              bg-[color:var(--sc-copper)]/[0.06]
              p-3 text-[12px] text-copper leading-relaxed
            "
            role="alert"
          >
            {loaderError}
          </div>
        ) : null}

        {!loaderReady && loaderBusy ? (
          <p
            className="sc-chrome text-[10px] text-copper"
            aria-live="polite"
          >
            Downloading flash tool…
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <ActionButton tone="ghost" onClick={onCancel} disabled={loaderBusy}>
            Cancel
          </ActionButton>
          {loaderReady ? (
            <ActionButton tone="copper" onClick={onConfirm}>
              <Zap size={12} strokeWidth={1.75} aria-hidden="true" />
              I understand, flash
            </ActionButton>
          ) : (
            <ActionButton
              tone="copper"
              onClick={onEnsureLoader}
              disabled={loaderBusy}
              title="Fetch teensy_loader_cli.exe to your AppData folder"
            >
              {loaderBusy ? (
                <Loader2
                  size={12}
                  strokeWidth={1.75}
                  aria-hidden="true"
                  className="animate-spin"
                />
              ) : (
                <Download size={12} strokeWidth={1.75} aria-hidden="true" />
              )}
              {loaderError ? "Retry download" : "Download flash tool"}
            </ActionButton>
          )}
        </div>
      </div>
    </div>
  );
}
