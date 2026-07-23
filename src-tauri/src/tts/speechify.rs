// Speechify TTS (api.speechify.ai) — BYO key, key never leaves Rust.
// POST /v1/audio/speech returns JSON with base64 audio; GET /v1/voices lists
// the catalog. Model: simba-english.

use super::VoiceInfo;
use crate::error::{AppError, Result};
use crate::paths::atomic_write;
use base64::Engine as _;
use std::path::Path;
use std::time::Duration;

const BASE: &str = "https://api.speechify.ai/v1";
const MODEL: &str = "simba-english";

fn require_key() -> Result<String> {
    match crate::keys::get_key("speechify")? {
        Some(k) => Ok(k),
        None => Err(AppError::msg("Add your Speechify API key in Settings")),
    }
}

fn is_valid_voice_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn status_err(code: u16) -> AppError {
    match code {
        401 | 403 => AppError::msg("Speechify rejected this API key"),
        402 | 429 => AppError::msg("Speechify quota or rate limit reached"),
        400 | 422 => AppError::msg("Speechify could not speak this text"),
        other => AppError::msg(format!("Speechify error (HTTP {other})")),
    }
}

pub fn synth(voice_id: &str, text: &str, out: &Path) -> Result<()> {
    if !is_valid_voice_id(voice_id) {
        return Err(AppError::msg("Speechify could not speak this text"));
    }
    let key = require_key()?;
    let body = serde_json::json!({
        "input": text,
        "voice_id": voice_id,
        "model": MODEL,
        "audio_format": "mp3",
    })
    .to_string();

    let resp = match ureq::post(&format!("{BASE}/audio/speech"))
        .set("Authorization", &format!("Bearer {key}"))
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(30))
        .send_string(&body)
    {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => return Err(status_err(code)),
        Err(_) => return Err(AppError::msg("Could not reach Speechify")),
    };

    let json: serde_json::Value = resp
        .into_json()
        .map_err(|_| AppError::msg("Speechify sent an unexpected response"))?;
    let b64 = json
        .get("audio_data")
        .and_then(|a| a.as_str())
        .ok_or_else(|| AppError::msg("Speechify returned no audio"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| AppError::msg("Speechify sent an unexpected response"))?;
    if bytes.is_empty() {
        return Err(AppError::msg("Speechify returned no audio"));
    }
    atomic_write(out, &bytes)
}

fn parse_voices(root: &serde_json::Value) -> Vec<VoiceInfo> {
    // The list may be a bare array or wrapped in {"voices": [...]}.
    let arr = root
        .as_array()
        .or_else(|| root.get("voices").and_then(|v| v.as_array()));
    let mut out: Vec<VoiceInfo> = arr
        .map(|items| {
            items
                .iter()
                .filter_map(|v| {
                    let id = v
                        .get("id")
                        .or_else(|| v.get("voice_id"))
                        .and_then(|x| x.as_str())?;
                    let name = v
                        .get("display_name")
                        .or_else(|| v.get("name"))
                        .and_then(|x| x.as_str())
                        .unwrap_or(id);
                    let locale = v
                        .get("locale")
                        .or_else(|| v.get("language"))
                        .and_then(|x| x.as_str());
                    // English-only phase: keep en-* and unlabeled voices.
                    if let Some(loc) = locale {
                        if !loc.to_ascii_lowercase().starts_with("en") {
                            return None;
                        }
                    }
                    Some(VoiceInfo {
                        provider: "speechify".into(),
                        id: id.to_string(),
                        name: capitalize(name),
                        locale: locale.map(String::from),
                        gender: v.get("gender").and_then(|g| g.as_str()).map(capitalize),
                        installed: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

#[tauri::command]
pub async fn speechify_voices() -> Result<Vec<VoiceInfo>> {
    tauri::async_runtime::spawn_blocking(|| {
        let key = require_key()?;
        match ureq::get(&format!("{BASE}/voices"))
            .set("Authorization", &format!("Bearer {key}"))
            .timeout(Duration::from_secs(20))
            .call()
        {
            Ok(resp) => {
                let root: serde_json::Value = resp
                    .into_json()
                    .map_err(|_| AppError::msg("Speechify sent an unexpected response"))?;
                Ok(parse_voices(&root))
            }
            Err(ureq::Error::Status(code, _)) => Err(status_err(code)),
            Err(_) => Err(AppError::msg("Could not reach Speechify")),
        }
    })
    .await
    .map_err(|e| AppError::wrap("Speechify voices task", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_id_validation() {
        assert!(is_valid_voice_id("george"));
        assert!(is_valid_voice_id("emily-v2_1"));
        assert!(!is_valid_voice_id(""));
        assert!(!is_valid_voice_id("../x"));
        assert!(!is_valid_voice_id("has space"));
        assert!(!is_valid_voice_id(&"a".repeat(65)));
    }

    #[test]
    fn parses_bare_array_and_wrapped_voices() {
        let bare: serde_json::Value =
            serde_json::from_str(r#"[{"id":"george","display_name":"george","locale":"en-US"}]"#)
                .unwrap();
        let v = parse_voices(&bare);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].name, "George");
        assert_eq!(v[0].provider, "speechify");

        let wrapped: serde_json::Value = serde_json::from_str(
            r#"{"voices":[{"voice_id":"carly","name":"carly"},{"voice_id":"fr1","name":"fr","language":"fr-FR"}]}"#,
        )
        .unwrap();
        let v = parse_voices(&wrapped);
        assert_eq!(v.len(), 1, "non-English filtered");
        assert_eq!(v[0].id, "carly");
    }
}
