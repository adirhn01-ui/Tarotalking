// Disk audio cache: xxh3-keyed files under %LOCALAPPDATA%\Tarotalking\cache\audio,
// LRU-pruned to the settings cap. Boundaries live in a .json sidecar.

use super::{SynthResult, WordBoundary};
use crate::error::{AppError, Result};
use crate::paths::{audio_cache_dir, atomic_write, ensure_dir};
use crate::settings::read_field_u64;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use xxhash_rust::xxh3::xxh3_64;

/// Files touched more recently than this are never evicted — they're likely
/// the sentence that's about to play (or its prefetched neighbours).
const PRUNE_GRACE: Duration = Duration::from_secs(120);
/// Default cache cap when settings has no `cacheLimitMB` field.
const DEFAULT_CAP_MB: u64 = 200;

#[derive(Serialize)]
pub struct CacheStats {
    pub bytes: u64,
    pub files: u64,
}

/// Audio file extension for a provider. Unknown providers have no cache slot.
fn ext_for(provider: &str) -> Option<&'static str> {
    match provider {
        "edge" | "eleven" | "openai" | "speechify" | "deepgram" | "cartesia" => Some("mp3"),
        "piper" | "system" => Some("wav"),
        _ => None,
    }
}

/// The user-selected synthesis quality ("standard" | "high"). Part of the
/// cache key so switching quality re-synthesizes instead of serving stale
/// lower-bitrate audio.
pub fn audio_quality() -> String {
    match crate::settings::read_field_str("audioQuality").as_deref() {
        Some("standard") => "standard".to_string(),
        _ => "high".to_string(),
    }
}

/// Stable 16-hex cache key: xxh3_64 of "provider|voice_id|quality|text".
fn cache_key(provider: &str, voice_id: &str, text: &str) -> String {
    let input = format!("{provider}|{voice_id}|{}|{text}", audio_quality());
    format!("{:016x}", xxh3_64(input.as_bytes()))
}

/// Sidecar path for an audio file: `<stem>.bounds.json` (extension-independent,
/// one sidecar per key). The audio file "abc.mp3" → sidecar "abc.bounds.json".
fn sidecar_path(audio_path: &Path) -> PathBuf {
    let stem = audio_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    audio_path.with_file_name(format!("{stem}.bounds.json"))
}

fn is_sidecar(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.ends_with(".bounds.json"))
        .unwrap_or(false)
}

/// Best-effort LRU touch: refresh the audio file's modified time so a cache
/// hit protects it from the next prune. Failure is silently ignored.
fn bump_mtime(path: &Path) {
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = f.set_modified(SystemTime::now());
    }
}

fn load_boundaries(sidecar: &Path) -> Option<Vec<WordBoundary>> {
    let text = std::fs::read_to_string(sidecar).ok()?;
    serde_json::from_str(&text).ok()
}

/// Cache-or-synthesize: the single entry point used by tts_synth.
/// On miss, dispatches to edge/piper/eleven::synth and stores the result.
pub fn synth_via_cache(provider: &str, voice_id: &str, text: &str) -> Result<SynthResult> {
    let ext = ext_for(provider).ok_or_else(|| AppError::msg("Unknown voice provider"))?;
    let dir = audio_cache_dir();
    let key = cache_key(provider, voice_id, text);
    let audio_path = dir.join(format!("{key}.{ext}"));
    let sidecar = sidecar_path(&audio_path);

    // Hit: non-empty audio already on disk.
    if let Ok(meta) = std::fs::metadata(&audio_path) {
        if meta.len() > 0 {
            bump_mtime(&audio_path);
            return Ok(SynthResult {
                path: audio_path.to_string_lossy().into_owned(),
                boundaries: load_boundaries(&sidecar),
            });
        }
    }

    // Miss: synthesize into a STAGING file and promote on success only. A
    // provider killed mid-write (piper timeout, dropped socket) must never
    // leave a truncated file at the real cache path — the hit check only
    // tests non-emptiness, so a partial file there would become a permanent
    // false hit serving corrupt audio for this sentence forever.
    ensure_dir(&dir)?;
    let staging = dir.join(format!("{key}.part.{ext}"));
    let synth_result: Result<Option<Vec<WordBoundary>>> = (|| match provider {
        "edge" => {
            let bounds = crate::tts::edge::synth(voice_id, text, &staging)?;
            Ok(if bounds.is_empty() { None } else { Some(bounds) })
        }
        "piper" => {
            crate::tts::piper::synth(voice_id, text, &staging)?;
            Ok(None)
        }
        "system" => {
            crate::tts::system::synth(voice_id, text, &staging)?;
            Ok(None)
        }
        "eleven" => {
            crate::tts::eleven::synth(voice_id, text, &staging)?;
            Ok(None)
        }
        "openai" => {
            crate::tts::openai::synth(voice_id, text, &staging)?;
            Ok(None)
        }
        "speechify" => {
            crate::tts::speechify::synth(voice_id, text, &staging)?;
            Ok(None)
        }
        "deepgram" => {
            crate::tts::deepgram::synth(voice_id, text, &staging)?;
            Ok(None)
        }
        "cartesia" => {
            crate::tts::cartesia::synth(voice_id, text, &staging)?;
            Ok(None)
        }
        _ => Err(AppError::msg("Unknown voice provider")),
    })();
    let boundaries = match synth_result {
        Ok(b) => b,
        Err(e) => {
            let _ = std::fs::remove_file(&staging);
            return Err(e);
        }
    };
    if audio_path.exists() {
        let _ = std::fs::remove_file(&audio_path);
    }
    std::fs::rename(&staging, &audio_path)?;
    if let Some(bounds) = &boundaries {
        let _ = write_boundaries(&audio_path, bounds);
    }

    // Keep the cache under the configured cap (never touching fresh files).
    let cap_mb = read_field_u64("cacheLimitMB").unwrap_or(DEFAULT_CAP_MB);
    let _ = prune(cap_mb.saturating_mul(1024 * 1024));

    Ok(SynthResult {
        path: audio_path.to_string_lossy().into_owned(),
        boundaries,
    })
}

