// Microsoft Edge read-aloud voices, spoken over the consumer WebSocket
// endpoint Edge itself uses — no Edge process involved. Free neural voices;
// requires internet.
//
// Protocol notes:
// - The endpoint gates on a Sec-MS-GEC token: SHA-256 of (Windows file time
//   rounded down to 5 minutes ++ trusted client token), uppercase hex. The
//   token rides the URL of the HTTP upgrade, so it gates the HANDSHAKE only:
//   an established socket keeps working after its 5-minute window rolls over.
// - `speech.config` is connection-level — sent once after the handshake, not
//   once per sentence.
// - One turn = one SSML message tagged with a fresh X-RequestId. The server
//   answers with JSON metadata frames (word boundaries) and binary audio
//   frames (2-byte BE header length prefix), each stamped with that same
//   X-RequestId, until `turn.end`.
// - Word-boundary offsets are in 100 ns ticks from audio start.
//
// Sockets are parked per thread and reused across sentences: TCP + TLS + WS
// handshakes dominate per-sentence latency, and preparing a book is hundreds
// of thousands of sentences.

use super::{VoiceInfo, WordBoundary};
use crate::error::{AppError, Result};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::io::Write as _;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
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
/// Bitrate tracks the user's audio-quality setting; both are formats the
/// read-aloud endpoint serves natively.
fn output_format() -> &'static str {
    if crate::tts::cache::audio_quality() == "standard" {
        "audio-24khz-48kbitrate-mono-mp3"
    } else {
        "audio-24khz-96kbitrate-mono-mp3"
    }
}
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";

/// Read/write deadline on the socket — keeps a hung or half-dead server from
/// stalling playback forever.
const SOCKET_TIMEOUT: Duration = Duration::from_secs(20);
/// Reuse window. Consecutive sentences in every real flow (playback prefetch,
/// the precache pool) land well under a second apart, so this never expires
/// mid-run; a longer gap is a user-scale pause where one handshake is free.
/// Staying short keeps us clear of the service's own idle close, which is the
/// one thing reuse cannot observe until it fails.
const CONN_IDLE_MAX: Duration = Duration::from_secs(20);
/// Insurance against a server-side connection lifetime cap. At roughly a
/// sentence a second this is one extra handshake per few hundred sentences.
const CONN_MAX_AGE: Duration = Duration::from_secs(240);
/// A turn should see zero frames belonging to another request id. A flood of
/// them means the socket lost sync, so abandon it instead of spinning.
const MAX_FOREIGN_FRAMES: u32 = 64;

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

/* ================= parked connections ================= */

type EdgeSocket = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>;

/// A live read-aloud socket parked for reuse by the thread that opened it.
struct EdgeConn {
    socket: EdgeSocket,
    /// Output format `speech.config` was sent with. A quality change means the
    /// config on this socket no longer describes what we want, so the socket
    /// is retired rather than reconfigured.
    format: &'static str,
    opened: Instant,
    last_used: Instant,
}

thread_local! {
    /// One parked socket per thread. `synth` is called from several threads
    /// (the precache pool's scoped workers, the blocking pool behind
    /// `tts_synth`); a per-thread socket needs no locking, gives every worker
    /// its own reuse, and is closed by that thread's own teardown — nothing
    /// polls, and nothing runs while the app sits idle.
    static PARKED: RefCell<Option<EdgeConn>> = const { RefCell::new(None) };
}

/// Whether a parked socket may serve another turn. `idle` guards the service's
/// own idle close, `age` guards any server-side connection lifetime cap.
fn conn_reusable(idle: Duration, age: Duration, same_format: bool) -> bool {
    same_format && idle < CONN_IDLE_MAX && age < CONN_MAX_AGE
}

/// Take this thread's parked socket if it is still fit to use. An expired one
/// is closed right here, on the call that noticed — no timer, no keepalive.
fn take_parked(format: &'static str) -> Option<EdgeConn> {
    PARKED
        .try_with(|slot| {
            let conn = slot.borrow_mut().take()?;
            let now = Instant::now();
            if conn_reusable(
                now.saturating_duration_since(conn.last_used),
                now.saturating_duration_since(conn.opened),
                conn.format == format,
            ) {
                Some(conn)
            } else {
                close_quietly(conn);
                None
            }
        })
        .ok()
        .flatten()
}

/// Park a socket that just completed a turn cleanly.
fn park(conn: EdgeConn) {
    let _ = PARKED.try_with(|slot| *slot.borrow_mut() = Some(conn));
}

