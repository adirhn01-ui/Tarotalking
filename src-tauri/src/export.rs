// Export audiobook: synthesize any missing sentences into the shared audio
// cache (phase 1, via the same worker pool precache uses), then stitch each
// chapter into one tagged MP3 file on disk (phase 2). Shares the single
// audio-job slot and cancel bridge with precache, so tts_precache_cancel
// cancels an export in progress too.

use crate::error::{AppError, Result};
use crate::tts::{self, PrecacheState};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Emitter;

/// 350 ms of silence between stitched WAV sentences (local engines synthesize
/// one sentence per file with no trailing pause; provider MP3s keep their own).
const SILENCE_MS: u64 = 350;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportChapter {
    pub title: String,
    pub texts: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub item_id: String,
    pub provider: String,
    pub voice_id: String,
    pub book_title: String,
    pub author: Option<String>,
    pub chapters: Vec<ExportChapter>,
    pub dest_dir: String,
    pub task_id: String,
    pub label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub dir: String,
    pub chapters_written: u32,
}

/// True for providers whose cache holds WAV (local engines), false for the
/// MP3 providers. Unknown providers are rejected up front.
fn provider_is_wav(provider: &str) -> Result<bool> {
    match provider {
        "piper" | "system" | "kokoro" => Ok(true),
        "edge" | "eleven" | "openai" | "speechify" | "deepgram" | "cartesia" => Ok(false),
        _ => Err(AppError::msg("Unknown voice provider")),
    }
}

#[tauri::command]
pub async fn export_audiobook(
    app: tauri::AppHandle,
    state: tauri::State<'_, PrecacheState>,
    req: ExportRequest,
) -> Result<ExportResult> {
    // Validate up front, before claiming the shared job slot.
    let item_dir = crate::paths::item_dir(&req.item_id)?;
    let dest = PathBuf::from(&req.dest_dir);
    if !dest.is_dir() {
        // Create it when missing (a picked-then-renamed folder still errors).
        crate::paths::ensure_dir(&dest)
            .map_err(|_| AppError::msg("The destination folder could not be created"))?;
    }
    if req.chapters.is_empty() {
        return Err(AppError::msg("This book has no chapters to export"));
    }
    let has_text = req
        .chapters
        .iter()
        .any(|c| c.texts.iter().any(|t| !t.trim().is_empty()));
    if !has_text {
        return Err(AppError::msg("There is no text to export"));
    }
    let is_wav = provider_is_wav(&req.provider)?;

    let cancel = tts::claim_job(&state, &req.task_id, "Another audio job is already running")?;

    let result = tauri::async_runtime::spawn_blocking(move || {
        run_export(&app, &item_dir, &req, is_wav, &cancel)
    })
    .await
    .map_err(|e| AppError::wrap("Export task", e))
    .and_then(|r| r);

    tts::release_job(&state);
    result
}

