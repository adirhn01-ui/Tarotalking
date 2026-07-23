// ElevenLabs synthesis + voice list. The API key is read from the Windows
// Credential Manager inside this module and NEVER leaves Rust.

use super::VoiceInfo;
use crate::error::{AppError, Result};
use std::path::Path;

/// Synthesize one sentence to MP3 at `out`. Model comes from the settings
/// field `elevenModel` (settings::read_field_str) with a sensible default.
pub fn synth(voice_id: &str, text: &str, out: &Path) -> Result<()> {
    let _ = (voice_id, text, out);
    Err(AppError::msg("not implemented yet"))
}

#[tauri::command]
pub async fn eleven_voices() -> Result<Vec<VoiceInfo>> {
    Err(AppError::msg("not implemented yet"))
}
