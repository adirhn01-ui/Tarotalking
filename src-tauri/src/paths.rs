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
/// `fs::rename` replaces an existing destination (MoveFileEx with
/// REPLACE_EXISTING on Windows), so the live file only ever holds the old bytes
/// or the new ones — deleting it first would both cost two syscalls per save
/// and open a window where it is missing entirely.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_creates_parents_and_replaces_existing() {
        let dir = std::env::temp_dir().join(format!("tarot-paths-{}", uuid::Uuid::new_v4()));
        let target = dir.join("nested").join("index.json");

        atomic_write(&target, b"first").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"first");

        // Overwriting an existing file must succeed and leave no tmp behind.
        atomic_write(&target, b"second").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"second");
        assert!(!target.with_extension("tmp").exists(), "tmp is renamed away");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn item_dir_rejects_path_traversal() {
        assert!(item_dir("../escape").is_err());
        assert!(item_dir("a/b").is_err());
        assert!(item_dir("").is_err());
        assert!(item_dir(&"x".repeat(65)).is_err());
        assert!(item_dir("0f8b-4c2a-9d").is_ok());
    }
}
