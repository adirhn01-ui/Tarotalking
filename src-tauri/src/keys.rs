// API key storage in Windows Credential Manager (service "tarotalking").
// Keys are write-only from the frontend's perspective: no command ever
// returns a stored key.

use crate::error::{AppError, Result};
use keyring::Entry;

const SERVICE: &str = "tarotalking";

/// Provider ids must match `[a-z0-9-]{1,32}` — they become a credential
/// account name, so keep them tight and predictable.
fn valid_provider(provider: &str) -> bool {
    let len = provider.len();
    len >= 1
        && len <= 32
        && provider
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn entry(provider: &str) -> Result<Entry> {
    if !valid_provider(provider) {
        return Err(AppError::msg("Invalid provider"));
    }
    Entry::new(SERVICE, provider).map_err(|e| AppError::wrap("Key store", e))
}

#[tauri::command]
pub fn key_set(provider: String, key: String) -> Result<()> {
    let entry = entry(&provider)?;
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::msg("The key is empty"));
    }
    entry
        .set_password(key)
        .map_err(|e| AppError::wrap("Could not save the key", e))
}

#[tauri::command]
pub fn key_present(provider: String) -> Result<bool> {
    let entry = entry(&provider)?;
    Ok(entry.get_password().is_ok())
}

#[tauri::command]
pub fn key_delete(provider: String) -> Result<()> {
    let entry = entry(&provider)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::wrap("Could not delete the key", e)),
    }
}

/// Internal: read a key for provider use (e.g. ElevenLabs synthesis).
/// Returns Ok(None) when no key is stored.
pub fn get_key(provider: &str) -> Result<Option<String>> {
    let entry = entry(provider)?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::wrap("Key store", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_validation() {
        assert!(valid_provider("elevenlabs"));
        assert!(valid_provider("eleven-labs-1"));
        assert!(valid_provider("a"));
        assert!(!valid_provider(""));
        assert!(!valid_provider("Eleven")); // uppercase
        assert!(!valid_provider("has space"));
        assert!(!valid_provider("has/slash"));
        assert!(!valid_provider(&"x".repeat(33))); // too long
    }

    #[test]
    fn invalid_provider_errors_without_touching_store() {
        assert!(key_present("BAD PROVIDER".into()).is_err());
        assert!(get_key("../nope").is_err());
    }
}
