"use client";

// /updates/firmware — full firmware archive + manual .hex picker.
//
// Split out of the previous SC-9 unified Updates page in the Updates
// restructure. Hosts the parts that don't belong on a focused
// "Update Center" landing:
//
//   1. All releases — searchable / filterable release list. Each row
//      has a Flash button that opens the stepper modal.
//   2. Flash local .hex file — Electron picker + Flash file button.
//      Same stepper modal.
//
// Both flash actions go through the same FlashStepperModal as the
// Update Center's firmware card, so the daemon-side phase tracking +
// cancel + retry behaviour is identical regardless of where the user
// kicks off the flash.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { RotateCcw, Search, Upload, Zap } from "lucide-react";

import PageHeader from "../../../components/ui/PageHeader";
import Card from "../../../components/ui/Card";
import Eyebrow from "../../../components/ui/Eyebrow";
import ActionButton from "../../../components/updates/ActionButton";
import ProgressBar from "../../../components/updates/ProgressBar";
import StateChip, {
  type StateChipTone,
} from "../../../components/updates/StateChip";
import FlashStepperModal, {
  type FlashIntent,
} from "../../../components/updates/FlashStepperModal";

import { useFirmwareReleases } from "../../../lib/hooks/useFirmwareReleases";
import { useFirmwareStatus } from "../../../lib/hooks/useFirmwareStatus";
import { useUpdater } from "../../../lib/hooks/useUpdater";
import {
  cancelFlash,
  flash,
  flashLocal,
  pickHexFile,
  type FirmwareReleaseEntry,
} from "../../../lib/api/firmware";
import { useRelativeHref } from "../../../lib/route/href";

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
  return `${Math.round(months / 12)}y ago`;
}