/// The full export, run off the async runtime. Emits a single terminal
/// "download-progress" event under `req.task_id`; total = unique-sentence count
/// (phase 1) + chapter count (phase 2).
fn run_export(
    app: &tauri::AppHandle,
    item_dir: &Path,
    req: &ExportRequest,
    is_wav: bool,
    cancel: &Arc<AtomicBool>,
) -> Result<ExportResult> {
    let all_refs: Vec<&str> = req
        .chapters
        .iter()
        .flat_map(|c| c.texts.iter().map(|s| s.as_str()))
        .collect();
    let work = tts::dedupe_work(&all_refs);
    let unique = work.len() as u64;
    let chapter_count = req.chapters.len();
    let total = unique + chapter_count as u64;

    let emit = |received: u64, done: bool, error: Option<String>| {
        let _ = app.emit(
            "download-progress",
            crate::downloads::DownloadProgress {
                task_id: req.task_id.clone(),
                label: req.label.clone(),
                received,
                total: Some(total),
                done,
                error,
            },
        );
    };
    emit(0, false, None);

    // Phase 1 — synthesize every missing sentence into the cache.
    let (_, first_error) = tts::run_synth_pool(
        &req.provider,
        &req.voice_id,
        &work,
        cancel,
        |received| emit(received, false, None),
    );
    if cancel.load(Ordering::SeqCst) {
        emit(unique, true, Some("Cancelled".into()));
        return Err(AppError::msg("Cancelled"));
    }
    if let Some(err) = first_error {
        emit(unique, true, Some(err.to_string()));
        return Err(err);
    }
    // Phase 1 complete: every unique sentence is cached.
    emit(unique, false, None);

    // Phase 2 — stitch one tagged MP3 per chapter.
    let sanitized_book = sanitize(&req.book_title, "Audiobook");
    let out_root = Path::new(&req.dest_dir).join(&sanitized_book);
    crate::paths::ensure_dir(&out_root)?;

    let cover_bytes = {
        let p = item_dir.join("cover.jpg");
        if p.is_file() {
            std::fs::read(&p).ok()
        } else {
            None
        }
    };
    let bitrate = if crate::tts::cache::audio_quality() == "high" {
        96
    } else {
        64
    };
    let width = num_width(chapter_count);

    let mut written: u32 = 0;
    for (i, chapter) in req.chapters.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            emit(unique + i as u64, true, Some("Cancelled".into()));
            return Err(AppError::msg("Cancelled"));
        }
        let ordinal = i + 1;
        let has_audio = chapter.texts.iter().any(|t| !t.trim().is_empty());
        if has_audio {
            // TIT2 uses the raw title (fallback "Chapter N"); the file name uses
            // a sanitized copy (fallback "Chapter NN", zero-padded).
            let display_title = if chapter.title.trim().is_empty() {
                format!("Chapter {ordinal}")
            } else {
                chapter.title.clone()
            };
            let safe = sanitize(&display_title, &format!("Chapter {ordinal:0width$}"));
            let file_name = format!("{ordinal:0width$} - {safe}.mp3");
            let out_path = out_root.join(&file_name);
            let tmp_path = out_root.join(format!("{file_name}.tmp"));

            let build = build_chapter_mp3(
                &req.provider,
                &req.voice_id,
                &chapter.texts,
                is_wav,
                bitrate,
                cancel,
            )
            .and_then(|bytes| {
                std::fs::write(&tmp_path, &bytes)?;
                write_tags(
                    &tmp_path,
                    &display_title,
                    req,
                    ordinal,
                    chapter_count,
                    cover_bytes.as_deref(),
                )?;
                if out_path.exists() {
                    let _ = std::fs::remove_file(&out_path);
                }
                std::fs::rename(&tmp_path, &out_path)?;
                Ok(())
            });

            if let Err(e) = build {
                // Delete the in-progress tmp; completed chapters stay on disk.
                let _ = std::fs::remove_file(&tmp_path);
                if cancel.load(Ordering::SeqCst) {
                    emit(unique + i as u64, true, Some("Cancelled".into()));
                    return Err(AppError::msg("Cancelled"));
                }
                emit(unique + i as u64, true, Some(e.to_string()));
                return Err(e);
            }
            written += 1;
        }
        emit(unique + ordinal as u64, false, None);
    }

    emit(total, true, None);
    Ok(ExportResult {
        dir: out_root.to_string_lossy().into_owned(),
        chapters_written: written,
    })
}

/// Build one chapter's MP3 bytes. WAV providers decode + concatenate PCM with
/// inter-sentence silence and encode a single MP3; MP3 providers concatenate
/// their cached bytes verbatim.
fn build_chapter_mp3(
    provider: &str,
    voice_id: &str,
    texts: &[String],
    is_wav: bool,
    bitrate: u32,
    cancel: &Arc<AtomicBool>,
) -> Result<Vec<u8>> {
    // A cheap cache hit (phase 1 already synthesized everything): returns the
    // cached file's path, which we read back. Keeps cache.rs untouched.
    let lookup = |text: &str| -> Result<Vec<u8>> {
        let res = crate::tts::cache::synth_via_cache(provider, voice_id, text)?;
        std::fs::read(&res.path).map_err(AppError::from)
    };
    if is_wav {
        stitch_wav(texts, lookup, bitrate, cancel)
    } else {
        concat_mp3(texts, lookup, cancel)
    }
}

