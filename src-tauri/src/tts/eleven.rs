// ElevenLabs synthesis + voice list. The API key is read from the Windows
// Credential Manager inside this module and NEVER leaves Rust — it is never
// logged and never embedded in an error message.

use super::VoiceInfo;
use crate::error::{AppError, Result};
use crate::paths::atomic_write;
use std::io::Read as _;
use std::path::Path;
use std::time::Duration;

const VOICES_URL: &str = "https://api.elevenlabs.io/v1/voices";
const TTS_BASE: &str = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_MODEL: &str = "eleven_flash_v2_5";
/// Cap on a single synthesized clip; guards against a runaway response.
const MAX_AUDIO: usize = 30 * 1024 * 1024;

/// Read the stored key or fail with an actionable, key-free message.
fn require_key() -> Result<String> {
    match crate::keys::get_key("eleven")? {
        Some(k) => Ok(k),
        None => Err(AppError::msg("Add your ElevenLabs API key in Settings")),
    }
}

/// ElevenLabs voice ids are opaque alphanumeric tokens.
fn is_valid_voice_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn parse_voices(body: &str) -> Result<Vec<VoiceInfo>> {
    let root: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| AppError::msg("ElevenLabs sent an unexpected response"))?;
    let mut voices: Vec<VoiceInfo> = root
        .get("voices")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let id = item.get("voice_id")?.as_str()?.to_string();
                    let name = item
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("Voice")
                        .to_string();
                    Some(VoiceInfo {
                        provider: "eleven".into(),
                        id,
                        name,
                        locale: None,
                        gender: None,
                        installed: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    voices.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(voices)
}

#[tauri::command]
pub async fn eleven_voices() -> Result<Vec<VoiceInfo>> {
    tauri::async_runtime::spawn_blocking(|| {
        let key = require_key()?;
        match ureq::get(VOICES_URL)
            .set("xi-api-key", &key)
            .timeout(Duration::from_secs(20))
            .call()
        {
            Ok(resp) => {
                let body = resp
                    .into_string()
                    .map_err(|_| AppError::msg("Could not reach ElevenLabs"))?;
                parse_voices(&body)
            }
            Err(ureq::Error::Status(401, _)) => {
                Err(AppError::msg("ElevenLabs rejected this API key"))
            }
            Err(ureq::Error::Status(code, _)) => {
                Err(AppError::msg(format!("ElevenLabs error (HTTP {code})")))
            }
            Err(_) => Err(AppError::msg("Could not reach ElevenLabs")),
        }
    })
    .await
    .map_err(|e| AppError::wrap("ElevenLabs voices task", e))?
}

/// Synthesize one sentence to MP3 at `out`. Model comes from the settings
/// field `elevenModel` (settings::read_field_str) with a sensible default.
pub fn synth(voice_id: &str, text: &str, out: &Path) -> Result<()> {
    if !is_valid_voice_id(voice_id) {
        return Err(AppError::msg("ElevenLabs could not speak this text"));
    }
    let key = require_key()?;
    let model = crate::settings::read_field_str("elevenModel")
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());

    // 128 kbps needs no special tier; 96 is the lighter standard option.
    let fmt = if crate::tts::cache::audio_quality() == "standard" {
        "mp3_44100_96"
    } else {
        "mp3_44100_128"
    };
    let url = format!("{TTS_BASE}/{voice_id}?output_format={fmt}");
    let body = serde_json::to_string(&serde_json::json!({
        "text": text,
        "model_id": model,
    }))
    .map_err(|_| AppError::msg("ElevenLabs could not speak this text"))?;

    let resp = ureq::post(&url)
        .set("xi-api-key", &key)
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(30))
        .send_string(&body);

    let response = match resp {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => {
            return Err(match code {
                401 => AppError::msg("ElevenLabs rejected this API key"),
                402 | 429 => AppError::msg("ElevenLabs quota or rate limit reached"),
                422 => AppError::msg("ElevenLabs could not speak this text"),
                other => AppError::msg(format!("ElevenLabs error (HTTP {other})")),
            });
        }
        Err(_) => return Err(AppError::msg("Could not reach ElevenLabs")),
    };

    // Read up to the cap + 1 byte so we can detect an oversized clip.
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    response
        .into_reader()
        .take((MAX_AUDIO + 1) as u64)
        .read_to_end(&mut buf)
        .map_err(|_| AppError::msg("Could not reach ElevenLabs"))?;

    if buf.is_empty() {
        return Err(AppError::msg("ElevenLabs returned no audio"));
    }
    if buf.len() > MAX_AUDIO {
        return Err(AppError::msg("ElevenLabs audio was too large"));
    }
    atomic_write(out, &buf)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_id_validation() {
        assert!(is_valid_voice_id("21m00Tcm4TlvDq8ikWAM"));
        assert!(is_valid_voice_id("EXAVITQu4vr4xnSDxMaL"));
        assert!(is_valid_voice_id("a"));
        assert!(!is_valid_voice_id(""), "empty rejected");
        assert!(!is_valid_voice_id("has-dash"), "non-alphanumeric rejected");
        assert!(!is_valid_voice_id("has space"), "space rejected");
        assert!(!is_valid_voice_id("../etc"), "traversal rejected");
        assert!(!is_valid_voice_id(&"a".repeat(65)), "over 64 chars rejected");
        assert!(is_valid_voice_id(&"a".repeat(64)), "exactly 64 allowed");
    }

    #[test]
    fn parse_voices_extracts_and_sorts() {
        let body = r#"{"voices":[
            {"voice_id":"zzz","name":"Zoe","category":"premade"},
            {"voice_id":"aaa","name":"Adam"},
            {"name":"NoId"}
        ]}"#;
        let voices = parse_voices(body).unwrap();
        assert_eq!(voices.len(), 2, "entries without voice_id are skipped");
        assert_eq!(voices[0].name, "Adam", "sorted by name");
        assert_eq!(voices[0].id, "aaa");
        assert_eq!(voices[0].provider, "eleven");
        assert_eq!(voices[1].name, "Zoe");
    }

    #[test]
    fn parse_voices_tolerates_missing_array() {
        assert!(parse_voices("{}").unwrap().is_empty());
    }
}
