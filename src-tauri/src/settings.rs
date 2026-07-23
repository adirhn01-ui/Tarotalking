// Settings persistence — stored as opaque JSON (the frontend owns the schema
// and sanitizes on read), so adding a settings field needs no Rust change.

use crate::error::Result;
use crate::paths;
use serde_json::Value;
use std::fs;

#[tauri::command]
pub fn settings_load() -> Result<Option<Value>> {
    let path = paths::settings_path();
    match fs::read_to_string(&path) {
        Ok(text) => Ok(serde_json::from_str(&text).ok()),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn settings_save(settings: Value) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(&settings)?;
    paths::atomic_write(&paths::settings_path(), &bytes)
}

/// Read a single boolean field from settings.json (used by the Rust shell for
/// behaviors like close-to-tray without owning the settings schema).
pub fn read_field_bool(name: &str, default: bool) -> bool {
    settings_load()
        .ok()
        .flatten()
        .and_then(|v| v.get(name).and_then(Value::as_bool))
        .unwrap_or(default)
}

/// Read a single string field from settings.json.
pub fn read_field_str(name: &str) -> Option<String> {
    settings_load()
        .ok()
        .flatten()
        .and_then(|v| v.get(name).and_then(|f| f.as_str().map(String::from)))
}
