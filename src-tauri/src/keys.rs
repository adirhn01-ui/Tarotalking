// API key storage in Windows Credential Manager (service "tarotalking").
// Keys are write-only from the frontend's perspective: no command ever
// returns a stored key.

use crate::error::{AppError, Result};

#[tauri::command]
pub fn key_set(provider: String, key: String) -> Result<()> {
    let _ = (provider, key);
    Err(AppError::msg("not implemented yet"))
}

#[tauri::command]
pub fn key_present(provider: String) -> Result<bool> {
    let _ = provider;
    Err(AppError::msg("not implemented yet"))
}

#[tauri::command]
pub fn key_delete(provider: String) -> Result<()> {
    let _ = provider;
    Err(AppError::msg("not implemented yet"))
}

/// Internal: read a key for provider use (e.g. ElevenLabs synthesis).
/// Returns Ok(None) when no key is stored.
pub fn get_key(provider: &str) -> Result<Option<String>> {
    let _ = provider;
    Err(AppError::msg("not implemented yet"))
}