/// Concatenate a chapter's cached MP3 files in sentence order (no re-encode, no
/// injected silence — provider audio carries its own natural pauses).
fn concat_mp3(
    texts: &[String],
    lookup: impl Fn(&str) -> Result<Vec<u8>>,
    cancel: &Arc<AtomicBool>,
) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    for t in texts {
        if t.trim().is_empty() {
            continue;
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::msg("Cancelled"));
        }
        out.extend_from_slice(&lookup(t)?);
    }
    Ok(out)
}

/// Decode a chapter's cached WAV files, concatenate their PCM with `SILENCE_MS`
/// of silence between sentences, and encode ONE MP3. All files of a voice share
/// one sample rate; a deviating file is a hard error.
fn stitch_wav(
    texts: &[String],
    lookup: impl Fn(&str) -> Result<Vec<u8>>,
    bitrate: u32,
    cancel: &Arc<AtomicBool>,
) -> Result<Vec<u8>> {
    let mut sample_rate: Option<u32> = None;
    let mut samples: Vec<i16> = Vec::new();
    let mut first = true;
    for t in texts {
        if t.trim().is_empty() {
            continue;
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::msg("Cancelled"));
        }
        let wav = lookup(t)?;
        let pcm = parse_wav(&wav)?;
        match sample_rate {
            None => sample_rate = Some(pcm.rate),
            Some(r) if r != pcm.rate => {
                return Err(AppError::msg(
                    "This voice produced audio at inconsistent sample rates",
                ));
            }
            _ => {}
        }
        if !first {
            samples.extend(std::iter::repeat(0i16).take(silence_samples(pcm.rate)));
        }
        first = false;
        samples.extend_from_slice(&pcm.samples);
    }
    let rate = sample_rate.ok_or_else(|| AppError::msg("This chapter has no audio to export"))?;
    encode_mp3(&samples, rate, bitrate)
}

/// Number of zero-valued mono samples for `SILENCE_MS` at `rate`.
fn silence_samples(rate: u32) -> usize {
    (rate as u64 * SILENCE_MS / 1000) as usize
}

/// Zero-pad width for chapter numbering: enough digits for `count`, min 2.
fn num_width(count: usize) -> usize {
    count.to_string().len().max(2)
}

/// Decoded 16-bit PCM WAV, downmixed to mono.
struct WavPcm {
    rate: u32,
    samples: Vec<i16>,
}

/// Walk a RIFF/WAVE file's chunks to find "fmt " and "data" (chunk order is not
/// fixed and odd-sized chunks carry a pad byte). Accepts 16-bit PCM, mono or
/// stereo; stereo is downmixed by averaging.
fn parse_wav(bytes: &[u8]) -> Result<WavPcm> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(AppError::msg("A cached audio file is not valid WAV"));
    }
    let mut pos = 12;
    let mut fmt: Option<(u16, u16, u32, u16)> = None; // format, channels, rate, bits
    let mut data: Option<&[u8]> = None;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;
        let body_start = pos + 8;
        let body_end = body_start
            .checked_add(size)
            .filter(|&e| e <= bytes.len())
            .ok_or_else(|| AppError::msg("A cached audio file is truncated"))?;
        if id == b"fmt " {
            if size < 16 {
                return Err(AppError::msg("Unsupported WAV format chunk"));
            }
            let b = &bytes[body_start..body_start + 16];
            let format = u16::from_le_bytes([b[0], b[1]]);
            let channels = u16::from_le_bytes([b[2], b[3]]);
            let rate = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
            let bits = u16::from_le_bytes([b[14], b[15]]);
            fmt = Some((format, channels, rate, bits));
        } else if id == b"data" {
            data = Some(&bytes[body_start..body_end]);
        }
        // Advance to the next chunk; odd-sized chunk bodies are padded to even.
        pos = body_end + (size & 1);
    }

    let (format, channels, rate, bits) =
        fmt.ok_or_else(|| AppError::msg("WAV file has no format chunk"))?;
    let data = data.ok_or_else(|| AppError::msg("WAV file has no data chunk"))?;
    // PCM (1) or WAVE_FORMAT_EXTENSIBLE (0xFFFE) carrying 16-bit samples.
    if (format != 1 && format != 0xFFFE) || bits != 16 {
        return Err(AppError::msg("Only 16-bit PCM WAV audio can be exported"));
    }
    if channels == 0 {
        return Err(AppError::msg("WAV file reports zero channels"));
    }
    Ok(WavPcm {
        rate,
        samples: pcm16_to_mono(data, channels),
    })
}

