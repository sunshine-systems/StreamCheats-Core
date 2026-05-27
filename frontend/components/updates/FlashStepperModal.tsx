"use client";

// Stepper modal for the firmware flash flow (Updates restructure).
//
// Replaces the single-page Confirm modal that shipped in SC-13. The
// flash UX is now a five-step flow keyed off the daemon's phase tracker:
//
//   1. Confirm           — pre-flash; user clicks Flash to dispatch
//   2. WaitingForDevice  — "press the white button on your Teensy"
//                          + 60s countdown (matches daemon's
//                          wait_for_device timeout) + Cancel
//   3. Programming       — "Flashing... do not unplug". No cancel.
//   4. Booting           — "Almost done... restarting the device."
//   5. Done / Failed     — terminal: green check + Close, or copper
//                          error card + Try again + Close.
//
// Background nav is intentional: closing this modal does NOT cancel
// the flash. The user can browse to other pages while flashing
// continues; the AppShell sidebar's flash indicator (Updates icon
// turns copper) lets them get back to it.
//
// Loader pre-flight: the daemon resolves a bundled
// `teensy_loader_cli.exe` set via STREAMCHEATS_TEENSY_LOADER_PATH by
// the Electron shell. With a correct install `status.loader_ready` is
// always true; if it ever isn't, the confirm step renders a clear
// "Flash tool missing — please reinstall" error and disables the
// flash button instead of trying to fetch anything.

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  RotateCcw,
  Zap,
} from "lucide-react";

import type {
  FirmwareStatusResponse,
  FlashResult,
} from "../../lib/api/firmware";
import ActionButton from "./ActionButton";
import ProgressBar from "./ProgressBar";

// Mirror the daemon's WAIT_FOR_DEVICE_TIMEOUT in seconds. Kept in
// lockstep with `backend/src/firmware/flash.rs::WAIT_FOR_DEVICE_TIMEOUT`.
const WAIT_FOR_DEVICE_SECONDS = 60;

export type FlashIntent =
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

export interface FlashStepperModalProps {
  intent: FlashIntent;
  status: FirmwareStatusResponse | null;
  /** Modal is open. Parent owns this — `onClose` closes WITHOUT cancel. */
  open: boolean;
  /** Close modal. Does NOT cancel a flash; the user can navigate away. */
  onClose: () => void;
  /** Re-open from step 1 — "Try again" after a Failed terminal step. */
  onRetry: () => void;
  /**
   * Dispatch flash. Returns the typed FlashResult so the modal can
   * surface dispatch-time errors (loader_unavailable etc.) without a
   * round-trip to status.
   *
   * For release intents the modal will FIRST kick off a download via
   * `onDownload` when the daemon doesn't already have a `Ready` hex
   * for the target version, and only call `onConfirm` once the state
   * machine transitions into `Ready` for that version. For manual
   * intents (local .hex file) there's no download step — the modal
   * calls `onConfirm` directly.
   */
  onConfirm: () => Promise<FlashResult>;
  /**
   * Start a download for the target release version. Only invoked
   * for release intents whose hex isn't already `Ready` on the
   * daemon. Returns `{ ok: true }` when the daemon accepted the
   * download, or `{ ok: false, error }` otherwise — the modal
   * surfaces the error inline in the Confirm step. Not required for
   * manual intents.
   */
  onDownload?: (version: string) => Promise<{ ok: boolean; error?: string } | null>;
  /** Cancel the in-flight flash (POSTs /api/firmware/cancel_flash). */
  onCancel: () => Promise<void>;
}