/// Store boundaries alongside an audio file (sidecar `<file>.bounds.json`).
pub fn write_boundaries(audio_path: &Path, bounds: &[WordBoundary]) -> Result<()> {
    let sidecar = sidecar_path(audio_path);
    let bytes = serde_json::to_vec(bounds)?;
    atomic_write(&sidecar, &bytes)
}

/// Evict oldest-mtime audio files (each with its sidecar) until the total on
/// disk is at or below `max_bytes`. Files modified within the grace window are
/// never removed, so an in-flight sentence is safe even under a tiny cap.
fn prune(max_bytes: u64) -> Result<()> {
    let dir = audio_cache_dir();
    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(()), // no cache dir yet → nothing to prune
    };

    let now = SystemTime::now();
    let mut total: u64 = 0;
    // Audio files only; each carries its sidecar as a unit when evicted.
    let mut audio: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut sidecars: Vec<(PathBuf, u64)> = Vec::new();
    for entry in read.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        total += meta.len();
        let path = entry.path();
        if is_sidecar(&path) {
            sidecars.push((path, meta.len()));
            continue;
        }
        let mtime = meta.modified().unwrap_or(now);
        audio.push((path, meta.len(), mtime));
    }

    // Orphan sidecars (audio deleted, sidecar survived an interruption) are
    // never eviction candidates below, so sweep them here or the cap can
    // become permanently unreachable.
    let audio_stems: std::collections::HashSet<String> = audio
        .iter()
        .filter_map(|(p, ..)| p.file_stem().and_then(|s| s.to_str()).map(str::to_string))
        .collect();
    for (path, size) in &sidecars {
        let owner = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".bounds.json"));
        let orphaned = owner.is_none_or(|stem| !audio_stems.contains(stem));
        if orphaned && std::fs::remove_file(path).is_ok() {
            total = total.saturating_sub(*size);
        }
    }

    if total <= max_bytes {
        return Ok(());
    }

    audio.sort_by_key(|(_, _, mtime)| *mtime); // oldest first
    for (path, size, mtime) in audio {
        if total <= max_bytes {
            break;
        }
        // Skip anything modified within the grace window (or with a future mtime).
        match now.duration_since(mtime) {
            Ok(age) if age >= PRUNE_GRACE => {}
            _ => continue,
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
        let sidecar = sidecar_path(&path);
        if let Ok(meta) = std::fs::metadata(&sidecar) {
            let sidecar_size = meta.len();
            if std::fs::remove_file(&sidecar).is_ok() {
                total = total.saturating_sub(sidecar_size);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn cache_stats() -> Result<CacheStats> {
    let dir = audio_cache_dir();
    let mut bytes = 0u64;
    let mut files = 0u64;
    if let Ok(read) = std::fs::read_dir(&dir) {
        for entry in read.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    bytes += meta.len();
                    files += 1;
                }
            }
        }
    }
    Ok(CacheStats { bytes, files })
}

#[tauri::command]
pub fn cache_clear() -> Result<()> {
    let dir = audio_cache_dir();
    if let Ok(read) = std::fs::read_dir(&dir) {
        for entry in read.flatten() {
            let path = entry.path();
            if path.is_file() {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn cache_prune(max_bytes: u64) -> Result<()> {
    prune(max_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Serialize tests that mutate the process-wide LOCALAPPDATA env var.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn unique_temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("tarot-cache-test-{}", uuid::Uuid::new_v4()))
    }

    fn set_mtime(path: &Path, mtime: SystemTime) {
        let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(mtime).unwrap();
    }

    #[test]
    fn cache_key_is_stable_and_hex() {
        let a = cache_key("edge", "en-US-AriaNeural", "Hello there");
        let b = cache_key("edge", "en-US-AriaNeural", "Hello there");
        assert_eq!(a, b, "same inputs must hash identically");
        assert_eq!(a.len(), 16, "key is 16 hex chars");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn cache_key_varies_by_field() {
        let base = cache_key("edge", "voice", "text");
        assert_ne!(base, cache_key("eleven", "voice", "text"), "provider matters");
        assert_ne!(base, cache_key("edge", "other", "text"), "voice matters");
        assert_ne!(base, cache_key("edge", "voice", "other"), "text matters");
    }

    #[test]
    fn audio_and_sidecar_naming() {
        assert_eq!(ext_for("edge"), Some("mp3"));
        assert_eq!(ext_for("eleven"), Some("mp3"));
        assert_eq!(ext_for("piper"), Some("wav"));
        assert_eq!(ext_for("bogus"), None);

        let audio = Path::new(r"C:\cache\audio\abc123.mp3");
        assert_eq!(sidecar_path(audio).file_name().unwrap(), "abc123.bounds.json");
        let wav = Path::new(r"C:\cache\audio\abc123.wav");
        // One sidecar per key, extension-independent.
        assert_eq!(sidecar_path(wav).file_name().unwrap(), "abc123.bounds.json");
        assert!(is_sidecar(&sidecar_path(audio)));
        assert!(!is_sidecar(audio));
    }

    #[test]
    fn prune_evicts_oldest_first() {
        let _g = ENV_LOCK.lock().unwrap();
        let tmp = unique_temp_dir();
        std::env::set_var("LOCALAPPDATA", &tmp);
        let dir = audio_cache_dir();
        ensure_dir(&dir).unwrap();

        let now = SystemTime::now();
        for (name, age) in [("aaaa.mp3", 600u64), ("bbbb.mp3", 400), ("cccc.mp3", 200)] {
            let p = dir.join(name);
            std::fs::write(&p, vec![0u8; 1000]).unwrap();
            set_mtime(&p, now - Duration::from_secs(age));
        }

        // Total 3000; cap 2500 → oldest (aaaa) evicted, total 2000 ≤ cap, stop.
        prune(2500).unwrap();
        assert!(!dir.join("aaaa.mp3").exists(), "oldest evicted");
        assert!(dir.join("bbbb.mp3").exists());
        assert!(dir.join("cccc.mp3").exists());

        std::env::remove_var("LOCALAPPDATA");
    }

    #[test]
    fn prune_spares_recent_files() {
        let _g = ENV_LOCK.lock().unwrap();
        let tmp = unique_temp_dir();
        std::env::set_var("LOCALAPPDATA", &tmp);
        let dir = audio_cache_dir();
        ensure_dir(&dir).unwrap();

        for name in ["a.mp3", "b.mp3"] {
            std::fs::write(dir.join(name), vec![0u8; 1000]).unwrap();
            // Freshly written → mtime is ~now, inside the grace window.
        }
        prune(500).unwrap(); // way over cap, but everything is fresh
        assert!(dir.join("a.mp3").exists(), "recent files are never evicted");
        assert!(dir.join("b.mp3").exists());

        std::env::remove_var("LOCALAPPDATA");
    }

    #[test]
    fn prune_removes_sidecar_with_audio() {
        let _g = ENV_LOCK.lock().unwrap();
        let tmp = unique_temp_dir();
        std::env::set_var("LOCALAPPDATA", &tmp);
        let dir = audio_cache_dir();
        ensure_dir(&dir).unwrap();

        let audio = dir.join("dead.mp3");
        let sidecar = dir.join("dead.bounds.json");
        std::fs::write(&audio, vec![0u8; 2000]).unwrap();
        std::fs::write(&sidecar, b"[]").unwrap();
        let old = SystemTime::now() - Duration::from_secs(500);
        set_mtime(&audio, old);
        set_mtime(&sidecar, old);

        prune(100).unwrap();
        assert!(!audio.exists(), "audio evicted");
        assert!(!sidecar.exists(), "sidecar evicted with its audio");

        std::env::remove_var("LOCALAPPDATA");
    }

    #[test]
    fn write_and_reload_boundaries_roundtrip() {
        let _g = ENV_LOCK.lock().unwrap();
        let tmp = unique_temp_dir();
        std::env::set_var("LOCALAPPDATA", &tmp);
        let dir = audio_cache_dir();
        ensure_dir(&dir).unwrap();

        let audio = dir.join("round.mp3");
        std::fs::write(&audio, b"fake").unwrap();
        let bounds = vec![WordBoundary {
            offset_ms: 120,
            char_start: 0,
            char_len: 5,
            text: "Hello".into(),
        }];
        write_boundaries(&audio, &bounds).unwrap();
        let loaded = load_boundaries(&sidecar_path(&audio)).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].text, "Hello");
        assert_eq!(loaded[0].char_len, 5);

        std::env::remove_var("LOCALAPPDATA");
    }
}