/// Interpret raw little-endian 16-bit PCM as mono samples, averaging channels
/// when the source is multi-channel. A trailing partial frame is ignored.
fn pcm16_to_mono(data: &[u8], channels: u16) -> Vec<i16> {
    let ch = channels as usize;
    let frame_bytes = 2 * ch;
    let frames = data.len() / frame_bytes;
    let mut out = Vec::with_capacity(frames);
    for f in 0..frames {
        let base = f * frame_bytes;
        if ch == 1 {
            out.push(i16::from_le_bytes([data[base], data[base + 1]]));
        } else {
            let mut acc: i32 = 0;
            for c in 0..ch {
                let o = base + c * 2;
                acc += i16::from_le_bytes([data[o], data[o + 1]]) as i32;
            }
            out.push((acc / ch as i32) as i16);
        }
    }
    out
}

/// Encode mono 16-bit PCM to one MP3 at the source sample rate and given
/// bitrate (kbps).
fn encode_mp3(samples: &[i16], sample_rate: u32, bitrate_kbps: u32) -> Result<Vec<u8>> {
    use mp3lame_encoder::{Bitrate, Builder, FlushNoGap, MonoPcm};

    let mut builder =
        Builder::new().ok_or_else(|| AppError::msg("Could not start the MP3 encoder"))?;
    builder
        .set_num_channels(1)
        .map_err(|e| AppError::msg(format!("MP3 encoder: {e:?}")))?;
    builder
        .set_sample_rate(sample_rate)
        .map_err(|e| AppError::msg(format!("MP3 encoder: {e:?}")))?;
    builder
        .set_brate(if bitrate_kbps >= 96 {
            Bitrate::Kbps96
        } else {
            Bitrate::Kbps64
        })
        .map_err(|e| AppError::msg(format!("MP3 encoder: {e:?}")))?;
    let mut encoder = builder
        .build()
        .map_err(|e| AppError::msg(format!("MP3 encoder: {e:?}")))?;

    // The *_to_vec helpers manage the output buffer safely (LAME's worst case
    // is 1.25 * samples + 7200 bytes; the crate reserves internally).
    let mut out: Vec<u8> = Vec::with_capacity(samples.len() * 5 / 4 + 7200);
    encoder
        .encode_to_vec(MonoPcm(samples), &mut out)
        .map_err(|e| AppError::msg(format!("MP3 encoding failed: {e:?}")))?;
    encoder
        .flush_to_vec::<FlushNoGap>(&mut out)
        .map_err(|e| AppError::msg(format!("MP3 flush failed: {e:?}")))?;
    Ok(out)
}

/// Write an ID3v2.3 tag onto a finished chapter MP3.
fn write_tags(
    path: &Path,
    title: &str,
    req: &ExportRequest,
    track: usize,
    total_tracks: usize,
    cover: Option<&[u8]>,
) -> Result<()> {
    use id3::frame::{Picture, PictureType};
    use id3::{Content, Frame, Tag, TagLike, Version};

    let mut tag = Tag::new();
    tag.set_title(title);
    tag.set_album(&req.book_title);
    if let Some(author) = req.author.as_deref() {
        if !author.trim().is_empty() {
            tag.set_artist(author);
        }
    }
    tag.set_track(track as u32);
    tag.set_total_tracks(total_tracks as u32);
    tag.set_genre("Audiobook");
    if let Some(bytes) = cover {
        tag.add_frame(Frame::with_content(
            "APIC",
            Content::Picture(Picture {
                mime_type: "image/jpeg".to_string(),
                picture_type: PictureType::CoverFront,
                description: String::new(),
                data: bytes.to_vec(),
            }),
        ));
    }
    tag.write_to_path(path, Version::Id3v23)
        .map_err(|e| AppError::msg(format!("Could not tag the audio: {e}")))
}

