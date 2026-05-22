//! Download an installer asset to `%TEMP%\StreamCheats Core Setup
//! <version>.exe`, streaming the body to disk and computing a SHA-256
//! digest in one pass. Progress is reported back to the orchestrator
//! via a tokio mpsc sender so the UI can render a live percentage.

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

/// One progress update emitted while the download is in flight.
/// `total_bytes` is `None` when the server didn't advertise a
/// Content-Length (rare for GitHub releases but possible behind some
/// CDNs).
#[derive(Debug, Clone)]
pub struct Progress {
    pub bytes_so_far: u64,
    pub total_bytes: Option<u64>,
}

/// Result of a completed download.
#[derive(Debug, Clone)]
pub struct Downloaded {
    pub path: PathBuf,
    pub sha256_hex: String,
    pub size: u64,
}

/// Stream `url` to `%TEMP%\<filename>` while publishing [`Progress`] on
/// `progress_tx`. Returns the [`Downloaded`] metadata on success or an
/// error string suitable for surfacing to the UI.
pub async fn download_to_temp(
    client: &reqwest::Client,
    url: &str,
    filename: &str,
    progress_tx: mpsc::UnboundedSender<Progress>,
) -> Result<Downloaded> {
    let temp_dir = std::env::temp_dir();
    let path = temp_dir.join(filename);

    let resp = client.get(url).send().await.context("send GET request")?;
    let status = resp.status();
    if !status.is_success() {
        return Err(anyhow!("download HTTP {}", status));
    }

    let total_bytes = resp.content_length();

    // Write to a sibling `.part` file first so a crashed download
    // doesn't leave a half-baked installer named like the real one.
    let part_path = path.with_extension("exe.part");
    if part_path.exists() {
        // Best-effort cleanup of a previous incomplete attempt.
        let _ = tokio::fs::remove_file(&part_path).await;
    }
    let mut file = tokio::fs::File::create(&part_path)
        .await
        .with_context(|| format!("create {}", part_path.display()))?;

    let mut hasher = Sha256::new();
    let mut bytes_so_far: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("read response chunk")?;
        hasher.update(&chunk);
        file.write_all(&chunk).await.context("write chunk to disk")?;
        bytes_so_far += chunk.len() as u64;
        // Best-effort: if the UI receiver has been dropped (state moved
        // on) just keep streaming — the file still needs to land.
        let _ = progress_tx.send(Progress {
            bytes_so_far,
            total_bytes,
        });
    }

    file.flush().await.context("flush installer to disk")?;
    drop(file);

    // Promote `.exe.part` → `.exe` only after the body is fully on disk
    // and flushed. Rename is atomic on Windows when source and dest live
    // on the same volume (always true here — both under %TEMP%).
    if path.exists() {
        let _ = tokio::fs::remove_file(&path).await;
    }
    tokio::fs::rename(&part_path, &path)
        .await
        .with_context(|| format!("rename {} to {}", part_path.display(), path.display()))?;

    let digest = hasher.finalize();
    let sha256_hex = digest.iter().map(|b| format!("{:02x}", b)).collect();

    Ok(Downloaded {
        path,
        sha256_hex,
        size: bytes_so_far,
    })
}

/// Build the canonical filename for an installer of a given version.
/// Mirrors what the release pipeline names its uploaded asset so users
/// see a consistent name whether the file came from the website or the
/// in-app updater.
pub fn installer_filename(version: &str) -> String {
    format!("StreamCheats Core Setup {}.exe", version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_format_matches_release_pipeline() {
        assert_eq!(
            installer_filename("0.6.3"),
            "StreamCheats Core Setup 0.6.3.exe"
        );
        assert_eq!(
            installer_filename("0.7.0-nightly.20260522"),
            "StreamCheats Core Setup 0.7.0-nightly.20260522.exe"
        );
    }
}
