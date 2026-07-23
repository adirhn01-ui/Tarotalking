// Cartesia Sonic TTS — BYO key, key never leaves Rust. POST /tts/bytes with
// X-API-Key + Cartesia-Version returns raw audio bytes; GET /voices lists the
// catalog (voice ids are UUIDs).

use super::VoiceInfo;
use crate::error::{AppError, Result};
use crate::paths::atomic_write;
use std::io::Read as _;
use std::path::Path;
use std::time::Duration;

const BASE: &str = "https://api.cartesia.ai";
const VERSION: &str = "2024-11-13";
const MODEL: &str = "sonic-2";
const MAX_AUDIO: usize = 30 * 1024 * 1024;

fn require_key() -> Result<String> {
    match crate::keys::get_key("cartesia")? {
        Some(k) => Ok(k),
        None => Err(AppError::msg("Add your Cartesia API key in Settings")),
    }
}

/// Cartesia voice ids are UUID-shaped.
fn is_valid_voice_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

fn status_err(code: u16) -> AppError {
    match code {
        401 | 403 => AppError::msg("Cartesia rejected this API key"),
        402 | 429 => AppError::msg("Cartesia quota or rate limit reached"),
        400 | 422 => AppError::msg("Cartesia could not speak this text"),
        other => AppError::msg(format!("Cartesia error (HTTP {other})")),
    }
}

pub fn synth(voice_id: &str, text: &str, out: &Path) -> Result<()> {
    if !is_valid_voice_id(voice_id) {
        return Err(AppError::msg("Cartesia could not speak this text"));
    }
    let key = require_key()?;
    let body = serde_json::json!({
        "model_id": MODEL,
        "transcript": text,
        "voice": { "mode": "id", "id": voice_id },
        "language": "en",
        "output_format": { "container": "mp3", "bit_rate": 128000, "sample_rate": 44100 },
    })
    .to_string();

    let resp = match ureq::post(&format!("{BASE}/tts/bytes"))
        .set("X-API-Key", &key)
        .set("Cartesia-Version", VERSION)
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(30))
        .send_string(&body)
    {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => return Err(status_err(code)),
        Err(_) => return Err(AppError::msg("Could not reach Cartesia")),
    };

    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    resp.into_reader()
        .take((MAX_AUDIO + 1) as u64)
        .read_to_end(&mut buf)
        .map_err(|_| AppError::msg("Could not reach Cartesia"))?;
    if buf.is_empty() {
        return Err(AppError::msg("Cartesia returned no audio"));
    }
    if buf.len() > MAX_AUDIO {
        return Err(AppError::msg("Cartesia audio was too large"));
    }
    atomic_write(out, &buf)
}

fn parse_voices(root: &serde_json::Value) -> Vec<VoiceInfo> {
    // Bare array or {"data": [...]} (paged shape).
    let arr = root
        .as_array()
        .or_else(|| root.get("data").and_then(|v| v.as_array()));
    let mut out: Vec<VoiceInfo> = arr
        .map(|items| {
            items
                .iter()
                .filter_map(|v| {
                    let id = v.get("id").and_then(|x| x.as_str())?;
                    if !is_valid_voice_id(id) {
                        return None;
                    }
                    let lang = v.get("language").and_then(|x| x.as_str());
                    if let Some(l) = lang {
                        if !l.to_ascii_lowercase().starts_with("en") {
                            return None;
                        }
                    }
                    Some(VoiceInfo {
                        provider: "cartesia".into(),
                        id: id.to_string(),
                        name: v
                            .get("name")
                            .and_then(|x| x.as_str())
                            .unwrap_or("Voice")
                            .to_string(),
                        locale: lang.map(String::from),
                        gender: v.get("gender").and_then(|g| g.as_str()).map(String::from),
                        installed: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[tauri::command]
pub async fn cartesia_voices() -> Result<Vec<VoiceInfo>> {
    tauri::async_runtime::spawn_blocking(|| {
        let key = require_key()?;
        match ureq::get(&format!("{BASE}/voices"))
            .set("X-API-Key", &key)
            .set("Cartesia-Version", VERSION)
            .timeout(Duration::from_secs(20))
            .call()
        {
            Ok(resp) => {
                let root: serde_json::Value = resp
                    .into_json()
                    .map_err(|_| AppError::msg("Cartesia sent an unexpected response"))?;
                Ok(parse_voices(&root))
            }
            Err(ureq::Error::Status(code, _)) => Err(status_err(code)),
            Err(_) => Err(AppError::msg("Could not reach Cartesia")),
        }
    })
    .await
    .map_err(|e| AppError::wrap("Cartesia voices task", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_validation() {
        assert!(is_valid_voice_id("694f9389-aac1-45b6-b726-9d9369183238"));
        assert!(!is_valid_voice_id("not-a-uuid"));
        assert!(!is_valid_voice_id(""));
        assert!(!is_valid_voice_id("694f9389aac145b6b7269d9369183238"));
    }

    #[test]
    fn parses_data_wrapped_voices_and_filters_language() {
        let wrapped: serde_json::Value = serde_json::from_str(
            r#"{"data":[
                {"id":"694f9389-aac1-45b6-b726-9d9369183238","name":"Ava","language":"en"},
                {"id":"794f9389-aac1-45b6-b726-9d9369183238","name":"Chloé","language":"fr"}
            ]}"#,
        )
        .unwrap();
        let v = parse_voices(&wrapped);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].name, "Ava");
    }
}
