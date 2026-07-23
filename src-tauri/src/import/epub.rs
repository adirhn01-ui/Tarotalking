// EPUB import: unzip, parse container/OPF/TOC with quick-xml, extract images
// (and the cover) into the item dir, return raw chapter XHTML for the
// frontend to convert into blocks.
// Signatures + shapes are frozen (mirrored in ipc.ts).

use crate::error::{AppError, Result};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubChapterRaw {
    pub href: String,
    pub title: Option<String>,
    pub html: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubImportResult {
    pub item_dir: String,
    pub title: Option<String>,
    pub author: Option<String>,
    pub cover_path: Option<String>,
    pub chapters: Vec<EpubChapterRaw>,
    /// zip-relative image path (lowercased, forward slashes) → absolute extracted path
    pub images: HashMap<String, String>,
}

#[tauri::command]
pub async fn import_epub(id: String, path: String) -> Result<EpubImportResult> {
    let _ = (id, path);
    Err(AppError::msg("not implemented yet"))
}
