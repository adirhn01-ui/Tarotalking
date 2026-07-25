// Piper local voices: curated model catalog, binary + model downloads with
// progress, and synthesis to WAV. Synthesis prefers a persistent
// `--json-input` worker process (one warm process per voice, model stays
// loaded, reaped after it sits idle) and falls back to a per-sentence one-shot
// spawn on any worker failure.

use super::VoiceInfo;
use crate::error::{AppError, Result};
use crate::paths::{ensure_dir, voices_dir};
use serde::Serialize;
use std::io::{BufRead, BufReader, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// Windows x64 Piper engine (exe + espeak-ng-data + dlls) as a single zip.
const BINARY_URL: &str =
    "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip";
/// Reported download size of the engine zip, MB.
const BINARY_SIZE_MB: u32 = 21;
/// Hard ceiling on one synthesis before we give up on the child process.
const SYNTH_TIMEOUT: Duration = Duration::from_secs(60);

/// Curated voice catalog: (model_id, display name, approx download size MB).
/// Locale/quality/voice-name are derived from the id (see `parse_id`).
const CATALOG: &[(&str, &str, u32)] = &[
    ("en_US-amy-medium", "Amy (US)", 63),
    ("en_US-lessac-medium", "Lessac (US)", 63),
    ("en_US-joe-medium", "Joe (US)", 63),
    ("en_US-hfc_female-medium", "Heart (US)", 63),
    ("en_US-hfc_male-medium", "Harmon (US)", 63),
    ("en_US-kristin-medium", "Kristin (US)", 61),
    ("en_US-ryan-high", "Ryan (US · high quality)", 115),
    ("en_GB-alan-medium", "Alan (UK)", 63),
    ("en_GB-alba-medium", "Alba (UK)", 63),
    ("en_GB-jenny_dioco-medium", "Jenny (UK)", 63),
    ("en_GB-northern_english_male-medium", "Bram (UK)", 63),
    ("en_GB-cori-high", "Cori (UK · high quality)", 115),
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PiperModel {
    pub id: String,
    pub name: String,
    pub quality: String,
    pub locale: String,
    #[serde(rename = "sizeMB")] // camelCase would yield "sizeMb" ≠ ipc.ts
    pub size_mb: u32,
    pub installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiperStatus {
    pub binary_installed: bool,
    #[serde(rename = "binarySizeMB")] // camelCase would yield "binarySizeMb" ≠ ipc.ts
    pub binary_size_mb: u32,
    pub models: Vec<PiperModel>,
}

/// Split a model id into (locale, voice-name, quality). Locale is the segment
/// before the FIRST '-', quality the segment after the LAST '-', and the voice
/// name everything between — so multi-dash names like "hfc_female" or
/// "northern_english_male" survive intact.
fn parse_id(id: &str) -> Option<(&str, &str, &str)> {
    let first = id.find('-')?;
    let last = id.rfind('-')?;
    if last <= first {
        return None;
    }
    Some((&id[..first], &id[first + 1..last], &id[last + 1..]))
}

/// Human display locale ("en_US" → "en-US").
fn display_locale(locale: &str) -> String {
    locale.replace('_', "-")
}

/// HuggingFace download URL for the .onnx model.
fn model_url(id: &str) -> Option<String> {
    let (locale, name, quality) = parse_id(id)?;
    Some(format!(
        "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/{locale}/{name}/{quality}/{id}.onnx"
    ))
}

/// Config URL — the model URL with ".json" appended (…/{id}.onnx.json).
fn config_url(id: &str) -> Option<String> {
    Some(format!("{}.json", model_url(id)?))
}

fn piper_dir_path() -> PathBuf {
    voices_dir().join("piper")
}

fn piper_exe() -> PathBuf {
    piper_dir_path().join("piper.exe")
}

fn model_path(id: &str) -> PathBuf {
    voices_dir().join(format!("{id}.onnx"))
}

fn config_path(id: &str) -> PathBuf {
    voices_dir().join(format!("{id}.onnx.json"))
}

/// A model is installed when its .onnx exists non-empty AND its config exists.
fn model_installed(id: &str) -> bool {
    let onnx_ok = std::fs::metadata(model_path(id))
        .map(|m| m.len() > 0)
        .unwrap_or(false);
    onnx_ok && config_path(id).exists()
}

/// Guard against path traversal for any id that reaches the filesystem.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn catalog_has(id: &str) -> bool {
    CATALOG.iter().any(|(cid, ..)| *cid == id)
}

/// Extract the Piper engine zip into `dest`, preserving its top-level "piper/"
/// folder. Rejects entries with traversal or absolute paths.
fn extract_engine(zip_path: &Path, dest: &Path) -> Result<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| AppError::wrap("zip", e))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| AppError::wrap("zip", e))?;
        let name = entry.name().to_string();
        // Reject traversal, unix-absolute, and drive-absolute (e.g. "C:\...").
        let unsafe_entry = name.contains("..")
            || name.starts_with('/')
            || name.starts_with('\\')
            || (name.len() >= 2 && name.as_bytes()[1] == b':');
        if unsafe_entry {
            return Err(AppError::msg("unsafe zip entry"));
        }
        let out_path = dest.join(&name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&out_path)?;
        std::io::copy(&mut entry, &mut out)?;
    }
    Ok(())
}

