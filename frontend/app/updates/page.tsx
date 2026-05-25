"use client";

// Updates page — Update Center (v2 restructure).
//
// User-feedback v2:
//   1. Dropped the H1 + description + divider. The eyebrow is the only
//      chrome above the first card.
//   2. Firmware update info is suppressed until the device has reported
//      an installed version via heartbeat (same signal Home uses). Before
//      that we treat firmware state as unknown and only act on software.
//   3. The previous "one card per update type" layout was replaced by a
//      single combined "Updates available" card listing both software
//      and firmware rows. When nothing is pending we show an "up to
//      date" card with a Check button instead.
//   4. An "Install older firmware →" link is always present at the
//      bottom, regardless of update state.
//
// The Flash button on the firmware row opens the same FlashStepperModal
// used by /updates/firmware — single source of truth.

import { useCallback, useState } from "react";
import {
  CheckCircle2,
  Download,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Zap,
} from "lucide-react";

import Card from "../../components/ui/Card";
import Eyebrow from "../../components/ui/Eyebrow";
import ActionButton from "../../components/updates/ActionButton";
import ProgressBar from "../../components/updates/ProgressBar";
import StateChip, {
  type StateChipTone,
} from "../../components/updates/StateChip";
import FlashStepperModal, {
  type FlashIntent,
} from "../../components/updates/FlashStepperModal";

import { useUpdater } from "../../lib/hooks/useUpdater";
import { useFirmwareStatus } from "../../lib/hooks/useFirmwareStatus";
import {
  cancelFlash,
  flash,
} from "../../lib/api/firmware";
import { useRelativeHref } from "../../lib/route/href";

function chipForKind(
  kind: string | undefined,
  isReady = false
): {
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
      return { tone: "copper", label: isReady ? "Ready to install" : "Ready to flash" };
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
  return `${days}d ago`;
}

// Software-actionable states that justify a row in the combined card.
// `idle` and `up_to_date` are *not* actionable — the up-to-date card
// owns the empty case.
const SW_ACTIONABLE = new Set(["available", "downloading", "ready", "failed"]);
// Firmware-actionable states. Includes `flashing` so the user can
// re-open the stepper modal mid-flash after navigating away.
const FW_ACTIONABLE = new Set([
  "available",
  "downloading",
  "ready",
  "failed",
  "flashing",
]);

