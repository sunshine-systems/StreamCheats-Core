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
// Pre-flight loader check (SC-14): on step 1, if status.loader_ready
// is false, the Flash button is swapped for a Download-flash-tool
// button that POSTs /api/firmware/ensure_loader. On success we refresh
// status and flip back to the normal Flash button.

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  RotateCcw,
  Zap,
} from "lucide-react";

import type {
  EnsureLoaderResult,
  FirmwareStatusResponse,
  FlashResult,
} from "../../lib/api/firmware";
import ActionButton from "./ActionButton";

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
   */
  onConfirm: () => Promise<FlashResult>;
  /** Cancel the in-flight flash (POSTs /api/firmware/cancel_flash). */
  onCancel: () => Promise<void>;
  /** SC-14: pre-flight loader download. */
  onEnsureLoader: () => Promise<EnsureLoaderResult>;
}

export default function FlashStepperModal({
  intent,
  status,
  open,
  onClose,
  onRetry,
  onConfirm,
  onCancel,
  onEnsureLoader,
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
          onClose={onClose}
          onRetry={onRetry}
          onConfirm={onConfirm}
          onCancel={onCancel}
          onEnsureLoader={onEnsureLoader}
        />
      </div>
    </div>
  );
}

function StepBody(props: {
  intent: FlashIntent;
  status: FirmwareStatusResponse | null;
  onClose: () => void;
  onRetry: () => void;
  onConfirm: () => Promise<FlashResult>;
  onCancel: () => Promise<void>;
  onEnsureLoader: () => Promise<EnsureLoaderResult>;
}) {
  const { status } = props;
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
  if (kind === "failed") {
    return (
      <FailedStep
        state={state}
        onRetry={props.onRetry}
        onClose={props.onClose}
      />
    );
  }
  // up_to_date is ambiguous: it's the resting state AND the
  // post-success state. The parent passes a "just-flashed" hint via a
  // separate prop in the future if we want a celebratory toast — for
  // now, if the user got here AND the page is showing up_to_date, the
  // most useful behaviour is to show success copy.
  if (kind === "up_to_date") {
    return <DoneStep onClose={props.onClose} />;
  }
  // Default: confirm step.
  return (
    <ConfirmStep
      intent={props.intent}
      status={props.status}
      onClose={props.onClose}
      onConfirm={props.onConfirm}
      onEnsureLoader={props.onEnsureLoader}
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
  onEnsureLoader,
}: {
  intent: FlashIntent;
  status: FirmwareStatusResponse | null;
  onClose: () => void;
  onConfirm: () => Promise<FlashResult>;
  onEnsureLoader: () => Promise<EnsureLoaderResult>;
}) {
  const loaderReady = status?.loader_ready ?? true;
  const [loaderBusy, setLoaderBusy] = useState(false);
  const [loaderError, setLoaderError] = useState<string | null>(null);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);

  const isManual = intent.kind === "manual";
  const showWarning = isManual || intent.downgrade;
  const title =
    intent.kind === "release"
      ? `Flash ${intent.version}?`
      : `Flash local file?`;

  const doConfirm = async () => {
    setDispatchError(null);
    setDispatching(true);
    try {
      const r = await onConfirm();
      if (!r.ok) {
        setDispatchError(flashErrorCopy(r));
      }
    } finally {
      setDispatching(false);
    }
  };

  const doEnsureLoader = async () => {
    setLoaderError(null);
    setLoaderBusy(true);
    try {
      const r = await onEnsureLoader();
      if (!r.ready) {
        setLoaderError(r.message || "Couldn't fetch the flash tool.");
      }
    } finally {
      setLoaderBusy(false);
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
        <p className="sc-chrome text-[10px] text-copper" aria-live="polite">
          Downloading flash tool…
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <ActionButton tone="ghost" onClick={onClose} disabled={loaderBusy || dispatching}>
          Cancel
        </ActionButton>
        {loaderReady ? (
          <ActionButton
            tone="copper"
            onClick={() => void doConfirm()}
            disabled={dispatching}
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
        ) : (
          <ActionButton
            tone="copper"
            onClick={() => void doEnsureLoader()}
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
      return "Flash tool isn't ready — download it first.";
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
