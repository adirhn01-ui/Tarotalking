// Library persistence: opaque index JSON + per-item content dirs.
// Signatures are frozen (registered in lib.rs).

use crate::error::{AppError, Result};
use crate::paths;
use serde_json::Value;

#[tauri::command]
pub fn library_load() -> Result<Option<Value>> {
    let _ = paths::library_index_path();
    Err(AppError::msg("not implemented yet"))
}

#[tauri::command]
pub fn library_save(index: Value) -> Result<()> {
    let _ = index;
    Err(AppError::msg("not implemented yet"))
}

#[tauri::command]
pub fn item_write_doc(id: String, doc: Value) -> Result<()> {
    let _ = (id, doc);
    Err(AppError::msg("not implemented yet"))
}

#[tauri::command]
pub fn item_read_doc(id: String) -> Result<Value> {
    let _ = id;
    Err(AppError::msg("not implemented yet"))
}

#[tauri::command]
pub fn item_delete(id: String) -> Result<()> {
    let _ = id;
    Err(AppError::msg("not implemented yet"))
}
