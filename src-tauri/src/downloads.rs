// Shared download helper with progress events ("download-progress").

use crate::error::{AppError, Result};
use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;

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
    let _ = (app, task_id, label, url, dest);
    Err(AppError::msg("not implemented yet"))
}