/// Idle-reaper cadence and the idle span after which a warm worker is killed.
const REAPER_INTERVAL: Duration = Duration::from_secs(15);
const WORKER_IDLE_TTL: Duration = Duration::from_secs(60);
/// Consecutive fresh-spawn worker failures before the `--json-input` path is
/// abandoned for the rest of the session (e.g. an old binary lacking the flag).
const JSON_FAILURE_LIMIT: u32 = 2;

/// A warm Piper process kept alive between sentences with the model loaded.
/// `stdout` is an `Option` because it is briefly moved to a reader thread while
/// an ack is awaited; a worker retained between calls always has it back.
struct PiperWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: Option<BufReader<ChildStdout>>,
    voice_id: String,
    last_used: Instant,
}

impl PiperWorker {
    /// Retire deterministically: kill and reap the child so no zombie lingers.
    fn shutdown(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for PiperWorker {
    fn drop(&mut self) {
        // Best-effort so a leaked worker never outlives the app; children die
        // with the parent regardless. No wait() — Drop must not block on exit.
        let _ = self.child.kill();
    }
}

/// The single warm worker, its "json unsupported" latch, the reaper-running
/// guard, and the consecutive fresh-spawn failure counter.
static WORKER: Mutex<Option<PiperWorker>> = Mutex::new(None);
static JSON_UNSUPPORTED: AtomicBool = AtomicBool::new(false);
static REAPER_RUNNING: AtomicBool = AtomicBool::new(false);
static WORKER_SPAWN_FAILURES: AtomicU32 = AtomicU32::new(0);

/// Build one `--json-input` request line. serde_json handles all escaping, so
/// quotes and Windows backslash paths survive intact; embedded CR/LF are
/// collapsed to spaces first so the request stays a single physical line.
fn json_line(text: &str, out_path: &str) -> String {
    let cleaned = text.replace(['\r', '\n'], " ");
    serde_json::json!({ "text": cleaned, "output_file": out_path }).to_string()
}

/// A completion ack is the line Piper echoes carrying the output path.
fn ack_matches(line: &str, out_path: &str) -> bool {
    let want = out_path.trim();
    !want.is_empty() && line.trim().contains(want)
}

/// A warm worker can only serve the voice whose model it loaded.
fn should_switch_voice(current: &str, requested: &str) -> bool {
    current != requested
}

/// Idle-expiry predicate, split out so the reaper timing is unit-testable.
fn is_expired(idle: Duration, ttl: Duration) -> bool {
    idle > ttl
}

/// Synthesize one sentence to WAV at `out` using an installed model. Prefers
/// the warm worker; any worker-mechanism failure falls back to a one-shot spawn
/// for this sentence so a single glitch never drops audio.
pub fn synth(voice_id: &str, text: &str, out: &Path) -> Result<()> {
    if !is_safe_id(voice_id) || !model_installed(voice_id) {
        return Err(AppError::msg("This local voice is not downloaded"));
    }
    if !piper_exe().exists() {
        return Err(AppError::msg("The local voice engine is not installed"));
    }
    if let Some(parent) = out.parent() {
        ensure_dir(parent)?;
    }
    if JSON_UNSUPPORTED.load(Ordering::Relaxed) {
        return synth_oneshot(voice_id, text, out);
    }
    match synth_worker(voice_id, text, out) {
        Ok(()) => Ok(()),
        Err(_) => synth_oneshot(voice_id, text, out),
    }
}

/// Spawn a fresh `--json-input` worker with the model preloaded.
fn spawn_worker(voice_id: &str, exe: &Path) -> Result<PiperWorker> {
    let model = model_path(voice_id);
    let config = config_path(voice_id);
    let mut cmd = Command::new(exe);
    cmd.arg("-m")
        .arg(&model)
        .arg("-c")
        .arg(&config)
        .arg("--json-input")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW — no console flash
    }
    let mut child = cmd
        .spawn()
        .map_err(|_| AppError::msg("The local voice failed to start"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::msg("The local voice failed to start"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::msg("The local voice failed to start"))?;
    Ok(PiperWorker {
        child,
        stdin,
        stdout: Some(BufReader::new(stdout)),
        voice_id: voice_id.to_string(),
        last_used: Instant::now(),
    })
}

/// Send one request to a warm worker and await its ack within SYNTH_TIMEOUT.
/// The stdout reader is moved to a helper thread so a wedged worker cannot hang
/// the caller past the timeout; on success it is restored for reuse, on any
/// failure the worker is left for the caller to retire.
fn worker_request(worker: &mut PiperWorker, text: &str, out: &Path) -> Result<()> {
    let out_str = out.to_string_lossy().into_owned();
    let line = json_line(text, &out_str);
    worker
        .stdin
        .write_all(line.as_bytes())
        .and_then(|()| worker.stdin.write_all(b"\n"))
        .and_then(|()| worker.stdin.flush())
        .map_err(|_| AppError::msg("The local voice failed to speak this sentence"))?;

    let reader = worker
        .stdout
        .take()
        .ok_or_else(|| AppError::msg("The local voice failed to speak this sentence"))?;
    let want = out_str.clone();
    let (tx, rx) = mpsc::channel::<(BufReader<ChildStdout>, bool)>();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut ok = false;
        let mut buf = String::new();
        loop {
            buf.clear();
            match reader.read_line(&mut buf) {
                Ok(0) => break, // EOF: the worker exited
                Ok(_) => {
                    if ack_matches(&buf, &want) {
                        ok = true;
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        // A dropped receiver (caller already timed out) makes this a no-op.
        let _ = tx.send((reader, ok));
    });

    match rx.recv_timeout(SYNTH_TIMEOUT) {
        Ok((reader, true)) => {
            worker.stdout = Some(reader);
            let produced = std::fs::metadata(out).map(|m| m.len() > 0).unwrap_or(false);
            if produced {
                Ok(())
            } else {
                Err(AppError::msg("The local voice failed to speak this sentence"))
            }
        }
        // Ack signalled failure/EOF, or the worker wedged past the budget. Either
        // way the caller retires the worker; killing it unblocks the helper read.
        Ok((_reader, false)) => {
            Err(AppError::msg("The local voice failed to speak this sentence"))
        }
        Err(_) => Err(AppError::msg("The local voice timed out")),
    }
}

/// Warm-worker synthesis path. Serialized by WORKER's mutex, so the two
/// precache threads share one warm process rather than each paying a cold spawn.
fn synth_worker(voice_id: &str, text: &str, out: &Path) -> Result<()> {
    let exe = piper_exe();
    let mut guard = WORKER.lock().unwrap_or_else(|e| e.into_inner());

    // A warm worker for a different voice cannot serve this one — retire it.
    if let Some(existing) = guard.as_ref() {
        if should_switch_voice(&existing.voice_id, voice_id) {
            if let Some(mut old) = guard.take() {
                old.shutdown();
            }
        }
    }

    let freshly_spawned = guard.is_none();
    if freshly_spawned {
        *guard = Some(spawn_worker(voice_id, &exe)?);
        ensure_reaper();
    }

    let worker = guard.as_mut().expect("worker present after ensure");
    match worker_request(worker, text, out) {
        Ok(()) => {
            worker.last_used = Instant::now();
            WORKER_SPAWN_FAILURES.store(0, Ordering::Relaxed);
            Ok(())
        }
        Err(e) => {
            if let Some(mut dead) = guard.take() {
                dead.shutdown();
            }
            // Only a first-request failure on a just-spawned worker counts toward
            // giving up: a warm worker dying mid-session is a transient glitch.
            if freshly_spawned
                && WORKER_SPAWN_FAILURES.fetch_add(1, Ordering::Relaxed) + 1 >= JSON_FAILURE_LIMIT
            {
                JSON_UNSUPPORTED.store(true, Ordering::Relaxed);
            }
            Err(e)
        }
    }
}

/// Start the single idle reaper if one is not already running. It runs only
/// while a worker exists and exits once none remains — no thread at idle.
fn ensure_reaper() {
    if REAPER_RUNNING.swap(true, Ordering::AcqRel) {
        return; // already running
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(REAPER_INTERVAL);
        let mut guard = WORKER.lock().unwrap_or_else(|e| e.into_inner());
        let expired = match guard.as_ref() {
            Some(w) => is_expired(w.last_used.elapsed(), WORKER_IDLE_TTL),
            None => true, // retired elsewhere — nothing left to watch
        };
        if expired {
            if let Some(mut dead) = guard.take() {
                dead.shutdown();
            }
            // Cleared under the lock so a concurrent spawn either sees a live
            // worker (this reaper keeps it) or restarts the reaper cleanly.
            REAPER_RUNNING.store(false, Ordering::Release);
            break;
        }
        drop(guard);
    });
}

/// One-shot fallback: spawn Piper fresh for a single sentence, feed it one line,
/// and wait for exit. The reliable path when the warm worker is unavailable.
fn synth_oneshot(voice_id: &str, text: &str, out: &Path) -> Result<()> {
    if !is_safe_id(voice_id) || !model_installed(voice_id) {
        return Err(AppError::msg("This local voice is not downloaded"));
    }
    let exe = piper_exe();
    if !exe.exists() {
        return Err(AppError::msg("The local voice engine is not installed"));
    }
    if let Some(parent) = out.parent() {
        ensure_dir(parent)?;
    }

    let model = model_path(voice_id);
    let config = config_path(voice_id);
    // OsString args only — never a shell string.
    let mut cmd = Command::new(&exe);
    cmd.arg("-m")
        .arg(&model)
        .arg("-c")
        .arg(&config)
        .arg("-f")
        .arg(out)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW — no console flash
    }

    let mut child = cmd
        .spawn()
        .map_err(|_| AppError::msg("The local voice failed to speak this sentence"))?;

    // One utterance per line: collapse embedded newlines, then close stdin (EOF).
    if let Some(mut stdin) = child.stdin.take() {
        let line = text.replace(['\r', '\n'], " ");
        let _ = stdin.write_all(line.as_bytes());
        let _ = stdin.write_all(b"\n");
        // stdin dropped here → pipe closes → piper synthesizes and exits.
    }

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() > SYNTH_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AppError::msg("The local voice timed out"));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::msg("The local voice failed to speak this sentence"));
            }
        }
    };

    let produced = std::fs::metadata(out).map(|m| m.len() > 0).unwrap_or(false);
    if !status.success() || !produced {
        return Err(AppError::msg("The local voice failed to speak this sentence"));
    }
    Ok(())
}

