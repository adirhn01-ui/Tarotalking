// System (Windows) voices via WinRT Windows.Media.SpeechSynthesis — the
// zero-setup, fully-offline baseline provider. WebView2 exposes no
// speechSynthesis bridge, so synthesis happens here: text in, WAV out,
// played through the same cached-audio pipeline as every other provider.

use super::VoiceInfo;
use crate::error::{AppError, Result};
use std::path::Path;
use windows::core::HSTRING;
use windows::Media::SpeechSynthesis::{SpeechSynthesizer, VoiceGender};
use windows::Storage::Streams::DataReader;

fn wrap(context: &str, e: windows::core::Error) -> AppError {
    AppError::Msg(format!("{context}: {}", e.message()))
}

/// Installed Windows voices, English only (this phase), stable OS ids.
pub fn voices() -> Result<Vec<VoiceInfo>> {
    let all = SpeechSynthesizer::AllVoices().map_err(|e| wrap("Windows voices", e))?;
    let mut out: Vec<VoiceInfo> = Vec::new();
    for v in &all {
        let (Ok(id), Ok(name), Ok(lang)) = (v.Id(), v.DisplayName(), v.Language()) else {
            continue;
        };
        let lang = lang.to_string();
        if !lang.to_ascii_lowercase().starts_with("en") {
            continue;
        }
        let gender = v.Gender().ok().map(|g| {
            if g == VoiceGender::Female { "Female".to_string() } else { "Male".to_string() }
        });
        out.push(VoiceInfo {
            provider: "system".into(),
            id: id.to_string(),
            name: name.to_string().replace("Microsoft ", ""),
            locale: Some(lang),
            gender,
            installed: None,
        });
    }
    out.sort_by(|a, b| a.locale.cmp(&b.locale).then(a.name.cmp(&b.name)));
    Ok(out)
}

/// Synthesize one sentence to WAV at `out` with the given OS voice id.
pub fn synth(voice_id: &str, text: &str, out: &Path) -> Result<()> {
    let synth =
        SpeechSynthesizer::new().map_err(|e| wrap("Windows speech is unavailable", e))?;

    // Select the requested voice; an unknown id falls back to the OS default
    // rather than failing (voices can be uninstalled between sessions).
    if let Ok(all) = SpeechSynthesizer::AllVoices() {
        for v in &all {
            if v.Id().map(|id| id.to_string()).as_deref() == Ok(voice_id) {
                synth
                    .SetVoice(&v)
                    .map_err(|e| wrap("Could not select this Windows voice", e))?;
                break;
            }
        }
    }

    let stream = synth
        .SynthesizeTextToStreamAsync(&HSTRING::from(text))
        .and_then(|op| op.get())
        .map_err(|e| wrap("Windows speech failed", e))?;

    let size = stream.Size().map_err(|e| wrap("Windows speech failed", e))?;
    if size == 0 {
        return Err(AppError::msg("Windows speech returned no audio"));
    }
    let input = stream
        .GetInputStreamAt(0)
        .map_err(|e| wrap("Windows speech failed", e))?;
    let reader =
        DataReader::CreateDataReader(&input).map_err(|e| wrap("Windows speech failed", e))?;
    reader
        .LoadAsync(size as u32)
        .and_then(|op| op.get())
        .map_err(|e| wrap("Windows speech failed", e))?;
    let mut buf = vec![0u8; size as usize];
    reader
        .ReadBytes(&mut buf)
        .map_err(|e| wrap("Windows speech failed", e))?;

    crate::paths::atomic_write(out, &buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exercises the real OS speech stack — run explicitly:
    /// cargo test system_smoke -- --ignored --nocapture
    #[test]
    #[ignore]
    fn system_smoke() {
        let v = voices().expect("voices");
        println!("system voices: {:?}", v.iter().map(|x| &x.name).collect::<Vec<_>>());
        assert!(!v.is_empty(), "no English Windows voices installed");
        let out = std::env::temp_dir().join("tarotalking-system-test.wav");
        synth(&v[0].id, "Hello from Windows speech.", &out).expect("synth");
        let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        println!("wav bytes: {size}");
        assert!(size > 10_000, "suspiciously small wav");
        let _ = std::fs::remove_file(&out);
    }
}

#[tauri::command]
pub async fn system_voices() -> Result<Vec<VoiceInfo>> {
    tauri::async_runtime::spawn_blocking(voices)
        .await
        .map_err(|e| AppError::wrap("Windows voices task", e))?
}
