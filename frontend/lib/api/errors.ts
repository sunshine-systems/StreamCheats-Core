// Typed error class for bug-report failures. The `code` field is what
// the UI switches on to decide which toast to show — keep the values
// in sync with the Electron preload bridge and the Rust handler.

export type BugReportErrorCode =
  | "file_logging_disabled"
  | "http_port_unavailable"
  | "network"
  | "timeout"
  | "unknown";

export class BugReportError extends Error {
  readonly code: BugReportErrorCode;
  readonly detail?: string;

  constructor(code: BugReportErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "BugReportError";
    this.code = code;
    this.detail = detail;
  }
}
