//! Read `config.json` from disk and return it verbatim for inclusion in
//! the bug-report zip.
//!
//! We do NOT strip any fields — the user-policy on this project is
//! that IPs and ports are user-knowable and not sensitive, so the
//! snapshot is byte-for-byte the file the user has on disk. Future
//! redaction (if ever needed) lives here.

use std::fs;
use std::path::Path;

/// Load `config.json` from the daemon's working directory. Returns the
/// raw bytes. If the file is missing we surface a synthetic placeholder
/// rather than an error — a missing config means the daemon wrote a
/// fresh default earlier and the user hasn't edited it yet, which is a
/// useful diagnostic in itself.
pub fn read_config(cwd: &Path) -> std::io::Result<Vec<u8>> {
    let p = cwd.join(crate::util::settings::CONFIG_FILENAME);
    match fs::read(&p) {
        Ok(bytes) => Ok(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(
            b"{\n  \"_note\": \"config.json was not present at bug-report time\"\n}\n"
                .to_vec(),
        ),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_existing_file_verbatim() {
        let dir = std::env::temp_dir().join(format!(
            "streamcheats_cfg_snapshot_test_{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(crate::util::settings::CONFIG_FILENAME);
        let body = b"{\"listen_addr\":\"127.0.0.1\"}\n";
        fs::File::create(&p).unwrap().write_all(body).unwrap();
        let out = read_config(&dir).unwrap();
        assert_eq!(out, body);
    }

    #[test]
    fn missing_file_produces_placeholder() {
        let dir = std::env::temp_dir().join(format!(
            "streamcheats_cfg_snapshot_missing_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let out = read_config(&dir).unwrap();
        let s = String::from_utf8_lossy(&out);
        assert!(s.contains("not present"));
    }
}
