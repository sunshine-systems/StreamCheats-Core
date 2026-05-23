//! Download a firmware `.hex` asset to `%TEMP%\<original-filename>.hex`,
//! streaming the body to disk and computing a SHA-256 digest in one
//! pass. Mirrors [`crate::updater::download`] — the only differences
//! are the temp-file extension (`.hex.part` instead of `.exe.part`) and
//! that the canonical filename is the asset name verbatim (the firmware
//! repo's naming already encodes board + version + channel).

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

/// One progress update emitted while the download is in flight.
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
/// `progress_tx`. Returns [`Downloaded`] metadata on success.
pub async fn download_to_temp(
    client: &reqwest::Client,
    url: &str,
    filename: &str,
    progress_tx: mpsc::UnboundedSender<Progress>,
) -> Result<Downloaded> {
    if filename.is_empty() {
        return Err(anyhow!("download filename is empty"));
    }
    let temp_dir = std::env::temp_dir();
    let path = temp_dir.join(filename);

    let resp = client.get(url).send().await.context("send GET request")?;
    let status = resp.status();
    if !status.is_success() {
        return Err(anyhow!("download HTTP {}", status));
    }

    let total_bytes = resp.content_length();

    let part_path = part_path_for(&path);
    if part_path.exists() {
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
        file.write_all(&chunk)
            .await
            .context("write chunk to disk")?;
        bytes_so_far += chunk.len() as u64;
        let _ = progress_tx.send(Progress {
            bytes_so_far,
            total_bytes,
        });
    }

    file.flush().await.context("flush firmware image to disk")?;
    drop(file);

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

/// Build the `.part` path used during streaming so a crash doesn't leave
/// a half-baked `.hex` in place. Always appends `.part` to the full
/// filename (rather than replacing the extension) so the original
/// filename — including the `.hex` segment — is preserved.
fn part_path_for(final_path: &Path) -> PathBuf {
    let mut s = final_path.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_path_appends_suffix() {
        let p = part_path_for(Path::new("/tmp/streamcheats_teensy-4.1_rel-5.17.hex"));
        assert_eq!(
            p.to_string_lossy(),
            "/tmp/streamcheats_teensy-4.1_rel-5.17.hex.part"
        );
    }
}
