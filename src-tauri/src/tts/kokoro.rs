// Kokoro local voices via sherpa-onnx — the second fully-offline neural
// engine, a clear quality step up from Piper. One model bundle serves all
// voices (~330 MB); the engine is the sherpa-onnx offline-tts CLI (~25 MB
// download, MT build: no VC++ runtime needed). Same spawned-process pattern
// as Piper: WAV per sentence into the shared cache.

use super::VoiceInfo;
use crate::error::{AppError, Result};
use crate::paths::{ensure_dir, voices_dir};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const ENGINE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-win-x64-shared-MT-Release.tar.bz2";
const ENGINE_ARCHIVE: &str = "sherpa-onnx-v1.13.4-win-x64-shared-MT-Release.tar.bz2";
/// The archive's top-level directory (renamed to a stable name on install).
const ENGINE_EXTRACTED_DIR: &str = "sherpa-onnx-v1.13.4-win-x64-shared-MT-Release";
const ENGINE_SIZE_MB: u32 = 25;

const MODEL_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2";
const MODEL_ARCHIVE: &str = "kokoro-en-v0_19.tar.bz2";
const MODEL_EXTRACTED_DIR: &str = "kokoro-en-v0_19";
const MODEL_SIZE_MB: u32 = 330;

const SYNTH_TIMEOUT: Duration = Duration::from_secs(120);

/// Kokoro v0.19 speakers: (voice id, display name, sherpa speaker id, gender).
pub const CATALOG: &[(&str, &str, u32, &str)] = &[
    ("af_default", "Aria (US)", 0, "Female"),
    ("af_bella", "Bella (US)", 1, "Female"),
    ("af_nicole", "Nicole (US)", 2, "Female"),
    ("af_sarah", "Sarah (US)", 3, "Female"),
    ("af_sky", "Sky (US)", 4, "Female"),
    ("am_adam", "Adam (US)", 5, "Male"),
    ("am_michael", "Michael (US)", 6, "Male"),
    ("bf_emma", "Emma (UK)", 7, "Female"),
    ("bf_isabella", "Isabella (UK)", 8, "Female"),
    ("bm_george", "George (UK)", 9, "Male"),
    ("bm_lewis", "Lewis (UK)", 10, "Male"),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KokoroVoice {
    pub id: String,
    pub name: String,
    pub gender: String,
    pub locale: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KokoroStatus {
    pub engine_installed: bool,
    #[serde(rename = "engineSizeMB")]
    pub engine_size_mb: u32,
    pub model_installed: bool,
    #[serde(rename = "modelSizeMB")]
    pub model_size_mb: u32,
    pub voices: Vec<KokoroVoice>,
}

fn kokoro_root() -> PathBuf {
    voices_dir().join("kokoro")
}

fn engine_dir() -> PathBuf {
    kokoro_root().join("engine")
}

fn engine_exe() -> PathBuf {
    engine_dir().join("bin").join("sherpa-onnx-offline-tts.exe")
}

fn model_dir() -> PathBuf {
    kokoro_root().join(MODEL_EXTRACTED_DIR)
}

fn model_installed() -> bool {
    let d = model_dir();
    std::fs::metadata(d.join("model.onnx")).map(|m| m.len() > 0).unwrap_or(false)
        && d.join("voices.bin").exists()
        && d.join("tokens.txt").exists()
}

fn sid_for(voice_id: &str) -> Option<u32> {
    CATALOG.iter().find(|(id, ..)| *id == voice_id).map(|(_, _, sid, _)| *sid)
}

/// Extract a .tar.bz2 with the OS bsdtar (ships with Windows 10 1803+).
/// Args as an array — never a shell string.
fn extract_tar_bz2(archive: &Path, dest: &Path) -> Result<()> {
    ensure_dir(dest)?;
    let mut cmd = Command::new("tar");
    cmd.arg("-xjf")
        .arg(archive)
        .arg("-C")
        .arg(dest)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let status = cmd
        .status()
        .map_err(|_| AppError::msg("Could not unpack the download (tar unavailable)"))?;
    if !status.success() {
        return Err(AppError::msg("Could not unpack the download"));
    }
    Ok(())
}

#[tauri::command]
pub async fn kokoro_status() -> Result<KokoroStatus> {
    tauri::async_runtime::spawn_blocking(|| {
        Ok(KokoroStatus {
            engine_installed: engine_exe().exists(),
            engine_size_mb: ENGINE_SIZE_MB,
            model_installed: model_installed(),
            model_size_mb: MODEL_SIZE_MB,
            voices: CATALOG
                .iter()
                .map(|(id, name, _, gender)| KokoroVoice {
                    id: (*id).to_string(),
                    name: (*name).to_string(),
                    gender: (*gender).to_string(),
                    locale: if id.starts_with('b') { "en-GB" } else { "en-US" }.to_string(),
                })
                .collect(),
        })
    })
    .await
    .map_err(|e| AppError::wrap("Kokoro status task", e))?
}

#[tauri::command]
pub async fn kokoro_install_engine(app: AppHandle) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        if engine_exe().exists() {
            return Ok(());
        }
        let root = kokoro_root();
        ensure_dir(&root)?;
        let archive = root.join(ENGINE_ARCHIVE);
        crate::downloads::download_with_progress(
            &app,
            "kokoro-engine",
            "Kokoro engine",
            ENGINE_URL,
            &archive,
        )?;
        extract_tar_bz2(&archive, &root)?;
        let _ = std::fs::remove_file(&archive);
        // Stable path: rename the versioned top-level dir to "engine".
        let extracted = root.join(ENGINE_EXTRACTED_DIR);
        if extracted.exists() {
            let _ = std::fs::remove_dir_all(engine_dir());
            std::fs::rename(&extracted, engine_dir())
                .map_err(|e| AppError::wrap("Could not finish the engine install", e))?;
        }
        if !engine_exe().exists() {
            return Err(AppError::msg("The Kokoro engine download looked incomplete"));
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::wrap("Install task", e))?
}

#[tauri::command]
pub async fn kokoro_install_model(app: AppHandle) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        if model_installed() {
            return Ok(());
        }
        let root = kokoro_root();
        ensure_dir(&root)?;
        let archive = root.join(MODEL_ARCHIVE);
        crate::downloads::download_with_progress(
            &app,
            "kokoro-model",
            "Kokoro voices",
            MODEL_URL,
            &archive,
        )?;
        extract_tar_bz2(&archive, &root)?;
        let _ = std::fs::remove_file(&archive);
        if !model_installed() {
            return Err(AppError::msg("The Kokoro voices download looked incomplete"));
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::wrap("Install task", e))?
}

