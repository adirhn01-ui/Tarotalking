// Library persistence: opaque index JSON + per-item content dirs.
// Signatures are frozen (registered in lib.rs).

use crate::error::{AppError, Result};
use crate::paths;
use serde_json::Value;
use std::fs;

const MISSING_DOC: &str = "This item's content is missing — try importing it again";

#[tauri::command]
pub fn library_load() -> Result<Option<Value>> {
    let path = paths::library_index_path();
    // Read bytes, not a String: serde_json validates the UTF-8 it needs while
    // parsing, so decoding the whole file up front is a wasted extra pass.
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        // Missing (or otherwise unreadable) index → treat as an empty library.
        Err(_) => return Ok(None),
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(v) => Ok(Some(v)),
        Err(_) => {
            // Corrupt JSON (or bytes that are not JSON at all): back it up
            // before anything can overwrite it, so the user's library metadata
            // is never silently lost.
            let bak = path.with_extension("json.bak");
            let _ = fs::rename(&path, &bak);
            Ok(None)
        }
    }
}

#[tauri::command]
pub fn library_save(index: Value) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(&index)?;
    paths::atomic_write(&paths::library_index_path(), &bytes)
}

#[tauri::command]
pub fn item_write_doc(id: String, doc: Value) -> Result<()> {
    let dir = paths::item_dir(&id)?;
    let bytes = serde_json::to_vec_pretty(&doc)?;
    paths::atomic_write(&dir.join("doc.json"), &bytes)
}

#[tauri::command]
pub fn item_read_doc(id: String) -> Result<Value> {
    let path = paths::item_dir(&id)?.join("doc.json");
    // A book's doc.json runs to megabytes; parse the bytes directly rather than
    // walking the whole buffer once more to build an intermediate String.
    let bytes = fs::read(&path).map_err(|_| AppError::msg(MISSING_DOC))?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::msg(MISSING_DOC))
}

#[tauri::command]
pub fn item_delete(id: String) -> Result<()> {
    let dir = paths::item_dir(&id)?;
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::wrap("Could not delete this item", e)),
    }
}

/// Serializes env-mutating tests across the crate (APPDATA is process-global).
#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::PoisonError;

    fn temp_dir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("tarotalking-lib-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn index_and_doc_round_trip() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        let tmp = temp_dir();
        std::env::set_var("APPDATA", &tmp);

        // Missing index → None.
        assert!(library_load().unwrap().is_none());

        // Save then reload.
        let index = json!({ "version": 1, "items": [{ "id": "a" }], "collections": [] });
        library_save(index.clone()).unwrap();
        assert_eq!(library_load().unwrap(), Some(index));

        // Per-item doc round-trip.
        let doc = json!({ "chapters": [{ "blocks": [{ "type": "p", "text": "hi" }] }] });
        item_write_doc("item-abc-123".into(), doc.clone()).unwrap();
        assert_eq!(item_read_doc("item-abc-123".into()).unwrap(), doc);

        // Missing item doc → friendly error.
        assert!(item_read_doc("no-such-item".into()).is_err());

        // Delete removes the dir; a second delete is still Ok; reading errors.
        item_delete("item-abc-123".into()).unwrap();
        item_delete("item-abc-123".into()).unwrap();
        assert!(item_read_doc("item-abc-123".into()).is_err());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn corrupt_index_is_backed_up() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        let tmp = temp_dir();
        std::env::set_var("APPDATA", &tmp);

        let path = paths::library_index_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{ this is not valid json ").unwrap();

        // Load returns None and leaves a .bak behind (original never overwritten).
        assert!(library_load().unwrap().is_none());
        assert!(path.with_extension("json.bak").exists());
        assert!(!path.exists());

        // Bytes that are not even valid UTF-8 are corruption too, and get the
        // same rescue rather than being silently treated as an empty library.
        std::fs::write(&path, [0xffu8, 0xfe, 0x00, 0x7b]).unwrap();
        assert!(library_load().unwrap().is_none());
        assert!(path.with_extension("json.bak").exists());
        assert!(!path.exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn invalid_item_id_is_rejected() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        let tmp = temp_dir();
        std::env::set_var("APPDATA", &tmp);
        assert!(item_write_doc("../escape".into(), json!({})).is_err());
        assert!(item_read_doc("../escape".into()).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
