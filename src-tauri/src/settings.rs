// Settings persistence — stored as opaque JSON (the frontend owns the schema
// and sanitizes on read), so adding a settings field needs no Rust change.
//
// Reads are served from a process-wide in-memory copy: the synthesis hot path
// asks for fields like audioQuality on every sentence (including cache hits,
// and from up to 4 precache workers at once), so hitting the disk per read is
// pure waste. The copy is refreshed on every save and on the boot-time load,
// which are the only ways the file changes while the app runs.

use crate::error::Result;
use crate::paths;
use serde_json::Value;
use std::fs;
use std::sync::{OnceLock, RwLock};

/// Outer Option: has the cache been populated? Inner Option: the file's parse
/// result (None = missing/corrupt file, a valid state).
fn cache_cell() -> &'static RwLock<Option<Option<Value>>> {
    static CELL: OnceLock<RwLock<Option<Option<Value>>>> = OnceLock::new();
    CELL.get_or_init(|| RwLock::new(None))
}

fn load_from_disk() -> Option<Value> {
    let path = paths::settings_path();
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).ok(),
        Err(_) => None,
    }
}

/// Run `f` against the cached settings without copying them. Field reads sit
/// on the synthesis path (once per sentence, from several precache workers at
/// once), so they borrow under the read lock instead of cloning the document.
fn with_settings<T>(f: impl FnOnce(Option<&Value>) -> T) -> T {
    {
        let guard = cache_cell().read().unwrap();
        if let Some(parsed) = guard.as_ref() {
            return f(parsed.as_ref());
        }
    }
    // First read of the session: populate, then borrow. Loading happens outside
    // the write lock so a slow disk never blocks other readers longer than the
    // store itself.
    let loaded = load_from_disk();
    {
        let mut w = cache_cell().write().unwrap();
        if w.is_none() {
            *w = Some(loaded);
        }
    }
    let guard = cache_cell().read().unwrap();
    f(guard.as_ref().and_then(|parsed| parsed.as_ref()))
}

#[tauri::command]
pub fn settings_load() -> Result<Option<Value>> {
    // Boot-time load reads the disk fresh (source of truth) and primes the cache.
    let v = load_from_disk();
    *cache_cell().write().unwrap() = Some(v.clone());
    Ok(v)
}

#[tauri::command]
pub fn settings_save(settings: Value) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(&settings)?;
    paths::atomic_write(&paths::settings_path(), &bytes)?;
    *cache_cell().write().unwrap() = Some(Some(settings));
    Ok(())
}

/// Read a single boolean field from settings (used by the Rust shell for
/// behaviors like close-to-tray without owning the settings schema).
pub fn read_field_bool(name: &str, default: bool) -> bool {
    with_settings(|v| v.and_then(|v| v.get(name)).and_then(Value::as_bool)).unwrap_or(default)
}

/// Read a single numeric field from settings.
pub fn read_field_u64(name: &str) -> Option<u64> {
    with_settings(|v| v.and_then(|v| v.get(name)).and_then(Value::as_u64))
}

/// Read a single string field from settings.
pub fn read_field_str(name: &str) -> Option<String> {
    with_settings(|v| {
        v.and_then(|v| v.get(name))
            .and_then(Value::as_str)
            .map(String::from)
    })
}
