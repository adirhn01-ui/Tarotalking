// Microsoft Edge read-aloud voices, spoken over the consumer WebSocket
// endpoint Edge itself uses — no Edge process involved. Free neural voices;
// requires internet.
//
// Protocol notes:
// - The endpoint gates on a Sec-MS-GEC token: SHA-256 of (Windows file time
//   rounded down to 5 minutes ++ trusted client token), uppercase hex.
// - One synthesis = one WS connection: send speech.config, then an SSML
//   message; receive JSON metadata frames (word boundaries) and binary audio
//   frames (2-byte BE header length prefix) until turn.end.
// - Word-boundary offsets are in 100 ns ticks from audio start.

use super::{VoiceInfo, WordBoundary};
use crate::error::{AppError, Result};
use sha2::{Digest, Sha256};
use std::io::Write as _;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tungstenite::client::IntoClientRequest;
use tungstenite::Message;

const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
// Must track a current Edge release: the service rejects stale client
// versions (and handshakes without a muid cookie) with 403.
const CHROMIUM_FULL_VERSION: &str = "143.0.3650.75";
const WSS_BASE: &str =
    "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const VOICES_URL: &str =
    "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list";
const OUTPUT_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";

/// Random per-connection browser id the service expects as a `muid` cookie.
fn muid_cookie() -> String {
    let mut hex = String::with_capacity(38);
    hex.push_str("muid=");
    for b in uuid::Uuid::new_v4().as_bytes() {
        hex.push_str(&format!("{b:02X}"));
    }
    hex.push(';');
    hex
}

/// Sec-MS-GEC: SHA-256(uppercase hex) of Windows-file-time ticks (100 ns since
/// 1601-01-01) floored to a 5-minute boundary, concatenated with the token.
fn sec_ms_gec() -> String {
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let win_secs = (unix + 11_644_473_600) / 300 * 300;
    let ticks = win_secs * 10_000_000;
    let mut hasher = Sha256::new();
    hasher.update(format!("{ticks}{TRUSTED_CLIENT_TOKEN}"));
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02X}"));
    }
    out
}

