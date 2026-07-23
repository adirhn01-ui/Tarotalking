// Deepgram Aura TTS — BYO key, key never leaves Rust. POST /v1/speak with
// ?model=aura-2-{name}-en returns raw audio bytes (mp3). The voice catalog is
// a fixed model list (no listing endpoint needed). 2000-char request cap per
// Deepgram — our per-sentence synthesis stays far under it.

use crate::error::{AppError, Result};
use crate::paths::atomic_write;
use std::io::Read as _;
use std::path::Path;
use std::time::Duration;

const SPEAK_URL: &str = "https://api.deepgram.com/v1/speak";
const MAX_AUDIO: usize = 30 * 1024 * 1024;

/// Curated Aura-2 English voices: (model id, display name, gender).
pub const CATALOG: &[(&str, &str, &str)] = &[
    ("aura-2-thalia-en", "Thalia", "Female"),
    ("aura-2-asteria-en", "Asteria", "Female"),
    ("aura-2-luna-en", "Luna", "Female"),
    ("aura-2-athena-en", "Athena", "Female"),
    ("aura-2-hera-en", "Hera", "Female"),
    ("aura-2-andromeda-en", "Andromeda", "Female"),
    ("aura-2-orion-en", "Orion", "Male"),
    ("aura-2-arcas-en", "Arcas", "Male"),
    ("aura-2-apollo-en", "Apollo", "Male"),
    ("aura-2-atlas-en", "Atlas", "Male"),
    ("aura-2-zeus-en", "Zeus", "Male"),
    ("aura-2-draco-en", "Draco", "Male"),
];

fn require_key() -> Result<String> {
    match crate::keys::get_key("deepgram")? {
        Some(k) => Ok(k),
        None => Err(AppError::msg("Add your Deepgram API key in Settings")),
    }
}

fn in_catalog(id: &str) -> bool {
    CATALOG.iter().any(|(cid, ..)| *cid == id)
}

pub fn synth(voice_id: &str, text: &str, out: &Path) -> Result<()> {
    if !in_catalog(voice_id) {
        return Err(AppError::msg("Deepgram could not speak this text"));
    }
    let key = require_key()?;
    let body = serde_json::json!({ "text": text }).to_string();

    let resp = match ureq::post(&format!("{SPEAK_URL}?model={voice_id}"))
        .set("Authorization", &format!("Token {key}"))
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(30))
        .send_string(&body)
    {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => {
            return Err(match code {
                401 | 403 => AppError::msg("Deepgram rejected this API key"),
                402 | 429 => AppError::msg("Deepgram quota or rate limit reached"),
                400 | 422 => AppError::msg("Deepgram could not speak this text"),
                other => AppError::msg(format!("Deepgram error (HTTP {other})")),
            });
        }
        Err(_) => return Err(AppError::msg("Could not reach Deepgram")),
    };

    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    resp.into_reader()
        .take((MAX_AUDIO + 1) as u64)
        .read_to_end(&mut buf)
        .map_err(|_| AppError::msg("Could not reach Deepgram"))?;
    if buf.is_empty() {
        return Err(AppError::msg("Deepgram returned no audio"));
    }
    if buf.len() > MAX_AUDIO {
        return Err(AppError::msg("Deepgram audio was too large"));
    }
    atomic_write(out, &buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_are_wellformed() {
        for (id, name, gender) in CATALOG {
            assert!(id.starts_with("aura-2-") && id.ends_with("-en"), "{id}");
            assert!(!name.is_empty());
            assert!(*gender == "Male" || *gender == "Female");
        }
        assert!(in_catalog("aura-2-thalia-en"));
        assert!(!in_catalog("aura-2-notreal-en"));
        assert!(!in_catalog("../x"));
    }
}