export default function FlashStepperModal({
  intent,
  status,
  open,
  onClose,
  onRetry,
  onConfirm,
  onDownload,
  onCancel,
}: FlashStepperModalProps) {
  // Close on ESC. Accessibility nicety. We do NOT cancel the flash on
  // ESC — closing the modal mid-flash is an intentional "navigate away"
  // gesture, not an abort.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Track when we've kicked off a download → flash chain so the
  // post-download auto-flash only fires for THIS user gesture. Without
  // this guard the modal would auto-flash any time the daemon happened
  // to be in `ready` for the intent's version (e.g. user re-opens the
  // modal on a release that's already downloaded — we want them to
  // explicitly confirm).
  const awaitingReadyForFlashRef = useRef(false);
  const kind = status?.state.kind;
  const stateLatest = status?.state.latest;

  // Track whether THIS attempt observed a `Flashing` transition. The
  // daemon's resting state after a successful flash is `UpToDate` —
  // and that's *also* the resting state with no flash ever attempted.
  // Routing DoneStep purely off `kind === "up_to_date"` (the previous
  // behaviour) pinned the modal to "Flash complete." forever: opening
  // a fresh Confirm modal on any release after a successful flash
  // would land on Done instead. We only show Done when we've actually
  // *observed* this attempt going through `Flashing`.
  //
  // The parent mounts a fresh FlashStepperModal per attempt (via a
  // `key` prop bumped on every Flash click in the /updates/firmware
  // page), so this state always starts fresh for every attempt — no
  // need for intent-change reset bookkeeping inside the component.
  // We don't need to trigger a re-render on the false→true latch
  // transition: status polling (which already triggers re-renders via
  // the parent's useFirmwareStatus hook) will re-render us within a
  // second, and the latch will be read on that render. Using a ref
  // here would trip the `react-hooks/refs` lint rule (refs aren't
  // allowed during render); using state + setState-in-effect trips
  // `react-hooks/set-state-in-effect`. useReducer with a dispatch
  // from an effect threads the needle.
  const [sawFlashing, latchFlashing] = useReducer(
    (prev: boolean) => prev || true,
    false
  );
  useEffect(() => {
    if (kind === "flashing") latchFlashing();
  }, [kind]);
  // Auto-advance: when we've started a download for this version and
  // the daemon flips to `Ready { latest: <version> }`, fire the flash
  // automatically. The modal's step routing will then switch into the
  // flashing screens as soon as the next status poll lands.
  useEffect(() => {
    if (!awaitingReadyForFlashRef.current) return;
    if (intent.kind !== "release") return;
    if (kind !== "ready") return;
    // Daemon's Ready state surfaces the version under `latest` (see
    // FirmwareState in api/firmware.ts).
    if (stateLatest !== intent.version) return;
    awaitingReadyForFlashRef.current = false;
    void onConfirm();
  }, [kind, stateLatest, intent, onConfirm]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Firmware flash"
      className="
        fixed inset-0 z-50
        flex items-center justify-center
        bg-black/60 backdrop-blur-sm
        px-5
      "
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="
          w-full max-w-[440px]
          bg-panel-2 border border-hairline-2 rounded-[10px]
          p-5 flex flex-col gap-4
          shadow-xl
        "
      >
        <StepBody
          intent={intent}
          status={status}
          sawFlashing={sawFlashing}
          onClose={onClose}
          onRetry={onRetry}
          onConfirm={onConfirm}
          onDownload={onDownload}
          onCancel={onCancel}
          markAwaitingReady={() => {
            awaitingReadyForFlashRef.current = true;
          }}
          clearAwaitingReady={() => {
            awaitingReadyForFlashRef.current = false;
          }}
        />
      </div>
    </div>
  );
}

