// TTS dispatch: one `tts_synth` command routes to the provider modules
// through the disk cache. Shared shapes live here (mirrored in core/types.ts).

pub mod cache;
pub mod edge;
pub mod eleven;
pub mod piper;
pub mod system;

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WordBoundary {
    pub offset_ms: u32,
    pub char_start: u32,
    pub char_len: u32,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthResult {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boundaries: Option<Vec<WordBoundary>>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub provider: String,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<bool>,
}

/// Synthesize one sentence. Checks the disk cache first; on miss, calls the
/// provider and stores the result (plus a boundaries sidecar when present).
#[tauri::command]
pub async fn tts_synth(
    app: tauri::AppHandle,
    provider: String,
    voice_id: String,
    text: String,
) -> Result<SynthResult> {
    if text.trim().is_empty() {
        return Err(AppError::msg("Nothing to speak"));
    }
    if text.len() > 8000 {
        return Err(AppError::msg("Sentence too long to synthesize"));
    }
    let _ = app;
    tauri::async_runtime::spawn_blocking(move || {
        cache::synth_via_cache(&provider, &voice_id, &text)
    })
    .await
    .map_err(|e| AppError::wrap("Synthesis task failed", e))?
}
