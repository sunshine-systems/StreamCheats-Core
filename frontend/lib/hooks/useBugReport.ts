"use client";

// State machine for the bug-report button:
//   idle → requesting → saved | error_logging | error_network → idle
//
// The hook owns ALL transition timing so the button stays purely
// presentational. Success dwells ~2 s on screen; errors dwell ~3 s so
// the user has time to read them before the button returns to idle.

import { useCallback, useEffect, useRef, useState } from "react";

import { requestBugReport } from "../api/bug-report";
import { BugReportError, BugReportErrorCode } from "../api/errors";

export type State =
  | "idle"
  | "requesting"
  | "saved"
  | "error_logging"
  | "error_network";

export interface UseBugReportOpts {
  onSuccess?: (savedTo: string, fellBack: boolean) => void;
  onError?: (code: BugReportErrorCode, message: string) => void;
}

export interface UseBugReport {
  state: State;
  savedTo: string | null;
  errorMessage: string | null;
  run: () => Promise<void>;
}

const SUCCESS_DWELL_MS = 2000;
const ERROR_DWELL_MS = 3000;

export function useBugReport(opts: UseBugReportOpts = {}): UseBugReport {
  const [state, setState] = useState<State>("idle");
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Stable refs for callbacks so `run` can keep a stable identity
  // without causing stale-closure bugs when the parent re-renders.
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  }, [opts]);

  // Track the dwell timer so a rapid re-click doesn't leave an orphaned
  // reset firing on top of a fresh "requesting".
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (dwellTimer.current) clearTimeout(dwellTimer.current);
    };
  }, []);

  const scheduleReset = useCallback((ms: number) => {
    if (dwellTimer.current) clearTimeout(dwellTimer.current);
    dwellTimer.current = setTimeout(() => {
      setState("idle");
      setSavedTo(null);
      setErrorMessage(null);
      dwellTimer.current = null;
    }, ms);
  }, []);

  const run = useCallback(async () => {
    // Cancel any pending reset from a previous run.
    if (dwellTimer.current) {
      clearTimeout(dwellTimer.current);
      dwellTimer.current = null;
    }
    setSavedTo(null);
    setErrorMessage(null);
    setState("requesting");

    try {
      const res = await requestBugReport();
      setSavedTo(res.savedTo);
      setState("saved");
      optsRef.current.onSuccess?.(res.savedTo, Boolean(res.fellBack));
      scheduleReset(SUCCESS_DWELL_MS);
    } catch (e) {
      let code: BugReportErrorCode = "unknown";
      let msg = "Bug report failed.";
      if (e instanceof BugReportError) {
        code = e.code;
        msg = e.message;
      } else if (e instanceof Error) {
        msg = e.message;
      }
      setErrorMessage(msg);
      setState(code === "file_logging_disabled" ? "error_logging" : "error_network");
      optsRef.current.onError?.(code, msg);
      scheduleReset(ERROR_DWELL_MS);
    }
  }, [scheduleReset]);

  return { state, savedTo, errorMessage, run };
}
