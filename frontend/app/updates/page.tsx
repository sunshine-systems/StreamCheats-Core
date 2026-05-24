"use client";

// Updates page — Update Center (Updates restructure).
//
// Replaces the previous SC-9 unified page. Now focused exclusively on
// "you have newer versions available". The full release archive +
// manual .hex picker moved to /updates/firmware.
//
// Layout:
//   - Header (eyebrow + H1)
//   - Software update card  — only when software state is actionable
//   - Firmware update card  — only when firmware state is actionable,
//                             including `flashing` (so the user can
//                             re-open the stepper modal mid-flash)
//   - Empty state           — "You're up to date." + last-checked +
//                             a single Check button, when both hooks
//                             report idle/up_to_date
//   - Secondary action      — link to /updates/firmware
//
// The Flash button on the firmware card opens the same
// FlashStepperModal as the firmware sub-page — single source of truth.

import { useCallback, useState } from "react";
import { Download, RefreshCw, RotateCcw, Sparkles, Zap } from "lucide-react";

import PageHeader from "../../components/ui/PageHeader";
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

// Software-actionable states that justify rendering the card. We
// intentionally drop `idle` and `up_to_date` — the empty state takes
// over for "nothing to act on".
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

  const swKind = sw.state?.kind;
  const fwKind = fw.status?.state.kind;
  const swActionable = swKind != null && SW_ACTIONABLE.has(swKind);
  const fwActionable = fwKind != null && FW_ACTIONABLE.has(fwKind);
  const empty = !swActionable && !fwActionable;

  // Stepper-modal state. The Flash button on the firmware card opens
  // the modal in step 1 (Confirm). Once the daemon transitions into
  // Flashing, the modal switches itself to the relevant phase step.
  const [intent, setIntent] = useState<FlashIntent | null>(null);
  // Re-open the modal after navigation if we're flashing AND the user
  // hasn't explicitly closed it. We use a separate "open" flag so the
  // user can dismiss + re-open without losing the intent.
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
    // Tighten polling immediately so the modal flips to the flashing
    // step on the next tick.
    await fw.refresh();
    return r;
  }, [intent, fw]);

  const onFlashCancel = useCallback(async () => {
    await cancelFlash();
    await fw.refresh();
  }, [fw]);

  const onRetry = useCallback(() => {
    // Re-open in confirm step. The daemon's state must be back to
    // ready/available for the flash dispatch to succeed.
    setModalOpen(true);
  }, []);

  return (
    <div className="px-5 sm:px-8 py-8 flex flex-col gap-8">
      <PageHeader
        eyebrow="system · update center"
        title="Update Center"
        sub="Newer versions available for your app and your StreamCheats device firmware."
      />

      {swActionable && sw.state ? (
        <SoftwareUpdateCard
          state={sw.state}
          busy={sw.busy}
          onCheck={() => void sw.runCheck()}
          onDownload={() => void sw.runDownload()}
          onInstall={() => void sw.runInstall()}
        />
      ) : null}

      {fwActionable && fw.status ? (
        <FirmwareUpdateCard
          status={fw.status}
          busy={fw.busy}
          onCheck={() => void fw.runCheck()}
          onDownload={(v) => void fw.runDownload(v)}
          onFlash={onOpenFlashFromAvailable}
          onReopenModal={() => setModalOpen(true)}
        />
      ) : null}

      {empty ? <EmptyState fw={fw} sw={sw} /> : null}

      <div aria-hidden="true" className="sc-hairline" />

      <InstallOlderFirmwareLink />

      {intent ? (
        <FlashStepperModal
          intent={intent}
          status={fw.status}
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onRetry={onRetry}
          onConfirm={onFlashConfirm}
          onCancel={onFlashCancel}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Software update card
// ---------------------------------------------------------------------------

function SoftwareUpdateCard({
  state,
  busy,
  onCheck,
  onDownload,
  onInstall,
}: {
  state: NonNullable<ReturnType<typeof useUpdater>["state"]>;
  busy: boolean;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}) {
  const kind = state.kind;
  const chip = chipForKind(kind, true);
  const installed = state.installed ?? "—";
  return (
    <section
      aria-label="Software update"
      className="flex flex-col gap-3"
    >
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <Eyebrow>software</Eyebrow>
        <StateChip tone={chip.tone}>{chip.label}</StateChip>
      </header>
      <Card aria-label="Software update status" static>
        <div className="flex items-start gap-4 flex-wrap">
          <div className="flex flex-col min-w-0 flex-1">
            <span className="sc-chrome text-[10px] text-ink-dim">
              installed
            </span>
            <span className="font-mono text-ink text-[20px] leading-tight mt-1 break-all">
              v{installed}
            </span>
            {kind === "available" || kind === "ready" ? (
              <span className="sc-chrome text-[10px] text-copper mt-2">
                latest · v{state.latest} · {state.channel}
              </span>
            ) : null}
          </div>

          <div className="flex flex-col items-stretch gap-2 shrink-0">
            {kind === "available" ? (
              <ActionButton
                tone="foliage"
                onClick={onDownload}
                disabled={busy}
              >
                <Download size={12} strokeWidth={1.75} aria-hidden="true" />
                Download
              </ActionButton>
            ) : null}
            {kind === "ready" ? (
              <ActionButton
                tone="copper"
                onClick={onInstall}
                disabled={busy}
              >
                <Sparkles size={12} strokeWidth={1.75} aria-hidden="true" />
                Install &amp; restart
              </ActionButton>
            ) : null}
            {kind === "failed" ? (
              <ActionButton
                tone="ghost"
                onClick={onCheck}
                disabled={busy}
              >
                <RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" />
                Try again
              </ActionButton>
            ) : null}
          </div>
        </div>

        {kind === "downloading" ? (
          <div className="mt-4">
            <ProgressBar
              percent={state.percent ?? null}
              bytesSoFar={state.bytes_so_far}
              totalBytes={state.total_bytes ?? null}
              label={`Downloading v${state.latest ?? "—"}`}
            />
          </div>
        ) : null}

        {kind === "available" && state.notes_url ? (
          <p className="mt-3 text-[12px] text-ink-dim">
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
            className="mt-3 text-[12px] text-danger font-mono break-all"
            role="alert"
          >
            {state.error ?? "Unknown error."}
          </p>
        ) : null}
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Firmware update card
// ---------------------------------------------------------------------------

function FirmwareUpdateCard({
  status,
  busy,
  onCheck,
  onDownload,
  onFlash,
  onReopenModal,
}: {
  status: NonNullable<ReturnType<typeof useFirmwareStatus>["status"]>;
  busy: boolean;
  onCheck: () => void;
  onDownload: (version: string) => void;
  onFlash: () => void;
  onReopenModal: () => void;
}) {
  const state = status.state;
  const kind = state.kind;
  const chip = chipForKind(kind, false);
  const installed = status.installed_version ?? "—";
  const flashing = kind === "flashing";

  return (
    <section
      aria-label="Firmware update"
      className="flex flex-col gap-3"
    >
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <Eyebrow>firmware</Eyebrow>
        <StateChip tone={chip.tone}>{chip.label}</StateChip>
      </header>
      <Card aria-label="Firmware update status" static>
        <div className="flex items-start gap-4 flex-wrap">
          <div className="flex flex-col min-w-0 flex-1">
            <span className="sc-chrome text-[10px] text-ink-dim">
              installed
            </span>
            <span className="font-mono text-ink text-[20px] leading-tight mt-1 break-all">
              {installed}
            </span>
            {kind === "available" || kind === "ready" ? (
              <span className="sc-chrome text-[10px] text-copper mt-2">
                latest · {state.latest} · {state.channel}
              </span>
            ) : null}
            {flashing ? (
              <span className="sc-chrome text-[10px] text-copper mt-2">
                flashing · {state.version ?? state.latest ?? "—"}
              </span>
            ) : null}
          </div>

          <div className="flex flex-col items-stretch gap-2 shrink-0">
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
              <ActionButton
                tone="ghost"
                onClick={onCheck}
                disabled={busy}
              >
                <RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" />
                Try again
              </ActionButton>
            ) : null}
          </div>
        </div>

        {kind === "downloading" ? (
          <div className="mt-4">
            <ProgressBar
              percent={state.percent ?? null}
              bytesSoFar={state.bytes_so_far}
              totalBytes={state.total_bytes ?? null}
              label={`Downloading ${state.latest ?? ""}`}
            />
          </div>
        ) : null}

        {kind === "available" && state.notes_url ? (
          <p className="mt-3 text-[12px] text-ink-dim">
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
            className="mt-3 text-[12px] text-danger font-mono break-all"
            role="alert"
          >
            {state.error ?? "Unknown error."}
          </p>
        ) : null}
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({
  fw,
  sw,
}: {
  fw: ReturnType<typeof useFirmwareStatus>;
  sw: ReturnType<typeof useUpdater>;
}) {
  // Pick the most recent checked_at between the two — that's the most
  // accurate "last checked anything" timestamp for the user.
  const swCheck =
    sw.state?.kind === "up_to_date" ? sw.state.checked_at : undefined;
  const fwCheck =
    fw.status?.state.kind === "up_to_date"
      ? fw.status.state.checked_at
      : undefined;
  const lastChecked = pickLatestIso(swCheck, fwCheck);

  const onCheck = () => {
    void sw.runCheck();
    void fw.runCheck();
  };

  return (
    <Card aria-label="No updates available" static>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <span className="text-[14px] text-ink leading-snug">
            You&apos;re up to date.
          </span>
          <span className="sc-chrome text-[10px] text-ink-dim">
            last checked · {relativeTime(lastChecked)}
          </span>
        </div>
        <ActionButton
          tone="ghost"
          onClick={onCheck}
          disabled={sw.busy || fw.busy}
        >
          <RefreshCw size={12} strokeWidth={1.75} aria-hidden="true" />
          Check for updates
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
// Install older firmware link
// ---------------------------------------------------------------------------

function InstallOlderFirmwareLink() {
  const href = useRelativeHref("/updates/firmware");
  return (
    <a
      href={href}
      className="
        group inline-flex items-center justify-between gap-3
        px-4 py-3 -mx-1
        rounded-[8px] border border-hairline
        bg-substrate-2
        text-ink-muted hover:text-ink hover:border-hairline-2
        transition-colors
      "
      style={{ transitionDuration: "var(--sc-dur-quick)" }}
    >
      <div className="flex flex-col">
        <span className="text-[13px]">Install older firmware</span>
        <span className="sc-chrome text-[10px] text-ink-dim mt-0.5">
          full release archive · manual .hex picker · downgrades
        </span>
      </div>
      <span
        aria-hidden="true"
        className="text-foliage text-[14px] group-hover:translate-x-0.5 transition-transform"
        style={{ transitionDuration: "var(--sc-dur-quick)" }}
      >
        →
      </span>
    </a>
  );
}
