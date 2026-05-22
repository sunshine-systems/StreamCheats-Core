//! Error type for the bug-report service.
//!
//! Distinct from `anyhow::Error` because the HTTP layer needs to map
//! [`BugReportError::FileLoggingDisabled`] to a 400 with a structured
//! body, while every other variant collapses to a generic 500.

use std::fmt;

/// All ways the bug-report bundle builder can fail.
#[derive(Debug)]
pub enum BugReportError {
    /// `Settings.enable_file_logging` is `false`. The HTTP handler
    /// turns this into a 400 + `{"error":"file_logging_disabled"}`.
    FileLoggingDisabled,
    /// Something underneath us blew up on the filesystem (couldn't
    /// read the log dir, couldn't read config.json, etc).
    IoError(std::io::Error),
    /// The in-memory zip writer rejected an entry.
    ZipError(zip::result::ZipError),
}

impl fmt::Display for BugReportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FileLoggingDisabled => write!(
                f,
                "file logging is disabled — enable it in config.json to use bug reports"
            ),
            Self::IoError(e) => write!(f, "bug report I/O error: {}", e),
            Self::ZipError(e) => write!(f, "bug report zip error: {}", e),
        }
    }
}

impl std::error::Error for BugReportError {}

impl From<std::io::Error> for BugReportError {
    fn from(e: std::io::Error) -> Self {
        Self::IoError(e)
    }
}

impl From<zip::result::ZipError> for BugReportError {
    fn from(e: zip::result::ZipError) -> Self {
        Self::ZipError(e)
    }
}
