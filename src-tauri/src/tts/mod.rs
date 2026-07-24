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

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
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
    let cancel_flag = claim_job(&state, &task_id, "Another audio preparation is already running")?;

    let result = tauri::async_runtime::spawn_blocking(move || {
        // De-duplicate first: repeated sentences share a cache key, and two
        // workers on the same key would collide on its staging file. Preserve
        // first-occurrence order and drop empty/whitespace texts here so the
        // progress total reflects only the real synthesis work.
        let refs: Vec<&str> = texts.iter().map(|s| s.as_str()).collect();
        let work = dedupe_work(&refs);
        let total = work.len() as u64;

        let emit = |received: u64, done: bool, error: Option<String>| {
            let _ = app.emit(
                "download-progress",
                crate::downloads::DownloadProgress {
                    task_id: task_id.clone(),
                    label: label.clone(),
                    received,
                    total: Some(total),
                    done,
                    error,
                },
            );
        };
        emit(0, false, None);

        let (synthesized, first_error) =
            run_synth_pool(&provider, &voice_id, &work, &cancel_flag, |received| {
                emit(received, false, None)
            });

        // Pool fully joined — the count and the error slot are stable.
        if cancel_flag.load(Ordering::SeqCst) {
            emit(synthesized as u64, true, Some("Cancelled".into()));
            return Ok(synthesized);
        }
        if let Some(err) = first_error {
            emit(synthesized as u64, true, Some(err.to_string()));
            return Err(err);
        }
        emit(synthesized as u64, true, None);
        Ok(synthesized)
    })
    .await
    .map_err(|e| AppError::wrap("Preparation task", e))
    .and_then(|r| r);

    release_job(&state);
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

/// How many precache workers to run in parallel for a provider. Local engines
/// (system/piper/kokoro) are CPU- and process-heavy — each synth spawns a
/// process or reloads a model — so cap the pool at 2. Network-bound cloud
/// providers tolerate more in-flight sockets, so use 4. Unknown providers get
/// the network width (they are never local).
fn precache_workers(provider: &str) -> usize {
    match provider {
        "system" | "piper" | "kokoro" => 2,
        _ => 4,
    }
}

/// Claim the single audio-job slot shared by precache and export. Wires a fresh
/// cancel flag into `CANCEL_BRIDGE` so `tts_precache_cancel` reaches whichever
/// job currently holds the slot. Errors with `busy_msg` when a job is running.
pub(crate) fn claim_job(
    state: &PrecacheState,
    task_id: &str,
    busy_msg: &str,
) -> Result<Arc<AtomicBool>> {
    {
        let mut active = state.active.lock().unwrap();
        if active.is_some() {
            return Err(AppError::msg(busy_msg));
        }
        *active = Some(task_id.to_string());
        state.cancel.store(false, Ordering::SeqCst);
    }
    // State handles can't cross into spawn_blocking; the blocking loop polls
    // this Arc, and tts_precache_cancel flips it through the bridge.
    let cancel_flag = Arc::new(AtomicBool::new(false));
    *CANCEL_BRIDGE.lock().unwrap() = Some(cancel_flag.clone());
    Ok(cancel_flag)
}

/// Release the audio-job slot and drop the cancel bridge.
pub(crate) fn release_job(state: &PrecacheState) {
    *state.active.lock().unwrap() = None;
    *CANCEL_BRIDGE.lock().unwrap() = None;
}

/// De-duplicate a sentence list, preserving first-occurrence order and dropping
/// empty/whitespace-only entries. Repeated sentences share one cache key, so a
/// single synthesis serves them all.
pub(crate) fn dedupe_work<'a>(texts: &[&'a str]) -> Vec<&'a str> {
    let mut seen: HashSet<&'a str> = HashSet::new();
    texts
        .iter()
        .copied()
        .filter(|t| !t.trim().is_empty())
        .filter(|t| seen.insert(*t))
        .collect()
}

/// Synthesize `work` (already de-duplicated and non-empty) into the disk cache
/// with a provider-sized worker pool: K workers (`precache_workers`) pull
/// sentence indices from a shared atomic cursor and synthesize in parallel.
///
/// `synth_via_cache` is thread-safe for DIFFERENT texts — each writes its own
/// staging file, and prune never evicts files younger than 120s — so the one
/// real hazard is two workers racing on the SAME cache key. The caller's up-front
/// de-duplication rules that out. The pool winds down cleanly on cancel or the
/// first error; `on_progress(completed)` runs on this thread at ~300ms intervals
/// while it works. Returns the completed count and the first error, if any — the
/// caller inspects `cancel` to tell a cancel apart from a clean finish.
pub(crate) fn run_synth_pool(
    provider: &str,
    voice_id: &str,
    work: &[&str],
    cancel: &Arc<AtomicBool>,
    on_progress: impl Fn(u64),
) -> (u32, Option<AppError>) {
    let total = work.len() as u64;
    let completed = Arc::new(AtomicU32::new(0));
    let cursor = Arc::new(AtomicUsize::new(0));
    let error_flag = Arc::new(AtomicBool::new(false));
    let first_error: Mutex<Option<AppError>> = Mutex::new(None);

    // Never spawn more workers than there is work.
    let k = precache_workers(provider).min(work.len());
    let first_error = &first_error;

    thread::scope(|scope| {
        for _ in 0..k {
            let completed = Arc::clone(&completed);
            let cursor = Arc::clone(&cursor);
            let error_flag = Arc::clone(&error_flag);
            let cancel = Arc::clone(cancel);
            scope.spawn(move || loop {
                // Wind down as soon as anyone cancels or hits an error.
                if cancel.load(Ordering::SeqCst) || error_flag.load(Ordering::SeqCst) {
                    break;
                }
                let idx = cursor.fetch_add(1, Ordering::SeqCst);
                if idx >= work.len() {
                    break;
                }
                match cache::synth_via_cache(provider, voice_id, work[idx]) {
                    Ok(_) => {
                        completed.fetch_add(1, Ordering::SeqCst);
                    }
                    Err(e) => {
                        // Keep the FIRST error; signal the others to stop.
                        let mut slot = first_error.lock().unwrap();
                        if slot.is_none() {
                            *slot = Some(e);
                        }
                        error_flag.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            });
        }

        // Progress emitter (this thread): throttle to ~300ms until the pool
        // finishes, is cancelled, or errors.
        let mut last_emit = Instant::now();
        loop {
            let done_now = completed.load(Ordering::SeqCst) as u64;
            if cancel.load(Ordering::SeqCst)
                || error_flag.load(Ordering::SeqCst)
                || done_now >= total
            {
                break;
            }
            if last_emit.elapsed() >= Duration::from_millis(300) {
                on_progress(done_now);
                last_emit = Instant::now();
            }
            thread::sleep(Duration::from_millis(50));
        }
    });

    let synthesized = completed.load(Ordering::SeqCst);
    let err = first_error.lock().unwrap().take();
    (synthesized, err)
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

#[cfg(test)]
mod tests {
    use super::precache_workers;

    #[test]
    fn precache_workers_by_provider() {
        // Local engines are process/CPU-heavy → 2 workers.
        for local in ["system", "piper", "kokoro"] {
            assert_eq!(precache_workers(local), 2, "{local} is a local engine → 2");
        }
        // Network-bound cloud providers → 4 workers.
        for net in ["edge", "eleven", "openai", "speechify", "deepgram", "cartesia"] {
            assert_eq!(precache_workers(net), 4, "{net} is network-bound → 4");
        }
        // Unknown providers default to the network width (never local).
        assert_eq!(precache_workers("bogus"), 4);
    }
}