fn close_quietly(mut conn: EdgeConn) {
    let _ = conn.socket.close(None);
    let _ = conn.socket.flush();
}

/* ================= frame routing ================= */

/// Split an Edge protocol frame into its header block and its body.
fn split_frame(frame: &str) -> (&str, &str) {
    match frame.find("\r\n\r\n") {
        Some(at) => (&frame[..at], &frame[at + 4..]),
        None => (frame, ""),
    }
}

/// Value of one `Name:value` header line, or None when absent. Matching is
/// exact on the name, so `X-RequestIdent` never answers for `X-RequestId`.
fn header_value<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header.lines().find_map(|line| {
        let rest = line.strip_prefix(name)?;
        Some(rest.strip_prefix(':')?.trim())
    })
}

/// Does this frame belong to the turn in flight?
///
/// A frame stamped with a different X-RequestId is another turn's and must
/// never reach this turn's audio. A frame carrying no id at all can only be
/// ours: a socket runs exactly one turn at a time, and it is never parked for
/// reuse unless that turn reached `turn.end`, so no leftovers can survive into
/// the next sentence.
fn frame_matches(header: &str, expect_id: &str) -> bool {
    match header_value(header, "X-RequestId") {
        Some(id) => id == expect_id,
        None => true,
    }
}

#[derive(Debug, PartialEq)]
enum TextFrame<'a> {
    /// Another turn's frame — ignored.
    Foreign,
    /// This turn finished cleanly.
    TurnEnd,
    /// Word-boundary metadata body for this turn.
    Metadata(&'a str),
    /// Something else for this turn (`turn.start`, `response`, …).
    Other,
}

fn classify_text<'a>(frame: &'a str, expect_id: &str) -> TextFrame<'a> {
    let (header, body) = split_frame(frame);
    if !frame_matches(header, expect_id) {
        return TextFrame::Foreign;
    }
    match header_value(header, "Path") {
        Some("turn.end") => TextFrame::TurnEnd,
        Some("audio.metadata") => TextFrame::Metadata(body),
        _ => TextFrame::Other,
    }
}

#[derive(Debug, PartialEq)]
enum AudioFrame<'a> {
    /// Audio bytes for this turn.
    Audio(&'a [u8]),
    /// Another turn's audio — dropped, never appended.
    Foreign,
    /// Malformed or not an audio frame.
    Ignore,
}

fn classify_audio<'a>(data: &'a [u8], expect_id: &str) -> AudioFrame<'a> {
    if data.len() < 2 {
        return AudioFrame::Ignore;
    }
    let header_len = u16::from_be_bytes([data[0], data[1]]) as usize;
    if data.len() < 2 + header_len {
        return AudioFrame::Ignore;
    }
    let header = String::from_utf8_lossy(&data[2..2 + header_len]);
    if !header.contains("Path:audio") {
        return AudioFrame::Ignore;
    }
    if !frame_matches(&header, expect_id) {
        return AudioFrame::Foreign;
    }
    AudioFrame::Audio(&data[2 + header_len..])
}

fn socket_out_of_sync(foreign_frames: u32) -> bool {
    foreign_frames > MAX_FOREIGN_FRAMES
}

/// Audio from a turn that never reached `turn.end` is trusted only on a fresh
/// connection — that is the long-standing behaviour and the server does close
/// after the last frame often enough to matter. On a reused socket the same
/// shape is indistinguishable from the service dropping an idle connection
/// mid-stream, so the sentence is retried instead of written possibly short.
fn turn_is_trustworthy(clean: bool, reused: bool) -> bool {
    clean || !reused
}

/// Attempt plan for one sentence: a parked socket first, then a brand new one.
/// Exactly two attempts, and the second is always a fresh handshake — which is
/// also what covers a Sec-MS-GEC window expiring between token and handshake.
const ATTEMPTS: [bool; 2] = [true, false];

/* ================= synthesis ================= */

/// Synthesize one sentence to MP3 at `out`; returns word boundaries.
pub fn synth(voice_id: &str, text: &str, out: &Path) -> Result<Vec<WordBoundary>> {
    let mut last: Option<AppError> = None;
    for allow_reuse in ATTEMPTS {
        match synth_attempt(voice_id, text, out, allow_reuse) {
            Ok(boundaries) => return Ok(boundaries),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| AppError::msg("Edge synthesis failed")))
}