fn timestamp() -> String {
    // The service only checks the shape of this header, not the clock.
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = unix / 86_400;
    let secs = unix % 86_400;
    format!(
        "Day{} {:02}:{:02}:{:02} GMT+0000 (Coordinated Universal Time)",
        days,
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&apos;")
        .replace('"', "&quot;")
}

fn offline(e: impl std::fmt::Display) -> AppError {
    AppError::Msg(format!("Edge voices are unavailable (check your internet connection): {e}"))
}

/// Synthesize one sentence to MP3 at `out`; returns word boundaries.
pub fn synth(voice_id: &str, text: &str, out: &Path) -> Result<Vec<WordBoundary>> {
    // One retry: a 5-minute GEC window can expire between token and handshake.
    match synth_once(voice_id, text, out) {
        Ok(b) => Ok(b),
        Err(_) => synth_once(voice_id, text, out),
    }
}

fn synth_once(voice_id: &str, text: &str, out: &Path) -> Result<Vec<WordBoundary>> {
    if !voice_id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(AppError::msg("Invalid Edge voice id"));
    }
    let connection_id = uuid::Uuid::new_v4().simple().to_string();
    let url = format!(
        "{WSS_BASE}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={}&Sec-MS-GEC-Version=1-{CHROMIUM_FULL_VERSION}&ConnectionId={connection_id}",
        sec_ms_gec()
    );

    let mut request = url
        .into_client_request()
        .map_err(|e| AppError::wrap("Edge request", e))?;
    let headers = request.headers_mut();
    headers.insert("Pragma", "no-cache".parse().unwrap());
    headers.insert("Cache-Control", "no-cache".parse().unwrap());
    headers.insert(
        "Origin",
        "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold".parse().unwrap(),
    );
    headers.insert("Accept-Language", "en-US,en;q=0.9".parse().unwrap());
    headers.insert("Accept-Encoding", "gzip, deflate, br, zstd".parse().unwrap());
    headers.insert("User-Agent", UA.parse().unwrap());
    headers.insert("Cookie", muid_cookie().parse().unwrap());

    let (mut socket, _resp) = tungstenite::connect(request).map_err(offline)?;

    // Keep a hung server from stalling playback forever.
    if let tungstenite::stream::MaybeTlsStream::Rustls(stream) = socket.get_mut() {
        let _ = stream.sock.set_read_timeout(Some(Duration::from_secs(20)));
    }

    let ts = timestamp();
    let config = format!(
        "X-Timestamp:{ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n\
        {{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"true\"}},\"outputFormat\":\"{OUTPUT_FORMAT}\"}}}}}}}}"
    );
    socket.send(Message::text(config)).map_err(offline)?;

    let ssml = format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>\
         <voice name='{voice_id}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>{}</prosody></voice></speak>",
        escape_xml(text)
    );
    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let ssml_msg = format!(
        "X-RequestId:{request_id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{ts}Z\r\nPath:ssml\r\n\r\n{ssml}"
    );
    socket.send(Message::text(ssml_msg)).map_err(offline)?;

    let mut audio: Vec<u8> = Vec::with_capacity(32 * 1024);
    let mut boundaries: Vec<WordBoundary> = Vec::new();
    // Sequential word→char mapping cursor into the source sentence.
    let mut char_cursor = 0usize;

    loop {
        let msg = socket.read().map_err(offline)?;
        match msg {
            Message::Text(t) => {
                if t.contains("Path:turn.end") {
                    break;
                }
                if t.contains("Path:audio.metadata") {
                    if let Some(body_at) = t.find("\r\n\r\n") {
                        parse_metadata(&t[body_at + 4..], text, &mut char_cursor, &mut boundaries);
                    }
                }
            }
            Message::Binary(data) => {
                if data.len() < 2 {
                    continue;
                }
                let header_len = u16::from_be_bytes([data[0], data[1]]) as usize;
                if data.len() < 2 + header_len {
                    continue;
                }
                let header = String::from_utf8_lossy(&data[2..2 + header_len]);
                if header.contains("Path:audio") {
                    audio.extend_from_slice(&data[2 + header_len..]);
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    if audio.is_empty() {
        return Err(AppError::msg("Edge returned no audio for this sentence"));
    }
    if let Some(parent) = out.parent() {
        crate::paths::ensure_dir(parent)?;
    }
    let mut f = std::fs::File::create(out)?;
    f.write_all(&audio)?;
    Ok(boundaries)
}

/// Pull WordBoundary entries out of an audio.metadata JSON body and map each
/// spoken word to its char range in the source sentence (sequential search —
/// the service reports words in order).
fn parse_metadata(
    body: &str,
    source: &str,
    char_cursor: &mut usize,
    out: &mut Vec<WordBoundary>,
) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return;
    };
    let Some(items) = v.get("Metadata").and_then(|m| m.as_array()) else {
        return;
    };
    for item in items {
        if item.get("Type").and_then(|t| t.as_str()) != Some("WordBoundary") {
            continue;
        }
        let Some(data) = item.get("Data") else { continue };
        let offset_ticks = data.get("Offset").and_then(|o| o.as_u64()).unwrap_or(0);
        let word = data
            .get("text")
            .and_then(|t| t.get("Text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        if word.is_empty() {
            continue;
        }
        // The cursor walks BYTE offsets (cheap find), but the frontend slices
        // JS strings, which index by UTF-16 code units — convert at the edge
        // so highlights stay exact on smart quotes/em-dashes/accents.
        let (char_start, char_len) = match source[*char_cursor..].find(word) {
            Some(rel) => {
                let byte_start = *char_cursor + rel;
                *char_cursor = byte_start + word.len();
                let utf16_start = source[..byte_start].encode_utf16().count();
                let utf16_len = word.encode_utf16().count();
                (utf16_start, utf16_len)
            }
            None => (0, 0), // unmatched: frontend ignores zero-length
        };
        out.push(WordBoundary {
            offset_ms: (offset_ticks / 10_000) as u32,
            char_start: char_start as u32,
            char_len: char_len as u32,
            text: word.to_string(),
        });
    }
}

/* ================= voice list ================= */

static VOICES_MEM: OnceLock<Mutex<Option<Vec<VoiceInfo>>>> = OnceLock::new();

fn voices_cache_path() -> std::path::PathBuf {
    crate::paths::localdata_dir().join("cache").join("edge-voices.json")
}

/// Short display name from a ShortName like "en-US-AriaNeural" →
/// "Aria" / "Emma Multilingual".
fn display_name(short_name: &str) -> String {
    let base = short_name
        .rsplit('-')
        .next()
        .unwrap_or(short_name)
        .trim_end_matches("Neural");
    // Split camel case: "EmmaMultilingual" → "Emma Multilingual"
    let mut out = String::with_capacity(base.len() + 4);
    for (i, c) in base.chars().enumerate() {
        if i > 0 && c.is_ascii_uppercase() {
            out.push(' ');
        }
        out.push(c);
    }
    out
}

fn fetch_voices() -> Result<Vec<VoiceInfo>> {
    let url = format!(
        "{VOICES_URL}?trustedclienttoken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={}&Sec-MS-GEC-Version=1-{CHROMIUM_FULL_VERSION}",
        sec_ms_gec()
    );
    let body: String = ureq::get(&url)
        .set("User-Agent", UA)
        .set("Accept-Language", "en-US,en;q=0.9")
        .timeout(Duration::from_secs(15))
        .call()
        .map_err(offline)?
        .into_string()
        .map_err(offline)?;
    let raw: Vec<serde_json::Value> =
        serde_json::from_str(&body).map_err(|e| AppError::wrap("Edge voice list", e))?;
    let mut voices: Vec<VoiceInfo> = raw
        .iter()
        .filter_map(|v| {
            let short = v.get("ShortName")?.as_str()?;
            let locale = v.get("Locale")?.as_str()?;
            // English-only phase.
            if !locale.starts_with("en-") {
                return None;
            }
            Some(VoiceInfo {
                provider: "edge".into(),
                id: short.to_string(),
                name: display_name(short),
                locale: Some(locale.to_string()),
                gender: v.get("Gender").and_then(|g| g.as_str()).map(String::from),
                installed: None,
            })
        })
        .collect();
    voices.sort_by(|a, b| a.locale.cmp(&b.locale).then(a.name.cmp(&b.name)));
    Ok(voices)
}

#[cfg(test)]
mod net_tests {
    use super::*;

    /// Handshake variation matrix — isolates which part the server rejects.
    #[test]
    #[ignore]
    fn edge_net_handshake_matrix() {
        let gec = sec_ms_gec();
        let conn = uuid::Uuid::new_v4().simple().to_string();
        let variants: Vec<(&str, String, Vec<(&str, &str)>)> = vec![
            (
                "bare (no extra headers)",
                format!("{WSS_BASE}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={gec}&Sec-MS-GEC-Version=1-131.0.2903.99&ConnectionId={conn}"),
                vec![],
            ),
            (
                "UA only",
                format!("{WSS_BASE}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={gec}&Sec-MS-GEC-Version=1-131.0.2903.99&ConnectionId={conn}"),
                vec![("User-Agent", UA)],
            ),
            (
                "full current set",
                format!("{WSS_BASE}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={gec}&Sec-MS-GEC-Version=1-131.0.2903.99&ConnectionId={conn}"),
                vec![
                    ("User-Agent", UA),
                    ("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"),
                    ("Pragma", "no-cache"),
                    ("Cache-Control", "no-cache"),
                    ("Accept-Language", "en-US,en;q=0.9"),
                ],
            ),
            (
                "no GEC at all",
                format!("{WSS_BASE}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&ConnectionId={conn}"),
                vec![("User-Agent", UA)],
            ),
        ];
        for (label, url, headers) in variants {
            let mut req = url.into_client_request().unwrap();
            for (k, v) in headers {
                req.headers_mut().insert(k, v.parse().unwrap());
            }
            match tungstenite::connect(req) {
                Ok(_) => println!("[{label}] CONNECTED"),
                Err(tungstenite::Error::Http(resp)) => {
                    let body = resp
                        .body()
                        .as_ref()
                        .map(|b| String::from_utf8_lossy(b).into_owned())
                        .unwrap_or_default();
                    println!("[{label}] HTTP {} body: {}", resp.status(), &body[..body.len().min(300)]);
                }
                Err(e) => println!("[{label}] ERR: {e}"),
            }
        }
    }

    /// Network test — run explicitly: cargo test edge_net -- --ignored --nocapture
    #[test]
    #[ignore]
    fn edge_net_voices_and_synth() {
        match fetch_voices() {
            Ok(v) => println!("voices ok: {} en voices", v.len()),
            Err(e) => println!("voices FAILED: {e}"),
        }
        let out = std::env::temp_dir().join("tarotalking-edge-net-test.mp3");
        match synth_once("en-US-AriaNeural", "Hello from the network test.", &out) {
            Ok(b) => println!(
                "synth ok: {} bytes, {} boundaries",
                std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0),
                b.len()
            ),
            Err(e) => println!("synth FAILED: {e}"),
        }
        let _ = std::fs::remove_file(&out);
    }
}

#[tauri::command]
pub async fn edge_voices() -> Result<Vec<VoiceInfo>> {
    tauri::async_runtime::spawn_blocking(|| {
        let mem = VOICES_MEM.get_or_init(|| Mutex::new(None));
        if let Some(cached) = mem.lock().unwrap().clone() {
            return Ok(cached);
        }
        match fetch_voices() {
            Ok(voices) => {
                *mem.lock().unwrap() = Some(voices.clone());
                if let Ok(json) = serde_json::to_vec(&voices) {
                    let _ = crate::paths::atomic_write(&voices_cache_path(), &json);
                }
                Ok(voices)
            }
            Err(e) => {
                // Offline fallback: the last fetched list (voices rarely change).
                if let Ok(text) = std::fs::read_to_string(voices_cache_path()) {
                    if let Ok(voices) = serde_json::from_str::<Vec<VoiceInfo>>(&text) {
                        *mem.lock().unwrap() = Some(voices.clone());
                        return Ok(voices);
                    }
                }
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| AppError::wrap("Edge voices task", e))?
}
