// Typed bug-report request. Resolves with the saved-to path on
// success; throws a `BugReportError` with a discriminated `code` on
// every failure mode so the UI can pick the right toast.

import { fallbackBugReport, getBridge } from "./client";
import { BugReportError } from "./errors";

export interface BugReportResult {
  savedTo: string;
  fellBack?: boolean;
}

export async function requestBugReport(): Promise<BugReportResult> {
  const bridge = getBridge();
  const result = bridge
    ? await bridge.bugReport()
    : await fallbackBugReport();

  if (result.ok) {
    return { savedTo: result.savedTo, fellBack: result.fellBack };
  }

  switch (result.error) {
    case "file_logging_disabled":
      throw new BugReportError(
        "file_logging_disabled",
        "Enable file logging in config.json to use bug reports."
      );
    case "http_port_unavailable":
      throw new BugReportError(
        "http_port_unavailable",
        "Couldn't reach backend. Is the daemon running?",
        result.detail
      );
    case "network":
      throw new BugReportError(
        "network",
        "Couldn't reach backend. Is the daemon running?",
        result.detail
      );
    case "timeout":
      throw new BugReportError(
        "timeout",
        "Bug report request timed out.",
        result.detail
      );
    case "unknown":
    default:
      throw new BugReportError(
        "unknown",
        "Bug report failed.",
        result.detail
      );
  }
}
