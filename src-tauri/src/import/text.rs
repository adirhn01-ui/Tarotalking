// Plain-text / markdown file reading (size-capped, lossy UTF-8).

use crate::error::{AppError, Result};
use std::fs;

const MAX_BYTES: u64 = 20 * 1024 * 1024;

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String> {
    // Up to 20 MB of sync I/O — keep it off the async worker threads.
    tauri::async_runtime::spawn_blocking(move || read_text_inner(&path))
        .await
        .map_err(|e| AppError::wrap("Read task", e))?
}

fn read_text_inner(path: &str) -> Result<String> {
    let meta = fs::metadata(path).map_err(|_| AppError::msg("Could not read this file"))?;
    if meta.len() > MAX_BYTES {
        return Err(AppError::msg("This file is too large to import"));
    }
    let bytes = fs::read(path).map_err(|_| AppError::msg("Could not read this file"))?;
    Ok(normalize(&bytes))
}

/// Lossy UTF-8, strip a leading BOM, normalize CRLF (and lone CR) to LF.
fn normalize(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    text.replace("\r\n", "\n").replace('\r', "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_bom_and_normalizes_newlines() {
        // UTF-8 BOM + CRLF line endings.
        let raw = b"\xEF\xBB\xBFline one\r\nline two\r\n";
        let out = normalize(raw);
        assert_eq!(out, "line one\nline two\n");
        assert!(!out.starts_with('\u{feff}'));
    }

    #[test]
    fn normalizes_lone_cr() {
        assert_eq!(normalize(b"a\rb\r\nc"), "a\nb\nc");
    }

    #[test]
    fn passes_through_plain_lf() {
        assert_eq!(normalize(b"already\nclean"), "already\nclean");
    }

    #[test]
    fn size_cap_rejects_large_files() {
        let mut p = std::env::temp_dir();
        p.push(format!("tarotalking-text-{}.bin", uuid::Uuid::new_v4()));
        // One byte over the cap.
        let big = vec![b'x'; (MAX_BYTES + 1) as usize];
        std::fs::write(&p, &big).unwrap();
        let err = read_text_inner(p.to_str().unwrap()).unwrap_err();
        assert_eq!(err.to_string(), "This file is too large to import");
        let _ = std::fs::remove_file(&p);
    }
}