/// File-name sanitizer: keep `[A-Za-z0-9 ._-]`, collapse any run of other
/// characters (and whitespace) to a single space, trim, cap at 60 chars.
/// Empty result → `fallback`.
fn sanitize(input: &str, fallback: &str) -> String {
    let mut out = String::new();
    let mut pending_space = false;
    for ch in input.chars() {
        let keep = ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-';
        if keep {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(ch);
        } else {
            // Space or any disallowed character collapses to a single gap.
            pending_space = true;
        }
    }
    let capped: String = out
        .trim_matches(' ')
        .chars()
        .take(60)
        .collect::<String>()
        .trim_matches(' ')
        .to_string();
    if capped.is_empty() {
        return fallback.chars().take(60).collect();
    }
    capped
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- sanitizer ---------------------------------------------------------

    #[test]
    fn sanitize_keeps_allowed_and_collapses_others() {
        assert_eq!(
            sanitize("Chapter 1: The Beginning!", "x"),
            "Chapter 1 The Beginning"
        );
        assert_eq!(sanitize("file_name-v1.2", "x"), "file_name-v1.2");
        assert_eq!(sanitize("a    b", "x"), "a b");
        assert_eq!(sanitize("  leading & trailing  ", "x"), "leading trailing");
    }

    #[test]
    fn sanitize_falls_back_when_empty() {
        assert_eq!(sanitize("***", "Chapter 03"), "Chapter 03");
        assert_eq!(sanitize("", "Audiobook"), "Audiobook");
        assert_eq!(sanitize("   ", "Audiobook"), "Audiobook");
    }

    #[test]
    fn sanitize_caps_at_60_chars() {
        let long = "a".repeat(100);
        let out = sanitize(&long, "x");
        assert_eq!(out.len(), 60);
        assert!(out.chars().all(|c| c == 'a'));
    }

    #[test]
    fn sanitize_trims_trailing_space_after_cap() {
        // 59 'a's, a separator, then a word: the 60-char cut lands on the gap.
        let input = format!("{} word", "a".repeat(59));
        let out = sanitize(&input, "x");
        assert_eq!(out.len(), 59);
        assert!(!out.ends_with(' '));
    }

    // ---- zero-pad width ----------------------------------------------------

    #[test]
    fn num_width_is_min_two() {
        assert_eq!(num_width(1), 2);
        assert_eq!(num_width(9), 2);
        assert_eq!(num_width(10), 2);
        assert_eq!(num_width(99), 2);
        assert_eq!(num_width(100), 3);
        assert_eq!(num_width(1000), 4);
    }

    #[test]
    fn num_width_drives_padding() {
        let w = num_width(5);
        assert_eq!(format!("{:0w$}", 3, w = w), "03");
        let w = num_width(120);
        assert_eq!(format!("{:0w$}", 7, w = w), "007");
    }

    // ---- silence sample math ----------------------------------------------

    #[test]
    fn silence_samples_matches_rate() {
        assert_eq!(silence_samples(24000), 8400);
        assert_eq!(silence_samples(22050), 7717); // 22050 * 350 / 1000 = 7717.5 → 7717
        assert_eq!(silence_samples(48000), 16800);
        assert_eq!(silence_samples(16000), 5600);
    }

    // ---- WAV chunk walker --------------------------------------------------

    fn chunk(id: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(id);
        v.extend_from_slice(&(body.len() as u32).to_le_bytes());
        v.extend_from_slice(body);
        if body.len() % 2 == 1 {
            v.push(0); // pad odd-sized bodies to an even boundary
        }
        v
    }

    fn fmt_body(channels: u16, rate: u32, bits: u16) -> Vec<u8> {
        let block_align = channels * (bits / 8);
        let byte_rate = rate * block_align as u32;
        let mut b = Vec::new();
        b.extend_from_slice(&1u16.to_le_bytes()); // PCM
        b.extend_from_slice(&channels.to_le_bytes());
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&byte_rate.to_le_bytes());
        b.extend_from_slice(&block_align.to_le_bytes());
        b.extend_from_slice(&bits.to_le_bytes());
        b
    }

    fn riff(chunks: &[Vec<u8>]) -> Vec<u8> {
        let mut inner = Vec::new();
        inner.extend_from_slice(b"WAVE");
        for c in chunks {
            inner.extend_from_slice(c);
        }
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(inner.len() as u32).to_le_bytes());
        out.extend_from_slice(&inner);
        out
    }

    fn pcm_bytes(samples: &[i16]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    #[test]
    fn parse_wav_mono_16bit() {
        let samples: [i16; 4] = [0, 1000, -1000, 32767];
        let wav = riff(&[
            chunk(b"fmt ", &fmt_body(1, 22050, 16)),
            chunk(b"data", &pcm_bytes(&samples)),
        ]);
        let out = parse_wav(&wav).unwrap();
        assert_eq!(out.rate, 22050);
        assert_eq!(out.samples, samples.to_vec());
    }

    #[test]
    fn parse_wav_handles_odd_chunk_order_and_padding() {
        // A junk chunk with an odd body (needs a pad byte) BEFORE fmt, then data.
        let samples: [i16; 2] = [123, -456];
        let wav = riff(&[
            chunk(b"LIST", &[9, 9, 9]), // odd size → padded
            chunk(b"fmt ", &fmt_body(1, 24000, 16)),
            chunk(b"data", &pcm_bytes(&samples)),
        ]);
        let out = parse_wav(&wav).unwrap();
        assert_eq!(out.rate, 24000);
        assert_eq!(out.samples, samples.to_vec());
    }

    #[test]
    fn parse_wav_downmixes_stereo_by_averaging() {
        // Interleaved L,R frames: (100,200) → 150, (300,400) → 350.
        let interleaved: [i16; 4] = [100, 200, 300, 400];
        let wav = riff(&[
            chunk(b"fmt ", &fmt_body(2, 44100, 16)),
            chunk(b"data", &pcm_bytes(&interleaved)),
        ]);
        let out = parse_wav(&wav).unwrap();
        assert_eq!(out.rate, 44100);
        assert_eq!(out.samples, vec![150, 350]);
    }

    #[test]
    fn parse_wav_rejects_non_pcm_and_non_16bit() {
        // 8-bit "PCM" is unsupported.
        let wav = riff(&[
            chunk(b"fmt ", &fmt_body(1, 22050, 8)),
            chunk(b"data", &[1, 2, 3, 4]),
        ]);
        assert!(parse_wav(&wav).is_err());

        // Missing data chunk.
        let wav = riff(&[chunk(b"fmt ", &fmt_body(1, 22050, 16))]);
        assert!(parse_wav(&wav).is_err());

        // Not a RIFF/WAVE container.
        assert!(parse_wav(b"not a wav file at all").is_err());
    }

    // ---- MP3-provider concatenation ---------------------------------------

    #[test]
    fn concat_mp3_preserves_order_and_skips_empty() {
        let texts = vec![
            "a".to_string(),
            "  ".to_string(), // whitespace-only → skipped
            "b".to_string(),
            "c".to_string(),
        ];
        let lookup = |t: &str| -> Result<Vec<u8>> {
            Ok(match t {
                "a" => vec![1, 2],
                "b" => vec![3],
                "c" => vec![4, 5, 6],
                _ => Vec::new(),
            })
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let out = concat_mp3(&texts, lookup, &cancel).unwrap();
        assert_eq!(out, vec![1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn concat_mp3_propagates_lookup_error() {
        let texts = vec!["a".to_string(), "missing".to_string()];
        let lookup = |t: &str| -> Result<Vec<u8>> {
            if t == "missing" {
                Err(AppError::msg("no such sentence"))
            } else {
                Ok(vec![7])
            }
        };
        let cancel = Arc::new(AtomicBool::new(false));
        assert!(concat_mp3(&texts, lookup, &cancel).is_err());
    }

    #[test]
    fn concat_mp3_stops_on_cancel() {
        let texts = vec!["a".to_string(), "b".to_string()];
        let cancel = Arc::new(AtomicBool::new(true));
        let lookup = |_: &str| -> Result<Vec<u8>> { Ok(vec![0]) };
        assert!(concat_mp3(&texts, lookup, &cancel).is_err());
    }

    #[test]
    fn provider_is_wav_classifies_and_rejects() {
        assert_eq!(provider_is_wav("piper").unwrap(), true);
        assert_eq!(provider_is_wav("system").unwrap(), true);
        assert_eq!(provider_is_wav("kokoro").unwrap(), true);
        assert_eq!(provider_is_wav("edge").unwrap(), false);
        assert_eq!(provider_is_wav("eleven").unwrap(), false);
        assert!(provider_is_wav("bogus").is_err());
    }
}