/// Installed models as VoiceInfo entries (for unified voice listing).
#[allow(dead_code)] // reserved for a unified voice-list command
pub fn installed_voices() -> Vec<VoiceInfo> {
    CATALOG
        .iter()
        .filter(|(id, ..)| model_installed(id))
        .map(|(id, name, _)| {
            let locale = parse_id(id).map(|(l, ..)| display_locale(l));
            VoiceInfo {
                provider: "piper".into(),
                id: (*id).to_string(),
                name: (*name).to_string(),
                locale,
                gender: None,
                installed: Some(true),
            }
        })
        .collect()
}

#[tauri::command]
pub async fn piper_status() -> Result<PiperStatus> {
    let models = CATALOG
        .iter()
        .map(|(id, name, size_mb)| {
            let (locale, quality) = parse_id(id)
                .map(|(l, _, q)| (display_locale(l), q.to_string()))
                .unwrap_or_default();
            PiperModel {
                id: (*id).to_string(),
                name: (*name).to_string(),
                quality,
                locale,
                size_mb: *size_mb,
                installed: model_installed(id),
            }
        })
        .collect();
    Ok(PiperStatus {
        binary_installed: piper_exe().exists(),
        binary_size_mb: BINARY_SIZE_MB,
        models,
    })
}

// Downloads run for minutes — they must never sit on a Tokio worker thread,
// or concurrent IPC commands degrade for the whole download.
#[tauri::command]
pub async fn piper_install_binary(app: AppHandle) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || install_binary_blocking(&app))
        .await
        .map_err(|e| AppError::wrap("Install task", e))?
}