fn synth_attempt(
    voice_id: &str,
    text: &str,
    out: &Path,
    allow_reuse: bool,
) -> Result<Vec<WordBoundary>> {
    if !voice_id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(AppError::msg("Invalid Edge voice id"));
    }
    let format = output_format();

    // The parked socket comes OUT of the slot for the whole turn and only goes
    // back after a clean `turn.end`. Every failure path therefore drops it, so
    // a half-read socket can never be handed to the next sentence.
    let parked = if allow_reuse { take_parked(format) } else { None };
    let reused = parked.is_some();
    let mut conn = match parked {
        Some(conn) => conn,
        None => connect(format)?,
    };

    let turn = run_turn(&mut conn, voice_id, text)?;
    if turn.clean {
        conn.last_used = Instant::now();
        park(conn);
    }
    if !turn_is_trustworthy(turn.clean, reused) {
        return Err(AppError::msg("Edge closed the connection before the turn ended"));
    }

    if turn.audio.is_empty() {
        return Err(AppError::msg("Edge returned no audio for this sentence"));
    }
    if let Some(parent) = out.parent() {
        crate::paths::ensure_dir(parent)?;
    }
    let mut f = std::fs::File::create(out)?;
    f.write_all(&turn.audio)?;
    Ok(turn.boundaries)
}

/// Handshake a new socket and send its one `speech.config`.
fn connect(format: &'static str) -> Result<EdgeConn> {
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

    if let tungstenite::stream::MaybeTlsStream::Rustls(stream) = socket.get_mut() {
        let _ = stream.sock.set_read_timeout(Some(SOCKET_TIMEOUT));
        let _ = stream.sock.set_write_timeout(Some(SOCKET_TIMEOUT));
    }

    let ts = timestamp();
    let config = format!(
        "X-Timestamp:{ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n\
        {{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"true\"}},\"outputFormat\":\"{format}\"}}}}}}}}"
    );
    socket.send(Message::text(config)).map_err(offline)?;

    let now = Instant::now();
    Ok(EdgeConn {
        socket,
        format,
        opened: now,
        last_used: now,
    })
}

struct Turn {
    audio: Vec<u8>,
    boundaries: Vec<WordBoundary>,
    /// Saw `turn.end` for our request id — the audio is complete.
    clean: bool,
}