export default function UpdatesPage() {
  const sw = useUpdater();
  const fw = useFirmwareStatus();

  // Fix #2: firmware UI only after a heartbeat has parsed an installed
  // version. Until then `installed_version` is null and surfacing any
  // firmware state ("available", "up_to_date", …) would be misleading
  // because the daemon's check ran against an unknown installed baseline.
  const deviceSeen = fw.status?.installed_version != null;

  const swKind = sw.state?.kind;
  const fwKind = fw.status?.state.kind;
  const swActionable = swKind != null && SW_ACTIONABLE.has(swKind);
  const fwActionable =
    deviceSeen && fwKind != null && FW_ACTIONABLE.has(fwKind);
  const anyActionable = swActionable || fwActionable;

  // Stepper-modal state. The Flash button on the firmware row opens
  // the modal in step 1 (Confirm). Once the daemon transitions into
  // Flashing, the modal switches itself to the relevant phase step.
  const [intent, setIntent] = useState<FlashIntent | null>(null);
  // Re-open the modal after navigation if we're flashing AND the user
  // hasn't explicitly closed it. Separate "open" flag so the user can
  // dismiss + re-open without losing the intent.
  const [modalOpen, setModalOpen] = useState(false);

  const onOpenFlashFromAvailable = useCallback(() => {
    const latest = fw.status?.state.latest;
    if (!latest) return;
    setIntent({
      kind: "release",
      version: latest,
      installed: fw.status?.installed_version ?? null,
      downgrade: false,
    });
    setModalOpen(true);
  }, [fw.status]);

  const onFlashConfirm = useCallback(async () => {
    if (!intent || intent.kind !== "release") {
      return { ok: false as const, reason: "unknown" as const };
    }
    const r = await flash(intent.version);
    await fw.refresh();
    return r;
  }, [intent, fw]);

  const onFlashCancel = useCallback(async () => {
    await cancelFlash();
    await fw.refresh();
  }, [fw]);

  const onRetry = useCallback(() => {
    setModalOpen(true);
  }, []);

  // Check button on the empty-state card runs both checkers in parallel.
  // We always call the software check; the firmware check is only useful
  // when a device has been seen.
  const onCheckBoth = useCallback(() => {
    void sw.runCheck();
    if (deviceSeen) void fw.runCheck();
  }, [sw, fw, deviceSeen]);

  return (
    <div className="px-5 sm:px-8 py-8 flex flex-col gap-6">
      <Eyebrow>system · update center</Eyebrow>

      {anyActionable ? (
        <UpdatesAvailableCard
          swActionable={swActionable}
          fwActionable={fwActionable}
          sw={sw}
          fw={fw}
          onOpenFlashFromAvailable={onOpenFlashFromAvailable}
          onReopenModal={() => setModalOpen(true)}
        />
      ) : (
        <UpToDateCard
          fw={fw}
          sw={sw}
          deviceSeen={deviceSeen}
          onCheck={onCheckBoth}
        />
      )}

      <InstallOlderFirmwareLink />

      {intent ? (
        <FlashStepperModal
          intent={intent}
          status={fw.status}
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onRetry={onRetry}
          onConfirm={onFlashConfirm}
          // Pass onDownload so the modal can chain
          // download → flash if the user opens it from this page on a
          // not-yet-Ready release. Today the Update Center only opens
          // the modal from the `ready` row but threading this keeps
          // the two entry points behaviourally identical.
          onDownload={(v) => fw.runDownload(v)}
          onCancel={onFlashCancel}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Combined "Updates available" card — single container, one row per
// update type. Rows share visual rhythm so software + firmware feel
// like part of the same pending-work queue, not two separate features.
// ---------------------------------------------------------------------------

function UpdatesAvailableCard({
  swActionable,
  fwActionable,
  sw,
  fw,
  onOpenFlashFromAvailable,
  onReopenModal,
}: {
  swActionable: boolean;
  fwActionable: boolean;
  sw: ReturnType<typeof useUpdater>;
  fw: ReturnType<typeof useFirmwareStatus>;
  onOpenFlashFromAvailable: () => void;
  onReopenModal: () => void;
}) {
  return (
    <section aria-label="Updates available" className="flex flex-col gap-3">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <Eyebrow tone="copper">updates available</Eyebrow>
      </header>
      <Card aria-label="Updates available" static>
        <ul className="flex flex-col">
          {swActionable && sw.state ? (
            <SoftwareRow
              state={sw.state}
              busy={sw.busy}
              onCheck={() => void sw.runCheck()}
              onDownload={() => void sw.runDownload()}
              onInstall={() => void sw.runInstall()}
            />
          ) : null}
          {fwActionable && fw.status ? (
            <FirmwareRow
              status={fw.status}
              busy={fw.busy}
              onCheck={() => void fw.runCheck()}
              onDownload={(v) => void fw.runDownload(v)}
              onFlash={onOpenFlashFromAvailable}
              onReopenModal={onReopenModal}
            />
          ) : null}
        </ul>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Per-type rows. Each row lives inside the combined card.
// ---------------------------------------------------------------------------

function UpdateRowFrame({
  typeLabel,
  installed,
  latest,
  channel,
  kindChip,
  actions,
  body,
  first,
}: {
  typeLabel: string;
  installed: string;
  latest?: string | null;
  channel?: string | null;
  kindChip: { tone: StateChipTone; label: string } | null;
  actions: React.ReactNode;
  body?: React.ReactNode;
  first: boolean;
}) {
  return (
    <li
      className={`flex flex-col gap-2 py-3 ${
        first ? "" : "border-t border-hairline"
      }`}
    >
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="sc-chrome text-[10px] text-ink-dim">
              {typeLabel}
            </span>
            {kindChip ? (
              <StateChip tone={kindChip.tone}>{kindChip.label}</StateChip>
            ) : null}
          </div>
          <span className="font-mono text-ink text-[16px] leading-tight mt-1 break-all">
            {installed}
          </span>
          {latest ? (
            <span className="sc-chrome text-[10px] text-copper mt-1">
              latest · {latest}
              {channel ? ` · ${channel}` : ""}
            </span>
          ) : null}
        </div>
        <div className="flex flex-col items-stretch gap-2 shrink-0">
          {actions}
        </div>
      </div>
      {body}
    </li>
  );
}

function SoftwareRow({
  state,
  busy,
  onCheck,
  onDownload,
  onInstall,
  first = true,
}: {
  state: NonNullable<ReturnType<typeof useUpdater>["state"]>;
  busy: boolean;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
  first?: boolean;
}) {
  const kind = state.kind;
  // Hide the redundant "Ready to install" chip when the Install button
  // is already obviously the next step. Other states still surface the
  // chip since it adds information the action alone doesn't convey.
  const chip = kind === "ready" ? null : chipForKind(kind, true);
  const installed = `v${state.installed ?? "—"}`;
  const showLatest = kind === "available" || kind === "ready";
  const actions = (
    <>
      {kind === "available" ? (
        <ActionButton tone="foliage" onClick={onDownload} disabled={busy}>
          <Download size={12} strokeWidth={1.75} aria-hidden="true" />
          Download
        </ActionButton>
      ) : null}
      {kind === "ready" ? (
        <ActionButton tone="copper" onClick={onInstall} disabled={busy}>
          <Sparkles size={12} strokeWidth={1.75} aria-hidden="true" />
          Install &amp; restart
        </ActionButton>
      ) : null}
      {kind === "failed" ? (
        <ActionButton tone="ghost" onClick={onCheck} disabled={busy}>
          <RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" />
          Try again
        </ActionButton>
      ) : null}
    </>
  );
  const body = (
    <>
      {kind === "downloading" ? (
        <div className="mt-1">
          <ProgressBar
            percent={state.percent ?? null}
            bytesSoFar={state.bytes_so_far}
            totalBytes={state.total_bytes ?? null}
            label={`Downloading v${state.latest ?? "—"}`}
          />
        </div>
      ) : null}
      {kind === "available" && state.notes_url ? (
        <p className="text-[12px] text-ink-dim">
          <a
            href={state.notes_url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-foliage underline decoration-[color:var(--sc-foliage)]/40 underline-offset-2 hover:decoration-[color:var(--sc-foliage)]"
          >
            View release notes →
          </a>
        </p>
      ) : null}
      {kind === "failed" ? (
        <p
          className="text-[12px] text-danger font-mono break-all"
          role="alert"
        >
          {state.error ?? "Unknown error."}
        </p>
      ) : null}
    </>
  );
  return (
    <UpdateRowFrame
      typeLabel="software"
      installed={installed}
      latest={showLatest ? `v${state.latest}` : null}
      channel={showLatest ? state.channel : null}
      kindChip={chip}
      actions={actions}
      body={body}
      first={first}
    />
  );
}

function FirmwareRow({
  status,
  busy,
  onCheck,
  onDownload,
  onFlash,
  onReopenModal,
  first = false,
}: {
  status: NonNullable<ReturnType<typeof useFirmwareStatus>["status"]>;
  busy: boolean;
  onCheck: () => void;
  onDownload: (version: string) => void;
  onFlash: () => void;
  onReopenModal: () => void;
  first?: boolean;
}) {
  const state = status.state;
  const kind = state.kind;
  const chip = chipForKind(kind, false);
  const installed = status.installed_version ?? "—";
  const flashing = kind === "flashing";
  const showLatest = kind === "available" || kind === "ready";
  const latestStr = flashing
    ? state.version ?? null
    : showLatest
      ? state.latest
      : null;
  const channelStr = showLatest ? state.channel : flashing ? "flashing" : null;
  const actions = (
    <>
      {kind === "available" ? (
        <ActionButton
          tone="foliage"
          onClick={() => state.latest && onDownload(state.latest)}
          disabled={busy}
        >
          <Download size={12} strokeWidth={1.75} aria-hidden="true" />
          Download
        </ActionButton>
      ) : null}
      {kind === "ready" ? (
        <ActionButton tone="copper" onClick={onFlash} disabled={busy}>
          <Zap size={12} strokeWidth={1.75} aria-hidden="true" />
          Flash
        </ActionButton>
      ) : null}
      {flashing ? (
        <ActionButton tone="copper" onClick={onReopenModal}>
          <Zap size={12} strokeWidth={1.75} aria-hidden="true" />
          View progress
        </ActionButton>
      ) : null}
      {kind === "failed" ? (
        <ActionButton tone="ghost" onClick={onCheck} disabled={busy}>
          <RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" />
          Try again
        </ActionButton>
      ) : null}
    </>
  );
  const body = (
    <>
      {kind === "downloading" ? (
        <div className="mt-1">
          <ProgressBar
            percent={state.percent ?? null}
            bytesSoFar={state.bytes_so_far}
            totalBytes={state.total_bytes ?? null}
            label={`Downloading ${state.latest ?? ""}`}
          />
        </div>
      ) : null}
      {kind === "available" && state.notes_url ? (
        <p className="text-[12px] text-ink-dim">
          <a
            href={state.notes_url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-foliage underline decoration-[color:var(--sc-foliage)]/40 underline-offset-2 hover:decoration-[color:var(--sc-foliage)]"
          >
            View release notes →
          </a>
        </p>
      ) : null}
      {kind === "failed" ? (
        <p
          className="text-[12px] text-danger font-mono break-all"
          role="alert"
        >
          {state.error ?? "Unknown error."}
        </p>
      ) : null}
    </>
  );
  return (
    <UpdateRowFrame
      typeLabel="firmware"
      installed={installed}
      latest={latestStr}
      channel={channelStr}
      kindChip={chip}
      actions={actions}
      body={body}
      first={first}
    />
  );
}

// ---------------------------------------------------------------------------
// Up-to-date card — replaces both the empty state and the per-type
// "up to date" rendering in one tidy muted card.
// ---------------------------------------------------------------------------

function UpToDateCard({
  fw,
  sw,
  deviceSeen,
  onCheck,
}: {
  fw: ReturnType<typeof useFirmwareStatus>;
  sw: ReturnType<typeof useUpdater>;
  deviceSeen: boolean;
  onCheck: () => void;
}) {
  // Pick the most recent checked_at between software and (when relevant)
  // firmware. When no device has been seen we only ever consider the
  // software timestamp — firmware state may be present in the API
  // response but we don't surface it on this page, so it shouldn't drive
  // "last checked" either.
  const swCheck =
    sw.state?.kind === "up_to_date" ? sw.state.checked_at : undefined;
  const fwCheck =
    deviceSeen && fw.status?.state.kind === "up_to_date"
      ? fw.status.state.checked_at
      : undefined;
  const lastChecked = pickLatestIso(swCheck, fwCheck);

  return (
    <Card aria-label="Up to date" static>
      <div className="flex flex-col items-center text-center gap-4 py-8 sm:py-10 px-4">
        <CheckCircle2
          size={56}
          strokeWidth={1.5}
          aria-hidden="true"
          className="text-foliage"
        />
        <h2 className="sc-display text-ink font-medium leading-[1.1] text-2xl sm:text-3xl">
          You&apos;re up to date
        </h2>
        <p className="sc-chrome text-[11px] text-ink-dim">
          Last checked {relativeTime(lastChecked)}
        </p>
        <ActionButton
          tone="ghost"
          onClick={onCheck}
          disabled={sw.busy || fw.busy}
        >
          <RefreshCw size={12} strokeWidth={1.75} aria-hidden="true" />
          Check again
        </ActionButton>
      </div>
    </Card>
  );
}

function pickLatestIso(
  a: string | undefined,
  b: string | undefined
): string | null {
  const av = a ? new Date(a).getTime() : NaN;
  const bv = b ? new Date(b).getTime() : NaN;
  const aValid = Number.isFinite(av);
  const bValid = Number.isFinite(bv);
  if (aValid && bValid) return av >= bv ? (a ?? null) : (b ?? null);
  if (aValid) return a ?? null;
  if (bValid) return b ?? null;
  return null;
}

// ---------------------------------------------------------------------------
// Install older firmware link — persistent, hairline, full-width chrome.
// ---------------------------------------------------------------------------

function InstallOlderFirmwareLink() {
  const href = useRelativeHref("/updates/firmware");
  return (
    <a
      href={href}
      className="
        group inline-flex items-center justify-between gap-3 w-full
        px-4 py-3
        rounded-[6px] border border-hairline
        bg-transparent
        sc-chrome text-[11px] text-ink-muted
        hover:text-ink hover:border-hairline-2
        transition-colors
      "
      style={{ transitionDuration: "var(--sc-dur-quick)" }}
    >
      <span>install older firmware</span>
      <span
        aria-hidden="true"
        className="text-foliage text-[12px] group-hover:translate-x-0.5 transition-transform"
        style={{ transitionDuration: "var(--sc-dur-quick)" }}
      >
        →
      </span>
    </a>
  );
}
