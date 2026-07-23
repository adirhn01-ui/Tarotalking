// Plain-text / markdown file reading (size-capped, lossy UTF-8).

use crate::error::{AppError, Result};

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String> {
    let _ = path;
    Err(AppError::msg("not implemented yet"))
}
