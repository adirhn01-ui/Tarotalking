// Piper local voices: curated model catalog, binary + model downloads with
// progress, process-spawn synthesis to WAV.

use super::VoiceInfo;
use crate::error::{AppError, Result};
use crate::paths::{ensure_dir, voices_dir};
use serde::Serialize;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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

/// Synthesize one sentence to WAV at `out` using an installed model.
pub fn synth(voice_id: &str, text: &str, out: &Path) -> Result<()> {
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

#[tauri::command]
pub async fn piper_install_binary(app: AppHandle) -> Result<()> {
    if piper_exe().exists() {
        return Ok(());
    }
    let voices = voices_dir();
    ensure_dir(&voices)?;
    let zip_path = voices.join("piper_windows_amd64.zip");
    crate::downloads::download_with_progress(
        &app,
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
    if !catalog_has(&model_id) {
        return Err(AppError::msg("Unknown voice"));
    }
    let label = CATALOG
        .iter()
        .find(|(id, ..)| *id == model_id)
        .map(|(_, name, _)| *name)
        .unwrap_or("Local voice");
    let onnx_url = model_url(&model_id).ok_or_else(|| AppError::msg("Unknown voice"))?;
    let cfg_url = config_url(&model_id).ok_or_else(|| AppError::msg("Unknown voice"))?;

    ensure_dir(&voices_dir())?;
    crate::downloads::download_with_progress(
        &app,
        &format!("piper-model-{model_id}"),
        label,
        &onnx_url,
        &model_path(&model_id),
    )?;
    crate::downloads::download_with_progress(
        &app,
        &format!("piper-model-{model_id}-cfg"),
        label,
        &cfg_url,
        &config_path(&model_id),
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
}