function StepBody(props: {
  intent: FlashIntent;
  status: FirmwareStatusResponse | null;
  /**
   * True once the parent observed `kind === "flashing"` during the
   * current attempt. Disambiguates "post-flash UpToDate (Done)" from
   * "resting UpToDate (fresh open after a previous flash succeeded)".
   * Without this, opening the modal on any release after a successful
   * flash would render DoneStep instead of Confirm.
   */
  sawFlashing: boolean;
  onClose: () => void;
  onRetry: () => void;
  onConfirm: () => Promise<FlashResult>;
  onDownload?: (version: string) => Promise<{ ok: boolean; error?: string } | null>;
  onCancel: () => Promise<void>;
  markAwaitingReady: () => void;
  clearAwaitingReady: () => void;
}) {
  const { status, intent } = props;
  const state = status?.state;
  const kind = state?.kind;
  const phase = state?.phase;

  // Step routing. We derive purely from the daemon state — the modal
  // is stateless w.r.t. step beyond "the user hit confirm/retry once".
  // - kind == "flashing" + phase: route on phase
  // - kind == "up_to_date" and we just transitioned out of flashing:
  //   that's the success terminal — but we let the parent track the
  //   "just-flashed" hint via passed-in confirmInProgress state.
  // - kind == "failed": terminal failure
  // - everything else (idle, available, ready): step 1 (confirm)
  if (kind === "flashing") {
    if (phase === "programming") {
      return <ProgrammingStep state={state} />;
    }
    if (phase === "booting") {
      return <BootingStep state={state} />;
    }
    // Starting + WaitingForDevice both show the wait screen — the
    // very first poll after dispatch may still be Starting; treat it
    // as "we're about to wait" so the user sees the button-press copy
    // immediately rather than a confusing intermediate state.
    return <WaitingForDeviceStep state={state} onCancel={props.onCancel} />;
  }
  // Downloading is only a step in the chained download → flash flow
  // (release intents). The post-Ready auto-flash effect in the parent
  // owns the transition into the flashing screens; this step just
  // shows progress in the meantime.
  if (
    kind === "downloading" &&
    intent.kind === "release" &&
    (state?.latest === intent.version || state?.latest == null)
  ) {
    return <DownloadingStep state={state} />;
  }
  if (kind === "failed") {
    // A download failure during the chained flow surfaces here too —
    // clear the "we were waiting for ready" flag so a subsequent
    // retry doesn't auto-flash on a stale Ready transition.
    props.clearAwaitingReady();
    return (
      <FailedStep
        state={state}
        onRetry={props.onRetry}
        onClose={props.onClose}
      />
    );
  }
  // up_to_date is ambiguous: it's the resting state AND the
  // post-success state. Only treat it as terminal Done when the
  // parent observed `kind === "flashing"` during this attempt — that
  // way a fresh open on a release row after a previous successful
  // flash lands on the Confirm step, not a stuck Done step.
  if (kind === "up_to_date" && props.sawFlashing) {
    return <DoneStep onClose={props.onClose} />;
  }
  // Default: confirm step.
  return (
    <ConfirmStep
      intent={props.intent}
      status={props.status}
      onClose={props.onClose}
      onConfirm={props.onConfirm}
      onDownload={props.onDownload}
      markAwaitingReady={props.markAwaitingReady}
    />
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Confirm
// ---------------------------------------------------------------------------

function ConfirmStep({
  intent,
  status,
  onClose,
  onConfirm,
  onDownload,
  markAwaitingReady,
}: {
  intent: FlashIntent;
  status: FirmwareStatusResponse | null;
  onClose: () => void;
  onConfirm: () => Promise<FlashResult>;
  onDownload?: (version: string) => Promise<{ ok: boolean; error?: string } | null>;
  markAwaitingReady: () => void;
}) {
  const loaderReady = status?.loader_ready ?? true;
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);

  const isManual = intent.kind === "manual";
  const showWarning = isManual || intent.downgrade;
  const title =
    intent.kind === "release"
      ? `Flash ${intent.version}?`
      : `Flash local file?`;

  // True iff the daemon already has the target hex on disk for this
  // release intent. Manual intents skip the download check entirely —
  // they go straight to flashLocal via onConfirm.
  const readyForIntent =
    intent.kind === "release" &&
    status?.state.kind === "ready" &&
    status.state.latest === intent.version;

  const doConfirm = async () => {
    setDispatchError(null);
    setDispatching(true);
    try {
      // Manual file or already-Ready hex: flash directly. This is the
      // pre-existing path and the contract `onConfirm` was designed for.
      if (intent.kind === "manual" || readyForIntent) {
        const r = await onConfirm();
        if (!r.ok) {
          setDispatchError(flashErrorCopy(r));
        }
        return;
      }
      // Release intent without a Ready hex: kick off the download
      // and arm the parent's auto-flash effect. The Downloading step
      // takes over the modal until the daemon flips to Ready, at
      // which point the parent fires onConfirm automatically.
      if (!onDownload) {
        setDispatchError(
          "Download isn't wired in this view — open this flash from /updates/firmware."
        );
        return;
      }
      markAwaitingReady();
      const r = await onDownload(intent.version);
      if (r && !r.ok) {
        setDispatchError(r.error ?? "Download failed.");
      }
      // On success the daemon transitions to Downloading on the next
      // status poll and StepBody routes us to the DownloadingStep.
    } finally {
      setDispatching(false);
    }
  };

  return (
    <>
      <div className="flex items-start gap-3">
        <AlertTriangle
          size={20}
          strokeWidth={1.75}
          aria-hidden="true"
          className={`shrink-0 ${showWarning ? "text-copper" : "text-ink-muted"}`}
        />
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <span className="sc-chrome text-[10px] text-copper">
            confirm firmware flash
          </span>
          <h2 className="text-ink text-[15px] font-medium">{title}</h2>
        </div>
      </div>

      <div className="flex flex-col gap-3 text-[12px] text-ink-muted leading-relaxed">
        {intent.kind === "release" ? (
          <p>
            About to write{" "}
            <span className="font-mono text-ink">{intent.version}</span> to your
            StreamCheats device.{" "}
            {intent.installed ? (
              <>
                Current:{" "}
                <span className="font-mono text-ink">{intent.installed}</span>.
              </>
            ) : (
              <>No installed version detected (no heartbeat yet).</>
            )}
          </p>
        ) : (
          <p>
            About to flash a local{" "}
            <span className="font-mono text-ink">.hex</span> file. This is not
            from the StreamCheats release stream — downgrades and modified
            firmware are not validated and can leave your device in an
            unusable state.
          </p>
        )}

        {intent.kind === "release" && intent.downgrade ? (
          <p className="text-copper">
            This is a <strong>downgrade</strong>. Older firmware may behave
            differently — proceed only if you know why.
          </p>
        ) : null}

        {intent.kind === "manual" ? (
          <p className="font-mono text-ink break-all text-[11px]">
            {intent.path}
          </p>
        ) : null}

        <p>
          You&apos;ll be asked to press the white button on your Teensy.
          Once flashing starts, <strong>do not unplug.</strong>
        </p>
      </div>

      {dispatchError ? (
        <div
          className="
            rounded-[6px] border border-[color:var(--sc-danger)]/40
            bg-[color:var(--sc-danger)]/[0.06]
            p-3 text-[12px] text-danger leading-relaxed
          "
          role="alert"
        >
          {dispatchError}
        </div>
      ) : null}

      {!loaderReady ? (
        <div
          className="
            rounded-[6px] border border-[color:var(--sc-copper)]/40
            bg-[color:var(--sc-copper)]/[0.06]
            p-3 text-[12px] text-copper leading-relaxed
          "
          role="alert"
        >
          Flash tool is missing — please reinstall StreamCheats Core.
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <ActionButton tone="ghost" onClick={onClose} disabled={dispatching}>
          Cancel
        </ActionButton>
        <ActionButton
          tone="copper"
          onClick={() => void doConfirm()}
          disabled={dispatching || !loaderReady}
        >
          {dispatching ? (
            <Loader2
              size={12}
              strokeWidth={1.75}
              aria-hidden="true"
              className="animate-spin"
            />
          ) : (
            <Zap size={12} strokeWidth={1.75} aria-hidden="true" />
          )}
          Flash
        </ActionButton>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 1b — Downloading (chained download → flash flow)
//
// Only reached for release intents whose hex isn't already cached on
// the daemon. The parent watches for the daemon transitioning into
// `Ready { latest: <our version> }` and fires the flash automatically;
// this step is purely informational while that's in flight.
// ---------------------------------------------------------------------------

function DownloadingStep({
  state,
}: {
  state:
    | {
        latest?: string;
        bytes_so_far?: number;
        total_bytes?: number | null;
        percent?: number | null;
      }
    | undefined;
}) {
  return (
    <>
      <div className="flex items-start gap-3">
        <Loader2
          size={20}
          strokeWidth={1.75}
          aria-hidden="true"
          className="shrink-0 text-foliage animate-spin"
        />
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <span className="sc-chrome text-[10px] text-foliage">
            downloading
          </span>
          <h2 className="text-ink text-[18px] font-medium leading-snug">
            Downloading firmware…
          </h2>
        </div>
      </div>
      <p className="text-[12px] text-ink-muted leading-relaxed">
        Fetching{" "}
        <span className="font-mono text-ink">{state?.latest ?? "…"}</span>{" "}
        from the release stream. Flashing starts automatically once the
        download finishes.
      </p>
      <ProgressBar
        percent={state?.percent ?? null}
        bytesSoFar={state?.bytes_so_far}
        totalBytes={state?.total_bytes ?? null}
        label={`Downloading ${state?.latest ?? ""}`}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Waiting for device
// ---------------------------------------------------------------------------

function WaitingForDeviceStep({
  state,
  onCancel,
}: {
  state: { started_at?: string } | undefined;
  onCancel: () => Promise<void>;
}) {
  // Compute remaining seconds against the daemon's start time so the
  // countdown matches the daemon's actual wait window. Ticks every
  // 500ms which is fast enough for a fluid display without burning CPU.
  const startedAt = state?.started_at;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const remaining = useMemo(() => {
    if (!startedAt) return WAIT_FOR_DEVICE_SECONDS;
    const t = new Date(startedAt).getTime();
    if (Number.isNaN(t)) return WAIT_FOR_DEVICE_SECONDS;
    const elapsed = Math.floor((now - t) / 1000);
    return Math.max(0, WAIT_FOR_DEVICE_SECONDS - elapsed);
  }, [startedAt, now]);

  const [cancelling, setCancelling] = useState(false);
  const doCancel = async () => {
    setCancelling(true);
    try {
      await onCancel();
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <div className="flex items-start gap-3">
        <Loader2
          size={20}
          strokeWidth={1.75}
          aria-hidden="true"
          className="shrink-0 text-copper animate-spin"
        />
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <span className="sc-chrome text-[10px] text-copper">
            waiting for device
          </span>
          <h2 className="text-ink text-[18px] font-medium leading-snug">
            Press the white button on your Teensy
          </h2>
        </div>
      </div>

      <p className="text-[12px] text-ink-muted leading-relaxed">
        We&apos;ll detect it and start flashing automatically.
      </p>

      <div className="flex items-center justify-between gap-3">
        <span
          aria-live="polite"
          className="
            sc-chrome text-[10px] text-copper
            px-2.5 py-1
            border border-[color:var(--sc-copper)]/40 rounded-[3px]
            font-mono tabular-nums
          "
        >
          Waiting… {remaining}s remaining
        </span>
        <ActionButton tone="ghost" onClick={() => void doCancel()} disabled={cancelling}>
          Cancel
        </ActionButton>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Programming
// ---------------------------------------------------------------------------

function ProgrammingStep({
  state,
}: {
  state: { log_tail?: string[] } | undefined;
}) {
  return (
    <>
      <div className="flex items-start gap-3">
        <Loader2
          size={20}
          strokeWidth={1.75}
          aria-hidden="true"
          className="shrink-0 text-foliage animate-spin"
        />
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <span className="sc-chrome text-[10px] text-foliage">
            programming
          </span>
          <h2 className="text-ink text-[18px] font-medium leading-snug">
            Flashing…
          </h2>
        </div>
      </div>

      <p className="text-[12px] text-ink-muted leading-relaxed">
        <strong>Do not unplug your device.</strong> This usually takes only a
        second or two.
      </p>

      <LogTail lines={state?.log_tail} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Booting
// ---------------------------------------------------------------------------

function BootingStep({
  state,
}: {
  state: { log_tail?: string[] } | undefined;
}) {
  return (
    <>
      <div className="flex items-start gap-3">
        <Loader2
          size={20}
          strokeWidth={1.75}
          aria-hidden="true"
          className="shrink-0 text-foliage animate-spin"
        />
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <span className="sc-chrome text-[10px] text-foliage">booting</span>
          <h2 className="text-ink text-[18px] font-medium leading-snug">
            Almost done…
          </h2>
        </div>
      </div>

      <p className="text-[12px] text-ink-muted leading-relaxed">
        Restarting the device.
      </p>

      <LogTail lines={state?.log_tail} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 5a — Done
// ---------------------------------------------------------------------------

function DoneStep({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="flex items-start gap-3">
        <Check
          size={20}
          strokeWidth={2}
          aria-hidden="true"
          className="shrink-0 text-foliage"
        />
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <span className="sc-chrome text-[10px] text-foliage">done</span>
          <h2 className="text-ink text-[18px] font-medium leading-snug">
            Flash complete.
          </h2>
        </div>
      </div>
      <p className="text-[12px] text-ink-muted leading-relaxed">
        Your device should be back online shortly.
      </p>
      <div className="flex items-center justify-end">
        <ActionButton tone="foliage" onClick={onClose}>
          Close
        </ActionButton>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 5b — Failed
// ---------------------------------------------------------------------------

function FailedStep({
  state,
  onRetry,
  onClose,
}: {
  state: { error?: string } | undefined;
  onRetry: () => void;
  onClose: () => void;
}) {
  const code = state?.error ?? "unknown error";
  const friendly = friendlyFailureCopy(code);

  return (
    <>
      <div className="flex items-start gap-3">
        <AlertTriangle
          size={20}
          strokeWidth={1.75}
          aria-hidden="true"
          className="shrink-0 text-copper"
        />
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <span className="sc-chrome text-[10px] text-copper">
            flash failed
          </span>
          <h2 className="text-ink text-[15px] font-medium leading-snug">
            {friendly.title}
          </h2>
        </div>
      </div>

      <div
        className="
          rounded-[6px] border border-[color:var(--sc-copper)]/40
          bg-[color:var(--sc-copper)]/[0.06]
          p-3 text-[12px] text-copper leading-relaxed
        "
        role="alert"
      >
        {friendly.body}
        {friendly.showRaw ? (
          <pre className="mt-2 font-mono text-[10px] text-ink-dim whitespace-pre-wrap break-all">
            {code}
          </pre>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-2">
        <ActionButton tone="ghost" onClick={onClose}>
          Close
        </ActionButton>
        <ActionButton tone="copper" onClick={onRetry}>
          <RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" />
          Try again
        </ActionButton>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function LogTail({ lines }: { lines: string[] | undefined }) {
  if (!lines || lines.length === 0) return null;
  // Show the last ~6 lines so the modal doesn't grow tall. The daemon
  // already caps at LOG_TAIL_CAP (~20); we trim further client-side
  // for visual density.
  const tail = lines.slice(-6);
  return (
    <pre
      aria-label="Loader output"
      className="
        rounded-[6px] border border-hairline
        bg-substrate-2
        p-3
        font-mono text-[10px] text-ink-dim
        leading-snug
        whitespace-pre-wrap break-all
        max-h-32 overflow-auto
      "
    >
      {tail.join("\n")}
    </pre>
  );
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
      return "Flash tool is missing — please reinstall StreamCheats Core.";
    case "not_implemented":
      return "Flash endpoint isn't wired in this daemon build.";
    case "network":
      return "Couldn't reach the daemon. Is StreamCheats running?";
    default:
      return result.detail ?? "Flash failed.";
  }
}

// Map daemon error codes onto friendly copy. Anything we don't
// recognise falls through with a generic title + the raw code shown
// for debugging.
function friendlyFailureCopy(code: string): {
  title: string;
  body: string;
  showRaw: boolean;
} {
  if (code === "user_cancelled") {
    return {
      title: "Flash cancelled.",
      body: "You cancelled the flash before it completed.",
      showRaw: false,
    };
  }
  if (code === "wait_for_device_timeout") {
    return {
      title: "Didn't see a button press.",
      body: "We waited 60 seconds for you to press the white button on your Teensy. Plug it in, press the button when prompted, and try again.",
      showRaw: false,
    };
  }
  return {
    title: "Flash failed.",
    body: "The loader exited with an error. Details below — try again, or check the Logs page for the full output.",
    showRaw: true,
  };
}