fn install_binary_blocking(app: &AppHandle) -> Result<()> {
    if piper_exe().exists() {
        return Ok(());
    }
    let voices = voices_dir();
    ensure_dir(&voices)?;
    let zip_path = voices.join("piper_windows_amd64.zip");
    crate::downloads::download_with_progress(
        app,
        "piper-binary",
        "Piper engine",
        BINARY_URL,
        &zip_path,
    )?;
    extract_engine(&zip_path, &voices)
        .map_err(|_| AppError::msg("Could not unpack the Piper engine"))?;
    let _ = std::fs::remove_file(&zip_path);
    Ok(())
}

#[tauri::command]
pub async fn piper_install_model(app: AppHandle, model_id: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || install_model_blocking(&app, &model_id))
        .await
        .map_err(|e| AppError::wrap("Install task", e))?
}

fn install_model_blocking(app: &AppHandle, model_id: &str) -> Result<()> {
    if !catalog_has(model_id) {
        return Err(AppError::msg("Unknown voice"));
    }
    let label = CATALOG
        .iter()
        .find(|(id, ..)| *id == model_id)
        .map(|(_, name, _)| *name)
        .unwrap_or("Local voice");
    let onnx_url = model_url(model_id).ok_or_else(|| AppError::msg("Unknown voice"))?;
    let cfg_url = config_url(model_id).ok_or_else(|| AppError::msg("Unknown voice"))?;

    ensure_dir(&voices_dir())?;
    crate::downloads::download_with_progress(
        app,
        &format!("piper-model-{model_id}"),
        label,
        &onnx_url,
        &model_path(model_id),
    )?;
    crate::downloads::download_with_progress(
        app,
        &format!("piper-model-{model_id}-cfg"),
        label,
        &cfg_url,
        &config_path(model_id),
    )?;
    Ok(())
}