/// Run one synthesis turn on an established socket: send the SSML under a
/// fresh request id, then read frames belonging to that id until `turn.end`.
fn run_turn(conn: &mut EdgeConn, voice_id: &str, text: &str) -> Result<Turn> {
    let ssml = format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>\
         <voice name='{voice_id}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>{}</prosody></voice></speak>",
        escape_xml(text)
    );
    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let ssml_msg = format!(
        "X-RequestId:{request_id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{}Z\r\nPath:ssml\r\n\r\n{ssml}",
        timestamp()
    );
    conn.socket.send(Message::text(ssml_msg)).map_err(offline)?;

    let mut turn = Turn {
        audio: Vec::with_capacity(32 * 1024),
        boundaries: Vec::new(),
        clean: false,
    };
    // Sequential word→char mapping cursor into the source sentence.
    let mut char_cursor = 0usize;
    let mut foreign = 0u32;

    loop {
        let msg = conn.socket.read().map_err(offline)?;
        match msg {
            Message::Text(t) => match classify_text(&t, &request_id) {
                TextFrame::TurnEnd => {
                    turn.clean = true;
                    break;
                }
                TextFrame::Metadata(body) => {
                    parse_metadata(body, text, &mut char_cursor, &mut turn.boundaries)
                }
                TextFrame::Foreign => foreign += 1,
                TextFrame::Other => {}
            },
            Message::Binary(data) => match classify_audio(&data, &request_id) {
                AudioFrame::Audio(chunk) => turn.audio.extend_from_slice(chunk),
                AudioFrame::Foreign => foreign += 1,
                AudioFrame::Ignore => {}
            },
            Message::Close(_) => break,
            _ => {}
        }
        if socket_out_of_sync(foreign) {
            return Err(AppError::msg("Edge connection lost sync"));
        }
    }

    Ok(turn)
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
    // US first, then GB, then the rest — matches what most users reach for.
    let region_rank = |v: &VoiceInfo| match v.locale.as_deref() {
        Some("en-US") => 0u8,
        Some("en-GB") => 1,
        Some("en-AU") | Some("en-CA") | Some("en-IE") | Some("en-NZ") => 2,
        _ => 3,
    };
    voices.sort_by(|a, b| {
        region_rank(a)
            .cmp(&region_rank(b))
            .then(a.locale.cmp(&b.locale))
            .then(a.name.cmp(&b.name))
    });
    Ok(voices)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a binary audio frame the way the service does: 2-byte BE header
    /// length, header text, then the payload.
    fn audio_frame(request_id: &str, path: &str, payload: &[u8]) -> Vec<u8> {
        let header = format!("X-RequestId:{request_id}\r\nPath:{path}\r\n");
        let mut out = Vec::with_capacity(2 + header.len() + payload.len());
        out.extend_from_slice(&(header.len() as u16).to_be_bytes());
        out.extend_from_slice(header.as_bytes());
        out.extend_from_slice(payload);
        out
    }

    fn text_frame(request_id: &str, path: &str, body: &str) -> String {
        format!("X-RequestId:{request_id}\r\nPath:{path}\r\n\r\n{body}")
    }

    #[test]
    fn header_value_matches_names_exactly() {
        let header = "X-RequestId:abc123\r\nContent-Type:application/json\r\nPath:turn.end";
        assert_eq!(header_value(header, "X-RequestId"), Some("abc123"));
        assert_eq!(header_value(header, "Path"), Some("turn.end"));
        assert_eq!(header_value(header, "X-Timestamp"), None);
        // A longer header name must not answer for a shorter one.
        assert_eq!(header_value("X-RequestIdent:zzz", "X-RequestId"), None);
        assert_eq!(header_value("X-RequestIdent:zzz", "X-RequestIdent"), Some("zzz"));
    }

    #[test]
    fn split_frame_separates_header_and_body() {
        let (header, body) = split_frame("Path:audio.metadata\r\n\r\n{\"Metadata\":[]}");
        assert_eq!(header, "Path:audio.metadata");
        assert_eq!(body, "{\"Metadata\":[]}");
        // No separator: everything is header, body is empty.
        let (header, body) = split_frame("Path:turn.end");
        assert_eq!(header, "Path:turn.end");
        assert_eq!(body, "");
    }

    #[test]
    fn text_frames_route_by_path_for_this_turn() {
        let ours = "req-1";
        assert_eq!(
            classify_text(&text_frame(ours, "turn.end", ""), ours),
            TextFrame::TurnEnd
        );
        assert_eq!(
            classify_text(&text_frame(ours, "audio.metadata", "{\"Metadata\":[]}"), ours),
            TextFrame::Metadata("{\"Metadata\":[]}")
        );
        assert_eq!(
            classify_text(&text_frame(ours, "turn.start", "{}"), ours),
            TextFrame::Other
        );
    }

    #[test]
    fn text_frames_from_another_turn_are_foreign() {
        let ours = "req-2";
        // The hazard: a late turn.end from the PREVIOUS sentence must not end
        // this one, and its metadata must not land in our boundaries.
        assert_eq!(
            classify_text(&text_frame("req-1", "turn.end", ""), ours),
            TextFrame::Foreign
        );
        assert_eq!(
            classify_text(&text_frame("req-1", "audio.metadata", "{}"), ours),
            TextFrame::Foreign
        );
    }

    #[test]
    fn frames_without_a_request_id_belong_to_the_turn_in_flight() {
        // A socket runs one turn at a time and is never parked after an
        // unclean turn, so an unstamped frame can only be ours.
        assert_eq!(
            classify_text("Path:turn.end\r\n\r\n", "req-1"),
            TextFrame::TurnEnd
        );
        assert!(frame_matches("Path:audio\r\n", "req-1"));
    }

    #[test]
    fn audio_frames_bind_to_their_request_id() {
        let ours = "req-9";
        let mine = audio_frame(ours, "audio", &[1, 2, 3, 4]);
        assert_eq!(classify_audio(&mine, ours), AudioFrame::Audio(&[1, 2, 3, 4]));
        // Another turn's audio is reported foreign and its bytes are not
        // handed back at all — nothing can append them by accident.
        let theirs = audio_frame("req-8", "audio", &[9, 9, 9]);
        assert_eq!(classify_audio(&theirs, ours), AudioFrame::Foreign);
    }

    #[test]
    fn malformed_and_non_audio_frames_are_ignored() {
        let ours = "req-3";
        assert_eq!(classify_audio(&[], ours), AudioFrame::Ignore);
        assert_eq!(classify_audio(&[0x00], ours), AudioFrame::Ignore);
        // Header length longer than the buffer.
        assert_eq!(classify_audio(&[0x00, 0xff, b'x'], ours), AudioFrame::Ignore);
        // Right shape, wrong path.
        let other = audio_frame(ours, "turn.start", &[1, 2]);
        assert_eq!(classify_audio(&other, ours), AudioFrame::Ignore);
    }

    #[test]
    fn late_frames_from_a_previous_turn_never_reach_this_turns_audio() {
        let ours = "req-new";
        let stale = "req-old";
        let stream = vec![
            audio_frame(stale, "audio", &[0xde, 0xad]),
            audio_frame(ours, "audio", &[0x01, 0x02]),
            audio_frame(stale, "audio", &[0xbe, 0xef]),
            audio_frame(ours, "audio", &[0x03]),
        ];
        let mut audio: Vec<u8> = Vec::new();
        let mut foreign = 0u32;
        for frame in &stream {
            match classify_audio(frame, ours) {
                AudioFrame::Audio(chunk) => audio.extend_from_slice(chunk),
                AudioFrame::Foreign => foreign += 1,
                AudioFrame::Ignore => {}
            }
        }
        assert_eq!(audio, vec![0x01, 0x02, 0x03]);
        assert_eq!(foreign, 2);
    }

    #[test]
    fn out_of_sync_only_trips_past_the_bound() {
        assert!(!socket_out_of_sync(0));
        assert!(!socket_out_of_sync(MAX_FOREIGN_FRAMES));
        assert!(socket_out_of_sync(MAX_FOREIGN_FRAMES + 1));
    }

    #[test]
    fn reuse_window_expires_on_idle_age_and_format_change() {
        let fresh = Duration::from_secs(1);
        assert!(conn_reusable(fresh, fresh, true));
        // Idle right up to the window is still fine; at the window it is not.
        assert!(conn_reusable(CONN_IDLE_MAX - Duration::from_millis(1), fresh, true));
        assert!(!conn_reusable(CONN_IDLE_MAX, fresh, true));
        // Age cap, independent of idle time.
        assert!(conn_reusable(fresh, CONN_MAX_AGE - Duration::from_millis(1), true));
        assert!(!conn_reusable(fresh, CONN_MAX_AGE, true));
        // An audio-quality change retires the socket: its speech.config is
        // part of the connection, not the request.
        assert!(!conn_reusable(fresh, fresh, false));
    }

    #[test]
    fn attempt_plan_is_reuse_then_fresh() {
        // Exactly two attempts, and the retry never touches a parked socket —
        // so a failed reuse costs one reconnect and nothing else.
        assert_eq!(ATTEMPTS.len(), 2);
        assert!(ATTEMPTS[0], "first attempt may reuse a parked connection");
        assert!(!ATTEMPTS[1], "retry must handshake a brand new connection");
    }

    #[test]
    fn unclean_turns_are_only_trusted_on_a_fresh_connection() {
        assert!(turn_is_trustworthy(true, true));
        assert!(turn_is_trustworthy(true, false));
        // Long-standing behaviour on a fresh socket: keep what arrived.
        assert!(turn_is_trustworthy(false, false));
        // On a reused socket the same shape means "retry", never "write short".
        assert!(!turn_is_trustworthy(false, true));
    }
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
        match synth("en-US-AriaNeural", "Hello from the network test.", &out) {
            Ok(b) => println!(
                "synth ok: {} bytes, {} boundaries",
                std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0),
                b.len()
            ),
            Err(e) => println!("synth FAILED: {e}"),
        }
        let _ = std::fs::remove_file(&out);
    }

    /// Measures connection reuse: sentence 1 pays the handshake, the rest run
    /// on the parked socket. Run explicitly:
    /// cargo test edge_net_reuse -- --ignored --nocapture
    #[test]
    #[ignore]
    fn edge_net_reuse_timing() {
        let sentences = [
            "The first sentence pays for the handshake.",
            "The second sentence should reuse the socket.",
            "So should the third one.",
            "And the fourth.",
        ];
        let out = std::env::temp_dir().join("tarotalking-edge-reuse-test.mp3");
        for (i, text) in sentences.iter().enumerate() {
            let started = Instant::now();
            match synth("en-US-AriaNeural", text, &out) {
                Ok(b) => println!(
                    "[{i}] {:>6} ms, {} bytes, {} boundaries",
                    started.elapsed().as_millis(),
                    std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0),
                    b.len()
                ),
                Err(e) => println!("[{i}] FAILED after {:?}: {e}", started.elapsed()),
            }
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
