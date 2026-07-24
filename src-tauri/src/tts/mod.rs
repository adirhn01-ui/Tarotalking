// TTS dispatch: one `tts_synth` command routes to the provider modules
// through the disk cache. Shared shapes live here (mirrored in core/types.ts).

pub mod cache;
pub mod cartesia;
pub mod deepgram;
pub mod edge;
pub mod eleven;
pub mod kokoro;
pub mod openai;
pub mod piper;
pub mod speechify;
pub mod system;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Emitter;

/// One pre-synthesis job at a time; cancellation is a shared flag.
#[derive(Default)]
pub struct PrecacheState {
    active: Mutex<Option<String>>,
    cancel: AtomicBool,
}

/// Synthesize a batch of sentences into the cache (skipping ones already
/// cached), emitting "download-progress" events (received/total = sentence
/// counts) under `task_id`. Returns how many sentences were synthesized.
#[tauri::command]
pub async fn tts_precache(
    app: tauri::AppHandle,
    state: tauri::State<'_, PrecacheState>,
    provider: String,
    voice_id: String,
    texts: Vec<String>,
    task_id: String,
    label: String,
) -> Result<u32> {
    {
        let mut active = state.active.lock().unwrap();
        if active.is_some() {
            return Err(AppError::msg("Another audio preparation is already running"));
        }
        *active = Some(task_id.clone());
        state.cancel.store(false, Ordering::SeqCst);
    }

    // State handles can't cross into spawn_blocking; move plain handles.
    let cancel_flag = std::sync::Arc::new(AtomicBool::new(false));
    let cancel_in = cancel_flag.clone();
    {
        // Bridge: the managed flag is polled by the blocking loop through
        // this Arc; tts_precache_cancel sets the managed flag which we
        // mirror below on every iteration via a lightweight check command.
        // Simpler: store the Arc in the managed state for cancel to flip.
        *CANCEL_BRIDGE.lock().unwrap() = Some(cancel_in.clone());
    }

    let total = texts.len() as u64;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut synthesized = 0u32;
        let mut last_emit = std::time::Instant::now();
        let emit = |app: &tauri::AppHandle, done: u64, finished: bool, error: Option<String>| {
            let _ = app.emit(
                "download-progress",
                crate::downloads::DownloadProgress {
                    task_id: task_id.clone(),
                    label: label.clone(),
                    received: done,
                    total: Some(total),
                    done: finished,
                    error,
                },
            );
        };
        emit(&app, 0, false, None);
        for (i, text) in texts.iter().enumerate() {
            if cancel_flag.load(Ordering::SeqCst) {
                emit(&app, i as u64, true, Some("Cancelled".into()));
                return Ok(synthesized);
            }
            if text.trim().is_empty() {
                continue;
            }
            match cache::synth_via_cache(&provider, &voice_id, text) {
                Ok(_) => synthesized += 1,
                Err(e) => {
                    emit(&app, i as u64, true, Some(e.to_string()));
                    return Err(e);
                }
            }
            if last_emit.elapsed().as_millis() >= 250 {
                emit(&app, (i + 1) as u64, false, None);
                last_emit = std::time::Instant::now();
            }
        }
        emit(&app, total, true, None);
        Ok(synthesized)
    })
    .await
    .map_err(|e| AppError::wrap("Preparation task", e))
    .and_then(|r| r);

    *state.active.lock().unwrap() = None;
    *CANCEL_BRIDGE.lock().unwrap() = None;
    result
}

/// Arc handoff between the async command and its blocking loop.
static CANCEL_BRIDGE: Mutex<Option<std::sync::Arc<AtomicBool>>> = Mutex::new(None);

#[tauri::command]
pub fn tts_precache_cancel(state: tauri::State<'_, PrecacheState>) {
    state.cancel.store(true, Ordering::SeqCst);
    if let Some(flag) = CANCEL_BRIDGE.lock().unwrap().as_ref() {
        flag.store(true, Ordering::SeqCst);
    }
}

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
