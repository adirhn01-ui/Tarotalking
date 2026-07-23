// OpenAI TTS synthesis. The API key is read from the Windows Credential
// Manager inside this module (provider id "openai") and never leaves Rust —
// never logged, never embedded in an error. Voice catalog is fixed and lives
// in the frontend; only synthesis happens here.

use crate::error::{AppError, Result};
use crate::paths::atomic_write;
use std::io::Read as _;
use std::path::Path;
use std::time::Duration;

const SPEECH_URL: &str = "https://api.openai.com/v1/audio/speech";
const DEFAULT_MODEL: &str = "gpt-4o-mini-tts";
/// Cap on a single synthesized clip; guards against a runaway response.
const MAX_AUDIO: usize = 30 * 1024 * 1024;

fn require_key() -> Result<String> {
    match crate::keys::get_key("openai")? {
        Some(k) => Ok(k),
        None => Err(AppError::msg("Add your OpenAI API key in Settings")),
    }
}

/// OpenAI voice ids are short lowercase names ("alloy", "shimmer", …).
fn is_valid_voice_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 24 && id.bytes().all(|b| b.is_ascii_lowercase())
}

/// Synthesize one sentence to MP3 at `out`. Model comes from the settings
/// field `openaiTtsModel` with a current default.
pub fn synth(voice_id: &str, text: &str, out: &Path) -> Result<()> {
    if !is_valid_voice_id(voice_id) {
        return Err(AppError::msg("OpenAI could not speak this text"));
    }
    let key = require_key()?;
    let model = crate::settings::read_field_str("openaiTtsModel")
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());

    let body = serde_json::json!({
        "model": model,
        "voice": voice_id,
        "input": text,
        "response_format": "mp3",
    })
    .to_string();

    let resp = ureq::post(SPEECH_URL)
        .set("Authorization", &format!("Bearer {key}"))
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(30))
        .send_string(&body);

    let response = match resp {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => {
            return Err(match code {
                401 => AppError::msg("OpenAI rejected this API key"),
                402 | 429 => AppError::msg("OpenAI quota or rate limit reached"),
                400 | 422 => AppError::msg("OpenAI could not speak this text"),
                other => AppError::msg(format!("OpenAI error (HTTP {other})")),
            });
        }
        Err(_) => return Err(AppError::msg("Could not reach OpenAI")),
    };

    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    response
        .into_reader()
        .take((MAX_AUDIO + 1) as u64)
        .read_to_end(&mut buf)
        .map_err(|_| AppError::msg("Could not reach OpenAI"))?;
    if buf.is_empty() {
        return Err(AppError::msg("OpenAI returned no audio"));
    }
    if buf.len() > MAX_AUDIO {
        return Err(AppError::msg("OpenAI audio was too large"));
    }
    atomic_write(out, &buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_id_validation() {
        for ok in ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"] {
            assert!(is_valid_voice_id(ok), "{ok} should be valid");
        }
        assert!(!is_valid_voice_id(""));
        assert!(!is_valid_voice_id("Alloy"), "uppercase rejected");
        assert!(!is_valid_voice_id("has space"));
        assert!(!is_valid_voice_id("../x"));
        assert!(!is_valid_voice_id(&"a".repeat(25)));
    }
}
