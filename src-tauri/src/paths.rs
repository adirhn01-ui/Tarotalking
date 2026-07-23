// Data-location + safe-write helpers. Every module resolves paths through
// here so the documented layout stays true in one place.
//
//   %APPDATA%\Tarotalking            settings.json, library\
//   %LOCALAPPDATA%\Tarotalking       cache\audio\, voices\

use crate::error::{AppError, Result};
use std::fs;
use std::path::{Path, PathBuf};

pub fn appdata_dir() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    Path::new(&base).join("Tarotalking")
}

pub fn localdata_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    Path::new(&base).join("Tarotalking")
}

pub fn settings_path() -> PathBuf {
    appdata_dir().join("settings.json")
}

pub fn library_dir() -> PathBuf {
    appdata_dir().join("library")
}

pub fn library_index_path() -> PathBuf {
    library_dir().join("index.json")
}

pub fn items_dir() -> PathBuf {
    library_dir().join("items")
}

/// Item ids are frontend-generated UUIDs. Reject anything that could walk the
/// filesystem — an id is the ONLY user-influenced path segment we ever join.
pub fn item_dir(id: &str) -> Result<PathBuf> {
    if id.is_empty()
        || id.len() > 64
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(AppError::msg("Invalid item id"));
    }
    Ok(items_dir().join(id))
}

pub fn audio_cache_dir() -> PathBuf {
    localdata_dir().join("cache").join("audio")
}

pub fn voices_dir() -> PathBuf {
    localdata_dir().join("voices")
}

pub fn ensure_dir(p: &Path) -> Result<()> {
    fs::create_dir_all(p)?;
    Ok(())
}

/// Write via tmp file + rename so a crash never leaves a torn JSON on disk.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    // Windows rename fails if the target exists; replace via remove+rename.
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}
