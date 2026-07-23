// Microsoft Edge read-aloud voices over the consumer WebSocket endpoint.

use super::{VoiceInfo, WordBoundary};
use crate::error::{AppError, Result};
use std::path::Path;

/// Synthesize one sentence to MP3 at `out`; returns word boundaries.
pub fn synth(voice_id: &str, text: &str, out: &Path) -> Result<Vec<WordBoundary>> {
    let _ = (voice_id, text, out);
    Err(AppError::msg("not implemented yet"))
}

#[tauri::command]
pub async fn edge_voices() -> Result<Vec<VoiceInfo>> {
    Err(AppError::msg("not implemented yet"))
}
