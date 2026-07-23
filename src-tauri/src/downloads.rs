// Shared download helper with progress events ("download-progress").

use crate::error::{AppError, Result};
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub task_id: String,
    pub label: String,
    pub received: u64,
    pub total: Option<u64>,
    pub done: bool,
    pub error: Option<String>,
}

const CHUNK: usize = 64 * 1024;
const EMIT_EVERY: Duration = Duration::from_millis(300);

/// Stream `url` to `dest`, emitting "download-progress" events on `app`.
/// Writes to a .part file and renames on success so an interrupted download
/// never leaves a half-file behind.
pub fn download_with_progress(
    app: &AppHandle,
    task_id: &str,
    label: &str,
    url: &str,
    dest: &Path,
) -> Result<()> {
    let part = dest.with_extension("part");
    if let Some(parent) = dest.parent() {
        crate::paths::ensure_dir(parent)?;
    }

    let emit = |received: u64, total: Option<u64>, done: bool, error: Option<String>| {
        let _ = app.emit(
            "download-progress",
            DownloadProgress {
                task_id: task_id.to_string(),
                label: label.to_string(),
                received,
                total,
                done,
                error,
            },
        );
    };

    // 30s connect timeout, but no overall read timeout — voice models are large.
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(30))
        .build();

    let resp = match agent.get(url).call() {
        Ok(r) => r,
        Err(e) => {
            let msg = match e {
                ureq::Error::Status(code, _) => format!("Download failed (HTTP {code})"),
                _ => "Could not start the download".to_string(),
            };
            let _ = std::fs::remove_file(&part);
            emit(0, None, true, Some(msg.clone()));
            return Err(AppError::msg(msg));
        }
    };

    let total: Option<u64> = resp
        .header("Content-Length")
        .and_then(|s| s.trim().parse().ok());

    emit(0, total, false, None);

    // Stream to the .part file, throttling progress emits.
    let stream = (|| -> Result<u64> {
        let mut reader = resp.into_reader();
        let mut file = File::create(&part)?;
        let mut received: u64 = 0;
        let mut buf = vec![0u8; CHUNK];
        let mut last = Instant::now();
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|_| AppError::msg("The download was interrupted"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])?;
            received += n as u64;
            if last.elapsed() >= EMIT_EVERY {
                emit(received, total, false, None);
                last = Instant::now();
            }
        }
        file.flush()?;
        Ok(received)
    })();

    match stream {
        Ok(received) => {
            // Replace any pre-existing destination, then promote the .part file.
            if dest.exists() {
                let _ = std::fs::remove_file(dest);
            }
            if let Err(e) = std::fs::rename(&part, dest) {
                let _ = std::fs::remove_file(&part);
                let msg = "Could not save the downloaded file".to_string();
                emit(received, total, true, Some(msg));
                return Err(AppError::wrap("Download", e));
            }
            emit(received, total.or(Some(received)), true, None);
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            emit(0, total, true, Some(e.to_string()));
            Err(e)
        }
    }
}