#[tauri::command]
pub async fn piper_remove_model(model_id: String) -> Result<()> {
    if is_safe_id(&model_id) {
        let _ = std::fs::remove_file(model_path(&model_id));
        let _ = std::fs::remove_file(config_path(&model_id));
    }
    Ok(())
}

#[tauri::command]
pub async fn piper_remove_all() -> Result<()> {
    let voices = voices_dir();
    if let Ok(read) = std::fs::read_dir(&voices) {
        for entry in read.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn piper_dir() -> Result<String> {
    Ok(voices_dir().to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_id_splits_multi_dash_names() {
        assert_eq!(parse_id("en_US-amy-medium"), Some(("en_US", "amy", "medium")));
        assert_eq!(
            parse_id("en_US-hfc_female-medium"),
            Some(("en_US", "hfc_female", "medium"))
        );
        assert_eq!(
            parse_id("en_GB-northern_english_male-medium"),
            Some(("en_GB", "northern_english_male", "medium"))
        );
        assert_eq!(parse_id("en_US-ryan-high"), Some(("en_US", "ryan", "high")));
    }

    #[test]
    fn every_catalog_entry_derives_a_valid_url() {
        for (id, _, _) in CATALOG {
            let (locale, name, quality) = parse_id(id).expect("id parses");
            assert!(locale == "en_US" || locale == "en_GB", "locale for {id}");
            assert!(quality == "medium" || quality == "high", "quality for {id}");
            let expected = format!(
                "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/{locale}/{name}/{quality}/{id}.onnx"
            );
            assert_eq!(model_url(id).unwrap(), expected, "model url for {id}");
            assert_eq!(config_url(id).unwrap(), format!("{expected}.json"), "cfg url for {id}");
        }
    }

    #[test]
    fn tricky_names_map_to_exact_urls() {
        assert_eq!(
            model_url("en_US-hfc_female-medium").unwrap(),
            "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx"
        );
        assert_eq!(
            model_url("en_GB-northern_english_male-medium").unwrap(),
            "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx"
        );
        assert_eq!(
            config_url("en_GB-cori-high").unwrap(),
            "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/cori/high/en_GB-cori-high.onnx.json"
        );
    }

    #[test]
    fn display_locale_hyphenates() {
        assert_eq!(display_locale("en_US"), "en-US");
        assert_eq!(display_locale("en_GB"), "en-GB");
    }

    #[test]
    fn safe_id_rejects_traversal() {
        assert!(is_safe_id("en_US-amy-medium"));
        assert!(!is_safe_id("../evil"));
        assert!(!is_safe_id("a/b"));
        assert!(!is_safe_id(""));
        assert!(!is_safe_id("has space"));
    }

    #[test]
    fn json_line_is_valid_and_escaped() {
        let line = json_line(r#"quote " and back\slash"#, r"C:\Users\me\out.part.wav");
        assert!(!line.contains('\n'), "request must be a single physical line");
        let v: serde_json::Value = serde_json::from_str(&line).expect("valid json");
        assert_eq!(v["text"].as_str().unwrap(), r#"quote " and back\slash"#);
        assert_eq!(v["output_file"].as_str().unwrap(), r"C:\Users\me\out.part.wav");
    }

    #[test]
    fn json_line_collapses_newlines() {
        let line = json_line("a\nb\r\nc", r"C:\o.wav");
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        let text = v["text"].as_str().unwrap();
        assert!(!text.contains('\n') && !text.contains('\r'));
        assert_eq!(text, "a b  c"); // each CR and LF becomes one space
    }

    #[test]
    fn ack_matches_exact_lenient_and_rejects() {
        let path = r"C:\cache\audio\x.part.wav";
        assert!(ack_matches("C:\\cache\\audio\\x.part.wav\n", path));
        assert!(ack_matches("  C:\\cache\\audio\\x.part.wav  ", path));
        assert!(ack_matches("Wrote C:\\cache\\audio\\x.part.wav", path)); // substring ack
        assert!(!ack_matches("C:\\cache\\audio\\y.part.wav", path));
        assert!(!ack_matches("", path));
        assert!(!ack_matches("anything", ""));
    }

    #[test]
    fn voice_switch_only_on_change() {
        assert!(!should_switch_voice("en_US-amy-medium", "en_US-amy-medium"));
        assert!(should_switch_voice("en_US-amy-medium", "en_GB-alan-medium"));
    }

    #[test]
    fn idle_expiry_is_strictly_past_ttl() {
        let ttl = Duration::from_secs(60);
        assert!(!is_expired(Duration::from_secs(59), ttl));
        assert!(!is_expired(Duration::from_secs(60), ttl)); // exactly ttl: not yet
        assert!(is_expired(Duration::from_secs(61), ttl));
    }

    /// The engine archive is downloaded, so its entry names are untrusted.
    /// extract_engine's guard is string-based, which means any change to what
    /// the zip crate reports as an entry name could silently disarm it — this
    /// pins the behavior instead of trusting it.
    #[test]
    fn hostile_zip_entries_are_rejected() {
        use std::io::Write as _;
        use zip::write::SimpleFileOptions;

        fn zip_with(name: &str) -> std::path::PathBuf {
            let p = std::env::temp_dir().join(format!("tarot-hostile-{}.zip", uuid::Uuid::new_v4()));
            let mut w = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
            let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            w.start_file(name, opts).unwrap();
            w.write_all(b"payload").unwrap();
            w.finish().unwrap();
            p
        }

        let root = std::env::temp_dir().join(format!("tarot-extract-{}", uuid::Uuid::new_v4()));
        let dest = root.join("dest");
        std::fs::create_dir_all(&dest).unwrap();

        for name in [
            "../escape.txt",
            "a/../../escape.txt",
            "/abs.txt",
            "\\abs.txt",
            "C:\\windows\\evil.txt",
        ] {
            let z = zip_with(name);
            let err = extract_engine(&z, &dest);
            assert!(err.is_err(), "entry {name:?} must be rejected");
            std::fs::remove_file(&z).ok();
        }

        // Nothing escaped the destination.
        assert!(!root.join("escape.txt").exists());
        assert!(!std::env::temp_dir().join("escape.txt").exists());

        // A benign nested entry still extracts where it belongs.
        let good = zip_with("engine/bin/tool.exe");
        extract_engine(&good, &dest).unwrap();
        assert!(dest.join("engine/bin/tool.exe").is_file());
        std::fs::remove_file(&good).ok();

        std::fs::remove_dir_all(&root).ok();
    }

}
