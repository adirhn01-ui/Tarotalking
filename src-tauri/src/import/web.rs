// Web page fetching for article import. The frontend has no network access;
// this is the only place HTML enters the app. Extraction (readability)
// happens in the frontend on the returned string.

use crate::error::{AppError, Result};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedPage {
    pub final_url: String,
    pub content_type: String,
    pub body: String,
}

#[tauri::command]
pub async fn fetch_url(url: String) -> Result<FetchedPage> {
    let _ = url;
    Err(AppError::msg("not implemented yet"))
}