#[tauri::command]
pub async fn kokoro_remove() -> Result<()> {
    tauri::async_runtime::spawn_blocking(|| {
        match std::fs::remove_dir_all(kokoro_root()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::wrap("Could not remove Kokoro", e)),
        }
    })
    .await
    .map_err(|e| AppError::wrap("Remove task", e))?
}

/// Synthesize one sentence to WAV at `out`.
pub fn synth(voice_id: &str, text: &str, out: &Path) -> Result<()> {
    let Some(sid) = sid_for(voice_id) else {
        return Err(AppError::msg("This Kokoro voice is not available"));
    };
    let exe = engine_exe();
    if !exe.exists() {
        return Err(AppError::msg("The Kokoro engine is not installed"));
    }
    if !model_installed() {
        return Err(AppError::msg("The Kokoro voices are not downloaded"));
    }
    if let Some(parent) = out.parent() {
        ensure_dir(parent)?;
    }

    let m = model_dir();
    let mut cmd = Command::new(&exe);
    cmd.arg(format!("--kokoro-model={}", m.join("model.onnx").display()))
        .arg(format!("--kokoro-voices={}", m.join("voices.bin").display()))
        .arg(format!("--kokoro-tokens={}", m.join("tokens.txt").display()))
        .arg(format!("--kokoro-data-dir={}", m.join("espeak-ng-data").display()))
        .arg("--num-threads=4")
        .arg(format!("--sid={sid}"))
        .arg(format!("--output-filename={}", out.display()))
        .arg(text.replace(['\r', '\n'], " "))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|_| AppError::msg("The Kokoro voice failed to start"))?;
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() > SYNTH_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AppError::msg("The Kokoro voice timed out"));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::msg("The Kokoro voice failed to speak this sentence"));
            }
        }
    };
    let ok = status.success()
        && std::fs::metadata(out).map(|meta| meta.len() > 44).unwrap_or(false);
    if !ok {
        let _ = std::fs::remove_file(out);
        return Err(AppError::msg("The Kokoro voice failed to speak this sentence"));
    }
    Ok(())
}

/// Installed voices as VoiceInfo entries for the provider layer.
pub fn installed_voices() -> Vec<VoiceInfo> {
    if !(engine_exe().exists() && model_installed()) {
        return Vec::new();
    }
    CATALOG
        .iter()
        .map(|(id, name, _, gender)| VoiceInfo {
            provider: "kokoro".into(),
            id: (*id).to_string(),
            name: (*name).to_string(),
            locale: Some(if id.starts_with('b') { "en-GB" } else { "en-US" }.to_string()),
            gender: Some((*gender).to_string()),
            installed: Some(true),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_sids_are_unique_and_wellformed() {
        let mut sids: Vec<u32> = CATALOG.iter().map(|(_, _, sid, _)| *sid).collect();
        sids.sort_unstable();
        sids.dedup();
        assert_eq!(sids.len(), CATALOG.len(), "duplicate sherpa speaker ids");
        for (id, name, _, gender) in CATALOG {
            assert!(id.starts_with("af_") || id.starts_with("am_") || id.starts_with("bf_") || id.starts_with("bm_"));
            assert!(!name.is_empty());
            assert!(*gender == "Male" || *gender == "Female");
        }
        assert_eq!(sid_for("af_bella"), Some(1));
        assert_eq!(sid_for("nope"), None);
    }
}
