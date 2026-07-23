// Disk audio cache: xxh3-keyed files under %LOCALAPPDATA%\Tarotalking\cache\audio,
// LRU-pruned to the settings cap. Boundaries live in a .json sidecar.

use super::{SynthResult, WordBoundary};
use crate::error::{AppError, Result};
use serde::Serialize;

#[derive(Serialize)]
pub struct CacheStats {
    pub bytes: u64,
    pub files: u64,
}

/// Cache-or-synthesize: the single entry point used by tts_synth.
/// On miss, dispatches to edge/piper/eleven::synth and stores the result.
pub fn synth_via_cache(provider: &str, voice_id: &str, text: &str) -> Result<SynthResult> {
    let _ = (provider, voice_id, text);
    Err(AppError::msg("not implemented yet"))
}

/// Store boundaries alongside an audio file (sidecar `<file>.bounds.json`).
pub fn write_boundaries(audio_path: &std::path::Path, bounds: &[WordBoundary]) -> Result<()> {
    let _ = (audio_path, bounds);
    Err(AppError::msg("not implemented yet"))
}

#[tauri::command]
pub fn cache_stats() -> Result<CacheStats> {
    Err(AppError::msg("not implemented yet"))
}

#[tauri::command]
pub fn cache_clear() -> Result<()> {
    Err(AppError::msg("not implemented yet"))
}

#[tauri::command]
pub fn cache_prune(max_bytes: u64) -> Result<()> {
    let _ = max_bytes;
    Err(AppError::msg("not implemented yet"))
}
