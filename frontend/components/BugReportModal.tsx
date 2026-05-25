"use client";

// Bug-report modal triggered from the sidebar Bug icon. The visible
// content is driven by the `useBugReport` state machine
// (idle | requesting | saved | error_logging | error_network).
//
// One subtlety: `useBugReport` auto-resets back to `idle` after a
// short dwell (2s success / 3s error). For a modal we want the
// terminal state to persist until the user closes — otherwise the
// success screen would flash away mid-read. We solve this by latching
// the last meaningful state into local refs/state and rendering THAT,
// not the live hook state, once we transition out of `idle/requesting`.
//
// We deliberately do not touch the underlying hook (per the SC ticket
// the hook is shared with potential future surfaces and the dwell
// semantics make sense for inline buttons).

import { useEffect, useRef, useState } from "react";

import { useBugReport, type State } from "../lib/hooks/useBugReport";
import Modal from "./ui/Modal";

export interface BugReportModalProps {
  open: boolean;
  onClose: () => void;
}

function basename(p: string): string {
  const ix = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return ix === -1 ? p : p.slice(ix + 1);
}

// The states we want to "freeze" the modal on (the user-facing
// terminal states). Once we land on one of these, ignore subsequent
// transitions back to `idle` from the hook's dwell timer so the modal
// stays on its result screen until dismissed.
const TERMINAL: ReadonlySet<State> = new Set([
  "saved",
  "error_logging",
  "error_network",
]);

