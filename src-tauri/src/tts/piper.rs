// Piper local voices: curated model catalog, binary + model downloads with
// progress, process-spawn synthesis to WAV.

use super::VoiceInfo;
use crate::error::{AppError, Result};
use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PiperModel {
    pub id: String,
    pub name: String,
    pub quality: String,
    pub locale: String,
    pub size_mb: u32,
    pub installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiperStatus {
    pub binary_installed: bool,
    pub binary_size_mb: u32,
    pub models: Vec<PiperModel>,
}

/// Synthesize one sentence to WAV at `out` using an installed model.
pub fn synth(voice_id: &str, text: &str, out: &Path) -> Result<()> {
    let _ = (voice_id, text, out);
    Err(AppError::msg("not implemented yet"))
}

/// Installed models as VoiceInfo entries (for unified voice listing).
pub fn installed_voices() -> Vec<VoiceInfo> {
    Vec::new()
}

#[tauri::command]
pub async fn piper_status() -> Result<PiperStatus> {
    Err(AppError::msg("not implemented yet"))
}

#[tauri::command]
pub async fn piper_install_binary(app: AppHandle) -> Result<()> {
    let _ = app;
    Err(AppError::msg("not implemented yet"))
}

#[tauri::command]
pub async fn piper_install_model(app: AppHandle, model_id: String) -> Result<()> {
    let _ = (app, model_id);
    Err(AppError::msg("not implemented yet"))
}

#[tauri::command]
pub async fn piper_remove_model(model_id: String) -> Result<()> {
    let _ = model_id;
    Err(AppError::msg("not implemented yet"))
}

#[tauri::command]
pub async fn piper_remove_all() -> Result<()> {
    Err(AppError::msg("not implemented yet"))
}

#[tauri::command]
pub fn piper_dir() -> Result<String> {
    Ok(crate::paths::voices_dir().to_string_lossy().into_owned())
}