function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KiB`;
  return `${(kb / 1024).toFixed(2)} MiB`;
}

// Parse "rel-5.17" / "rel-5.17-ca8298b" → { major, minor }.
function parseRelMajorMinor(
  version: string | null | undefined
): { major: number; minor: number } | null {
  if (!version) return null;
  const stripped = version.replace(/^rel-/, "");
  const base = stripped.split("-")[0];
  const [maj, min] = base.split(".").map((n) => Number.parseInt(n, 10));
  if (Number.isNaN(maj) || Number.isNaN(min)) return null;
  return { major: maj, minor: min };
}

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

export default function InstallFirmwarePage() {
  const { status, busy, runCheck, runDownload, refresh } = useFirmwareStatus();
  const { releases, loaded: releasesLoaded, refresh: refreshReleases } =
    useFirmwareReleases();
  const { experimental } = useUpdater();

  // Bug fix: first-visit empty releases.
  //
  // The daemon's release poller staggers 8s after boot before the
  // first GitHub fetch (firmware/mod.rs::spawn_poller), and the
  // CHECK_INTERVAL is 1 hour. A user who opens /updates/firmware
  // during that 8s window — or before the first poll has ever
  // completed — gets an empty `/api/firmware/releases` and renders
  // the "no releases" empty state. Backing out and re-entering used
  // to "fix" it because the poller had populated the cache in the
  // meantime.
  //
  // Kick an explicit /api/firmware/check on mount when the releases
  // load resolves empty. `check_once` performs the GitHub fetch
  // synchronously and populates the releases cache before returning,
  // so the follow-up refreshReleases() will see the populated list.
  // We only do this once per mount to avoid a hot loop when the
  // daemon genuinely has no releases (offline / repo misconfigured).
  const autoCheckedRef = useRef(false);
  useEffect(() => {
    if (autoCheckedRef.current) return;
    if (!releasesLoaded) return;
    if (releases.length > 0) return;
    autoCheckedRef.current = true;
    void (async () => {
      await runCheck();
      await refreshReleases();
    })();
  }, [releasesLoaded, releases.length, runCheck, refreshReleases]);

  const state = status?.state;
  const kind = state?.kind;
  const installedVersion = status?.installed_version ?? null;
  const installedChannel = status?.channel ?? "unknown";
  const board = status?.board ?? null;
  const chip = chipForKind(kind);
  const flashing = kind === "flashing";
  // Heartbeat-derived: until the daemon parses an installed version
  // from a device heartbeat, the firmware-update state is moot.
  // Mirror the gating used by the Update Center page so the user sees
  // a coherent story across both views. The releases list + manual
  // .hex picker still render unconditionally — browsing + flashing
  // historical firmware is the whole point of this page, device or no.
  const deviceSeen = installedVersion != null;

  const backHref = useRelativeHref("/updates");

  // Stepper modal state.
  //
  // `attemptKey` bumps on every Flash button click so the modal
  // remounts with fresh state per attempt. Without this, the modal's
  // `sawFlashing` latch would survive across clicks and a fresh
  // confirm-modal opened after a previous flash succeeded would
  // render the previous DoneStep instead of a Confirm step (Bug 2).
  // Combined with clearing `intent` on close, this gives every flash
  // attempt an independent state machine inside the modal.
  const [intent, setIntent] = useState<FlashIntent | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [attemptKey, setAttemptKey] = useState(0);
  const openFlashIntent = useCallback((next: FlashIntent) => {
    setIntent(next);
    setModalOpen(true);
    setAttemptKey((k) => k + 1);
  }, []);

  const onConfirm = useCallback(async () => {
    if (!intent) return { ok: false as const, reason: "unknown" as const };
    const r =
      intent.kind === "release"
        ? await flash(intent.version)
        : await flashLocal(intent.path);
    await refresh();
    return r;
  }, [intent, refresh]);

  const onCancelFlash = useCallback(async () => {
    await cancelFlash();
    await refresh();
  }, [refresh]);

  const onCheck = async () => {
    await runCheck();
    await refreshReleases();
  };

  // Filter + search state.
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
    <div className="px-5 sm:px-8 py-8 flex flex-col gap-8">
      <PageHeader
        eyebrow="system · firmware archive"
        title="Install firmware"
        sub={
          <a
            href={backHref}
            className="inline-flex items-center gap-1 text-foliage hover:underline"
          >
            ← Update center
          </a>
        }
      />

      {deviceSeen ? (
        <section
          aria-label="Installed firmware"
          className="flex flex-col gap-3"
        >
          <header className="flex items-center justify-between gap-3 flex-wrap">
            <Eyebrow>device</Eyebrow>
            <StateChip tone={chip.tone}>{chip.label}</StateChip>
          </header>
          <Card aria-label="Installed firmware" static>
            <div className="flex items-start gap-4 flex-wrap">
              <div className="flex flex-col min-w-0 flex-1">
                <span className="sc-chrome text-[10px] text-ink-dim">
                  installed
                </span>
                <span className="font-mono text-ink text-[18px] leading-tight mt-1 break-all">
                  {installedVersion ?? "—"}
                </span>
                <span className="sc-chrome text-[10px] text-ink-dim mt-2">
                  {board ? `board · ${board}` : "board · —"}
                  {installedChannel !== "unknown"
                    ? ` · channel · ${installedChannel}`
                    : null}
                </span>
              </div>
              <ActionButton
                tone="ghost"
                onClick={() => void onCheck()}
                disabled={busy || flashing}
              >
                <RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" />
                Check now
              </ActionButton>
            </div>

            {kind === "downloading" ? (
              <div className="mt-4">
                <ProgressBar
                  percent={state?.percent ?? null}
                  bytesSoFar={state?.bytes_so_far}
                  totalBytes={state?.total_bytes ?? null}
                  label={`Downloading ${state?.latest ?? ""}`}
                />
              </div>
            ) : null}

            {flashing ? (
              <div className="mt-4 flex items-center justify-between gap-3">
                <span className="sc-chrome text-[10px] text-copper">
                  flashing · {state?.version ?? state?.latest ?? "—"}
                </span>
                <ActionButton
                  tone="copper"
                  onClick={() => setModalOpen(true)}
                >
                  <Zap size={12} strokeWidth={1.75} aria-hidden="true" />
                  View progress
                </ActionButton>
              </div>
            ) : null}
          </Card>
        </section>
      ) : (
        // Muted note — keeps the visual rhythm of the page consistent
        // when no device has been seen, without surfacing "update
        // available" or an installed-version of "—" that would imply
        // we know something we don't.
        <p className="sc-chrome text-[10px] text-ink-dim">
          Connect your StreamCheats device to see installed firmware.
        </p>
      )}

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
        flashing={flashing}
        onFlash={(release) =>
          openFlashIntent({
            kind: "release",
            version: release.version,
            installed: installedVersion,
            downgrade: isDowngrade(installedVersion, release.version),
          })
        }
      />

      <ManualFlashCard
        busy={flashing}
        onFlash={(path) =>
          openFlashIntent({
            kind: "manual",
            path,
            installed: installedVersion,
            downgrade: false,
          })
        }
      />

      {intent ? (
        <FlashStepperModal
          key={attemptKey}
          intent={intent}
          status={status}
          open={modalOpen}
          onClose={() => {
            // Closing the modal after a terminal state (Done /
            // Failed) should leave the parent in a clean slate so
            // the next Flash click rebuilds the intent from scratch
            // and the modal mounts with fresh refs. Without this,
            // the stale intent + the modal's latched `sawFlashing`
            // ref could shape the next open's first paint. Clearing
            // on every close is fine — re-opening always goes
            // through a Flash button click that resets the intent.
            setModalOpen(false);
            setIntent(null);
          }}
          onRetry={() => setModalOpen(true)}
          onConfirm={onConfirm}
          onDownload={(v) => runDownload(v)}
          onCancel={onCancelFlash}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Releases list (ported from the old SC-9 FirmwareUpdatesSection)
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
  flashing,
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
  flashing: boolean;
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
                flashing={flashing}
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
  flashing,
  onFlash,
}: {
  release: FirmwareReleaseEntry;
  installed: boolean;
  flashing: boolean;
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
          {/*
            Single Flash button — the stepper modal chains
            download → flash automatically when the daemon doesn't
            already have a Ready hex for this version. Splitting
            those into two buttons forced the user to think about
            cache state that's purely the daemon's concern.
          */}
          <ActionButton
            tone="ghost"
            onClick={onFlash}
            disabled={flashing}
            aria-label={`Flash ${release.version}`}
            title={
              flashing
                ? "Another flash is in progress"
                : "Confirm in the next step — flash downloads (if needed) and writes this firmware to the device"
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
  // Lazy initializer matches the SC-13 pattern in the previous
  // FirmwareUpdatesSection: SSR sees `false`, client first paint reads
  // the real bridge presence. Avoids the `set-state-in-effect` lint
  // rule and the corresponding cascading render.
  const [bridgeAvailable] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const w = window as unknown as { streamcheats?: { pickHexFile?: unknown } };
    return typeof w.streamcheats?.pickHexFile === "function";
  });

  const onBrowse = async () => {
    const picked = await pickHexFile();
    if (picked) setPath(picked);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = path.trim();
    if (!trimmed) return;
    onFlash(trimmed);
  };

  return (
    <Card aria-label="Manual firmware flash" static>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Eyebrow tone="muted">flash local .hex file</Eyebrow>
          <span className="sc-chrome text-[10px] text-ink-dim">.hex</span>
        </div>
        <p className="text-[12px] text-ink-muted leading-relaxed">
          Flash any local <span className="font-mono text-ink">.hex</span>{" "}
          file, including older firmware. Useful for downgrading or for
          custom builds.
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
      </div>
    </Card>
  );
}