export default function BugReportModal({ open, onClose }: BugReportModalProps) {
  const { state, savedTo, errorMessage, run } = useBugReport();

  // Latched view: the most recent terminal state we observed (or
  // `state` itself when we're in idle/requesting).
  const [latched, setLatched] = useState<{
    state: State;
    savedTo: string | null;
    errorMessage: string | null;
  }>({ state: "idle", savedTo: null, errorMessage: null });

  // Stable snapshot of error message / saved path so they survive the
  // hook's auto-reset to idle.
  const lastErrorRef = useRef<string | null>(null);
  const lastSavedToRef = useRef<string | null>(null);

  useEffect(() => {
    if (errorMessage) lastErrorRef.current = errorMessage;
  }, [errorMessage]);
  useEffect(() => {
    if (savedTo) lastSavedToRef.current = savedTo;
  }, [savedTo]);

  useEffect(() => {
    if (TERMINAL.has(state)) {
      // Land on a terminal state — latch and stop tracking hook
      // resets. Subsequent useEffect runs from idle won't override.
      setLatched({
        state,
        savedTo: savedTo ?? lastSavedToRef.current,
        errorMessage: errorMessage ?? lastErrorRef.current,
      });
    } else if (state === "requesting") {
      setLatched({ state, savedTo: null, errorMessage: null });
    } else if (state === "idle" && !TERMINAL.has(latched.state)) {
      // Reset the latch only when we genuinely haven't reached a
      // terminal screen yet (i.e. first open, fresh session).
      setLatched({ state: "idle", savedTo: null, errorMessage: null });
    }
    // We INTENTIONALLY don't depend on `latched.state` here — the
    // condition above reads it, but adding it to deps would cause a
    // reset loop the moment we land on idle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, savedTo, errorMessage]);

  // Reset the latch when the modal transitions from closed -> open
  // so the user always gets a fresh idle screen on re-open.
  const prevOpen = useRef(open);
  useEffect(() => {
    if (open && !prevOpen.current) {
      setLatched({ state: "idle", savedTo: null, errorMessage: null });
      lastSavedToRef.current = null;
      lastErrorRef.current = null;
    }
    prevOpen.current = open;
  }, [open]);

  // Disable backdrop/Esc close while the bundle is actually being
  // built — bailing mid-zip is confusing and there's no abort API.
  const isRequesting = state === "requesting";
  const view = latched;

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!isRequesting}
      aria-labelledby="bug-report-modal-heading"
    >
      <style>{`
        @keyframes sc-bugmodal-spin { to { transform: rotate(360deg); } }
        .sc-bugmodal-spinner {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          border: 2px solid rgba(232, 239, 233, 0.18);
          border-top-color: var(--sc-foliage);
          animation: sc-bugmodal-spin 0.7s linear infinite;
          display: inline-block;
        }
      `}</style>

      {view.state === "idle" && (
        <IdleView
          onRun={run}
          onCancel={onClose}
        />
      )}

      {view.state === "requesting" && <RequestingView />}

      {view.state === "saved" && (
        <SavedView savedTo={view.savedTo} onClose={onClose} />
      )}

      {view.state === "error_logging" && (
        <ErrorLoggingView onClose={onClose} />
      )}

      {view.state === "error_network" && (
        <ErrorNetworkView
          message={view.errorMessage}
          onRetry={run}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}

function Heading({
  children,
  tone = "ink",
}: {
  children: React.ReactNode;
  tone?: "ink" | "foliage" | "copper" | "danger";
}) {
  const color =
    tone === "foliage"
      ? "text-foliage"
      : tone === "copper"
        ? "text-copper"
        : tone === "danger"
          ? "text-danger"
          : "text-ink";
  return (
    <h2
      id="bug-report-modal-heading"
      className={`sc-display ${color} text-[20px] leading-tight font-medium m-0`}
    >
      {children}
    </h2>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return (
    <p className="sc-chrome text-[11px] text-ink-muted m-0 leading-relaxed">
      {children}
    </p>
  );
}

function ButtonRow({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-end gap-2 mt-1">{children}</div>;
}

function PrimaryButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="
        inline-flex items-center gap-2
        px-3 py-1.5
        border rounded-[3px]
        sc-chrome text-[10px]
        text-foliage
        border-[color:var(--sc-foliage)]/50 hover:border-[color:var(--sc-foliage)]/80
        bg-[color:var(--sc-foliage)]/10 hover:bg-[color:var(--sc-foliage)]/15
        transition-colors
      "
      style={{ transitionDuration: "var(--sc-dur-quick)" }}
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="
        inline-flex items-center
        px-3 py-1.5
        border rounded-[3px]
        sc-chrome text-[10px]
        text-ink-muted hover:text-ink
        border-hairline hover:border-hairline-2
        bg-transparent
        transition-colors
      "
      style={{ transitionDuration: "var(--sc-dur-quick)" }}
    >
      {children}
    </button>
  );
}

function IdleView({
  onRun,
  onCancel,
}: {
  onRun: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Heading>Report a bug</Heading>
      <Body>
        A zip containing the last 5 minutes of logs, a snapshot of your
        config (secrets redacted), and basic system info will be saved
        to your Desktop. No personal data, no automatic send — share
        the file in Discord or on a GitHub issue when reporting.
      </Body>
      <ButtonRow>
        <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
        <PrimaryButton onClick={onRun}>Create bug report</PrimaryButton>
      </ButtonRow>
    </div>
  );
}

function RequestingView() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="sc-bugmodal-spinner" aria-hidden="true" />
        <Heading>Creating bug report…</Heading>
      </div>
      <Body>
        Bundling the last 5 minutes of logs, your config snapshot, and
        system info.
      </Body>
    </div>
  );
}

function SavedView({
  savedTo,
  onClose,
}: {
  savedTo: string | null;
  onClose: () => void;
}) {
  const filename = savedTo ? basename(savedTo) : "bug report";
  return (
    <div className="flex flex-col gap-4">
      <Heading tone="foliage">Bug report created</Heading>
      <div className="flex flex-col gap-1">
        <Body>
          Saved to your Desktop:{" "}
          <code className="sc-chrome text-ink text-[10px] bg-substrate-2 border border-hairline rounded px-1.5 py-0.5">
            {filename}
          </code>
        </Body>
        {savedTo && (
          <span
            className="sc-chrome text-[10px] text-ink-dim break-all"
            title={savedTo}
          >
            {savedTo}
          </span>
        )}
      </div>
      <ButtonRow>
        <PrimaryButton onClick={onClose}>Done</PrimaryButton>
      </ButtonRow>
    </div>
  );
}

function ErrorLoggingView({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Heading tone="copper">File logging is disabled</Heading>
      <Body>
        Enable file logging in Settings to generate a bug report. The
        bundle is built from the daemon&apos;s rolling log file, which
        isn&apos;t being written right now.
      </Body>
      <ButtonRow>
        <SecondaryButton onClick={onClose}>Close</SecondaryButton>
      </ButtonRow>
    </div>
  );
}

function ErrorNetworkView({
  message,
  onRetry,
  onClose,
}: {
  message: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Heading tone="danger">Couldn&apos;t create bug report</Heading>
      <Body>{message ?? "An unknown error occurred."}</Body>
      <ButtonRow>
        <SecondaryButton onClick={onClose}>Close</SecondaryButton>
        <PrimaryButton onClick={onRetry}>Try again</PrimaryButton>
      </ButtonRow>
    </div>
  );
}
