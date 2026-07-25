// Audiobook import: read tags + duration for the audio files a user brings and
// play them WHERE THEY LIVE. Audiobooks are gigabytes, so nothing is copied
// into the library — the only thing that lands in the item dir is the cover.
//
// `lofty` is the one dependency this needs. ID3v2 (mp3/wav), MP4 ilst
// (m4a/m4b/aac), FLAC pictures and Vorbis comments (ogg/opus) all sit behind a
// single Probe/Tag API that also reports stream duration; covering the same
// eight extensions otherwise means three or four format-specific crates plus
// per-format duration math. Signatures + shapes are frozen (mirrored in ipc.ts).

use crate::error::{AppError, Result};
use lofty::config::{ParseOptions, ParsingMode};
use lofty::picture::MimeType;
use lofty::prelude::{Accessor, AudioFile, ItemKey, TaggedFileExt};
use lofty::probe::Probe;
use serde::Serialize;
use std::cmp::Ordering;
use std::iter::Peekable;
use std::path::Path;
use std::str::Chars;
use tauri::Manager;

/// Extensions accepted for audiobook import (mirrored in types.ts).
const SUPPORTED: [&str; 8] = ["mp3", "m4a", "m4b", "aac", "flac", "ogg", "opus", "wav"];
/// Embedded art is held in memory and written verbatim, so a pathological
/// picture frame must not be able to decide how much we allocate or write.
const MAX_COVER: usize = 8 * 1024 * 1024;
/// Tag text is untrusted: it is trimmed, stripped of control characters, and
/// bounded before it can reach a label.
const MAX_TAG_CHARS: usize = 300;
/// One book's worth of files. Well past any real chapter count, short of a
/// runaway selection (a whole music drive dragged onto the window).
const MAX_TRACKS: usize = 5_000;

/// One audio file's metadata, read from its tags.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFileInfo {
    pub path: String,
    pub title: String,
    pub duration_sec: f64,
    pub track_no: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudiobookImportResult {
    pub title: String,
    pub author: Option<String>,
    pub cover_path: Option<String>,
    /// Files in play order.
    pub tracks: Vec<AudioFileInfo>,
}

/* ============================ commands ============================ */

#[tauri::command]
pub async fn import_audiobook(
    app: tauri::AppHandle,
    id: String,
    paths: Vec<String>,
) -> Result<AudiobookImportResult> {
    // Tag reads are one open + seek per file, hundreds of files deep — keep the
    // whole thing (and the scope's existence checks) off the async threads.
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::paths::item_dir(&id)?;
        crate::paths::ensure_dir(&dir)?;
        let result = import_files(&paths, &dir)?;
        allow_files(&app, result.tracks.iter().map(|t| t.path.as_str()));
        Ok(result)
    })
    .await
    .map_err(|e| AppError::wrap("Import task", e))?
}

/// The asset scope is not persisted, so the frontend replays every known
/// audiobook path through this on boot. A path that no longer exists is
/// skipped, not an error — the frontend reports missing files itself.
#[tauri::command]
pub async fn allow_audio_paths(app: tauri::AppHandle, paths: Vec<String>) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        allow_files(&app, paths.iter().map(String::as_str));
    })
    .await
    .map_err(|e| AppError::wrap("Audio path task", e))
}

/* ============================ import core ============================ */

fn import_files(files: &[String], item_dir: &Path) -> Result<AudiobookImportResult> {
    if files.is_empty() {
        return Err(AppError::msg("No audio files were selected"));
    }
    if files.len() > MAX_TRACKS {
        return Err(AppError::msg("That's too many files for one audiobook"));
    }
    for f in files {
        if !is_supported_audio(f) {
            let name = clean_tag(Some(file_name_of(f))).unwrap_or_default();
            return Err(AppError::msg(format!("Not a supported audio file: {name}")));
        }
    }

    let mut tags: Vec<FileTags> = Vec::with_capacity(files.len());
    let mut cover_path: Option<String> = None;
    let mut readable = 0usize;

    for f in files {
        // A file that will not parse still plays; it just loses its metadata.
        match read_tags(f, cover_path.is_none()) {
            Some((t, art)) => {
                readable += 1;
                if let Some(art) = art {
                    cover_path = write_cover(item_dir, &art);
                }
                tags.push(t);
            }
            None => tags.push(FileTags::default()),
        }
    }
    if readable == 0 {
        return Err(AppError::msg("Could not read any of these audio files"));
    }

    let tracks = files
        .iter()
        .zip(tags.iter())
        .map(|(path, t)| AudioFileInfo {
            path: path.clone(),
            title: track_title(t.title.as_deref(), path),
            duration_sec: t.duration_sec,
            track_no: t.track_no,
        })
        .collect();

    Ok(AudiobookImportResult {
        title: book_title(&tags, files),
        author: book_author(&tags),
        cover_path,
        tracks: order_tracks(tracks),
    })
}

/// What one file contributes. Everything downstream (ordering, title and author
/// choice) works on these, so none of it needs a file on disk to be tested.
#[derive(Debug, Default, Clone)]
struct FileTags {
    album: Option<String>,
    album_artist: Option<String>,
    artist: Option<String>,
    title: Option<String>,
    track_no: Option<u32>,
    duration_sec: f64,
}

struct CoverArt {
    ext: &'static str,
    data: Vec<u8>,
}

/// Tags + duration for one file. `None` means the file could not be parsed at
/// all; the caller degrades that track instead of failing the whole import.
fn read_tags(path: &str, want_cover: bool) -> Option<(FileTags, Option<CoverArt>)> {
    // Relaxed: a malformed frame drops that one field instead of discarding the
    // file. A library of user-supplied rips is exactly the input that needs it.
    let options = ParseOptions::new().parsing_mode(ParsingMode::Relaxed);
    let tagged = Probe::open(path)
        .ok()?
        .options(options)
        // Content wins over the extension, so a mislabelled file still imports.
        .guess_file_type()
        .ok()?
        .read()
        .ok()?;

    let mut out = FileTags {
        duration_sec: sane_duration(tagged.properties().duration().as_secs_f64()),
        ..FileTags::default()
    };
    let mut art = None;

    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        out.title = clean_tag(tag.title().as_deref());
        out.album = clean_tag(tag.album().as_deref());
        out.artist = clean_tag(tag.artist().as_deref());
        out.album_artist = clean_tag(tag.get_string(ItemKey::AlbumArtist));
        // Track 0 is "untagged" in practice — treat it as absent.
        out.track_no = tag.track().filter(|n| *n > 0);
        if want_cover {
            art = tag.pictures().iter().find_map(|p| {
                let ext = cover_target(p.mime_type().map(MimeType::as_str), p.data())?;
                Some(CoverArt {
                    ext,
                    data: p.data().to_vec(),
                })
            });
        }
    }
    Some((out, art))
}

/// Durations come from a parsed header; a broken one can be NaN or negative.
fn sane_duration(secs: f64) -> f64 {
    if !secs.is_finite() || secs <= 0.0 {
        return 0.0;
    }
    (secs * 1000.0).round() / 1000.0
}

/* ============================ ordering ============================ */

/// Play order — the thing users notice immediately when it is wrong.
///
/// Track numbers win only when EVERY file has one and they are all distinct:
/// one stray tag in a folder of twenty must not scatter the other nineteen.
/// Otherwise it is a natural sort of the file name, so `chapter2` lands before
/// `chapter10`, with the full path as a tie-break to keep multi-folder sets
/// grouped. Both passes sort stably, so equal keys keep the caller's order.
fn order_tracks(mut tracks: Vec<AudioFileInfo>) -> Vec<AudioFileInfo> {
    let all_numbered = !tracks.is_empty() && tracks.iter().all(|t| t.track_no.is_some());
    let distinct = {
        let mut ns: Vec<u32> = tracks.iter().filter_map(|t| t.track_no).collect();
        let total = ns.len();
        ns.sort_unstable();
        ns.dedup();
        ns.len() == total
    };

    if all_numbered && distinct {
        tracks.sort_by_key(|t| t.track_no.unwrap_or(u32::MAX));
    } else {
        tracks.sort_by(|a, b| {
            natural_cmp(file_name_of(&a.path), file_name_of(&b.path))
                .then_with(|| natural_cmp(&a.path, &b.path))
        });
    }
    tracks
}

/// Human sort: digit runs compare as numbers, everything else case-insensitively.
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        let (ca, cb) = match (ai.peek().copied(), bi.peek().copied()) {
            // Exhausted together: everything matched case-insensitively, so fall
            // back to the raw bytes rather than leaving the order to chance.
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => (x, y),
        };
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            let (na, nb) = (take_digits(&mut ai), take_digits(&mut bi));
            match cmp_digit_runs(&na, &nb) {
                Ordering::Equal => {}
                ord => return ord,
            }
        } else {
            ai.next();
            bi.next();
            match ca.to_lowercase().cmp(cb.to_lowercase()) {
                Ordering::Equal => {}
                ord => return ord,
            }
        }
    }
}

fn take_digits(it: &mut Peekable<Chars<'_>>) -> String {
    let mut run = String::new();
    while let Some(c) = it.peek().copied() {
        if !c.is_ascii_digit() {
            break;
        }
        run.push(c);
        it.next();
    }
    run
}

/// Compare digit runs by value without parsing: a 40-digit run must not
/// overflow into a wrong answer. Equal values order by run length, so `2` and
/// `02` have a fixed relationship instead of one the sort happens to pick.
fn cmp_digit_runs(a: &str, b: &str) -> Ordering {
    let (ta, tb) = (a.trim_start_matches('0'), b.trim_start_matches('0'));
    ta.len()
        .cmp(&tb.len())
        .then_with(|| ta.cmp(tb))
        .then_with(|| a.len().cmp(&b.len()))
}

/* ============================ names and tags ============================ */

fn file_name_of(path: &str) -> &str {
    match path.rfind(['/', '\\']) {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

fn file_stem_of(path: &str) -> &str {
    let name = file_name_of(path);
    match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    }
}

/// Lowercased extension, or `None` when there isn't a real one (no dot, a
/// trailing dot, or a leading-dot name like `.mp3`).
fn extension_of(path: &str) -> Option<String> {
    let name = file_name_of(path);
    let i = name.rfind('.')?;
    if i == 0 || i + 1 == name.len() {
        return None;
    }
    Some(name[i + 1..].to_ascii_lowercase())
}

fn is_supported_audio(path: &str) -> bool {
    extension_of(path).is_some_and(|e| SUPPORTED.contains(&e.as_str()))
}

fn parent_path_of(path: &str) -> Option<&str> {
    let i = path.rfind(['/', '\\'])?;
    Some(&path[..i])
}

/// The folder name to show for a directory path — `None` for a bare drive
/// (`C:`) or an empty parent, neither of which is a book title.
fn folder_name_of(dir: &str) -> Option<&str> {
    let name = match dir.rfind(['/', '\\']) {
        Some(i) => &dir[i + 1..],
        None => dir,
    };
    if name.is_empty() || name.ends_with(':') {
        None
    } else {
        Some(name)
    }
}

/// A shared folder only names the book when there are several files in it —
/// one loose file usually sits in Downloads, which is not a title.
fn common_folder_name(files: &[String]) -> Option<String> {
    if files.len() < 2 {
        return None;
    }
    let parent = parent_path_of(&files[0])?;
    if !files.iter().all(|f| parent_path_of(f) == Some(parent)) {
        return None;
    }
    clean_tag(folder_name_of(parent))
}

/// Album tag, else the folder every file shares, else the first file's stem.
fn book_title(tags: &[FileTags], files: &[String]) -> String {
    tags.iter()
        .find_map(|t| t.album.clone())
        .or_else(|| common_folder_name(files))
        .or_else(|| files.first().and_then(|f| clean_tag(Some(file_stem_of(f)))))
        .unwrap_or_else(|| "Audiobook".to_string())
}

/// Album artist first: it is the book-level field, and rips that distinguish
/// the two usually put the narrator in artist and the author in album artist.
fn book_author(tags: &[FileTags]) -> Option<String> {
    tags.iter()
        .find_map(|t| t.album_artist.clone())
        .or_else(|| tags.iter().find_map(|t| t.artist.clone()))
}

fn track_title(tag_title: Option<&str>, path: &str) -> String {
    clean_tag(tag_title)
        .or_else(|| clean_tag(Some(file_stem_of(path))))
        .or_else(|| clean_tag(Some(file_name_of(path))))
        .unwrap_or_else(|| "Untitled".to_string())
}

/// Every tag field is untrusted text. Control characters (NULs and the frame
/// terminators sloppy taggers leave behind), zero-width BOMs and runs of
/// whitespace collapse to single spaces, and the result is length-bounded.
/// `None` when nothing printable survives.
fn clean_tag(value: Option<&str>) -> Option<String> {
    let mut out = String::new();
    let mut gap = false;
    for c in value?.chars().take(MAX_TAG_CHARS) {
        if c.is_control() || c.is_whitespace() || c == '\u{feff}' {
            gap = !out.is_empty();
            continue;
        }
        if gap {
            out.push(' ');
            gap = false;
        }
        out.push(c);
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/* ============================ cover art ============================ */

/// Extension for embedded art, or `None` for "write no cover". The magic bytes
/// decide ahead of the declared mime: the file we write is served back by
/// extension, so it has to match what is actually in it. Anything that is not
/// JPEG or PNG, empty, or over the cap is dropped rather than guessed at.
fn cover_target(mime: Option<&str>, data: &[u8]) -> Option<&'static str> {
    if data.is_empty() || data.len() > MAX_COVER {
        return None;
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("png");
    }
    match mime.map(str::to_ascii_lowercase).as_deref() {
        Some("image/jpeg" | "image/jpg") => Some("jpg"),
        Some("image/png") => Some("png"),
        _ => None,
    }
}

/// Art is the one thing copied into the item dir — a few hundred KB, unlike the
/// audio itself. A failed write is not worth failing an import over.
fn write_cover(item_dir: &Path, art: &CoverArt) -> Option<String> {
    let out = item_dir.join(format!("cover.{}", art.ext));
    std::fs::write(&out, &art.data).ok()?;
    Some(out.to_string_lossy().into_owned())
}

/* ============================ asset scope ============================ */

/// The one place the asset scope reaches outside app data. It allows the exact
/// files that were imported — never a directory, never a glob — because the
/// webview loads them through the asset protocol and audiobooks stay wherever
/// the user keeps them. Two guards keep that narrow: the path must still exist,
/// and it must carry a supported audio extension, so nothing else can be talked
/// into the scope. Both the given and canonical forms are allowed because the
/// scope check canonicalizes the requested path (see the data dirs in lib.rs).
fn allow_files<'a>(app: &tauri::AppHandle, files: impl Iterator<Item = &'a str>) {
    let scope = app.asset_protocol_scope();
    for f in files {
        if !is_supported_audio(f) {
            continue;
        }
        let path = Path::new(f);
        if !path.is_file() {
            continue;
        }
        let _ = scope.allow_file(path);
        if let Ok(canonical) = std::fs::canonicalize(path) {
            let _ = scope.allow_file(&canonical);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(path: &str, no: Option<u32>) -> AudioFileInfo {
        AudioFileInfo {
            path: path.to_string(),
            title: file_stem_of(path).to_string(),
            duration_sec: 0.0,
            track_no: no,
        }
    }

    fn order(paths: &[(&str, Option<u32>)]) -> Vec<String> {
        let input = paths.iter().map(|(p, n)| track(p, *n)).collect();
        order_tracks(input)
            .into_iter()
            .map(|t| t.path)
            .collect()
    }

    /* ---------------- natural sort ---------------- */

    #[test]
    fn numeric_runs_compare_as_numbers() {
        assert_eq!(natural_cmp("chapter2.mp3", "chapter10.mp3"), Ordering::Less);
        assert_eq!(natural_cmp("chapter10.mp3", "chapter9.mp3"), Ordering::Greater);
        assert_eq!(natural_cmp("part 100", "part 99"), Ordering::Greater);
    }

    #[test]
    fn zero_padding_does_not_change_value() {
        assert_eq!(natural_cmp("track007", "track10"), Ordering::Less);
        assert_eq!(natural_cmp("0009", "10"), Ordering::Less);
        // Same value, different padding: shorter run first, and never Equal, so
        // the order cannot flip between runs.
        assert_eq!(natural_cmp("2", "02"), Ordering::Less);
        assert_eq!(natural_cmp("02", "2"), Ordering::Greater);
    }

    #[test]
    fn digit_runs_beyond_u64_still_compare() {
        let big = "9".repeat(40);
        let bigger = format!("{}1", "9".repeat(40));
        assert_eq!(natural_cmp(&big, &bigger), Ordering::Less);
        assert_eq!(natural_cmp(&format!("{big}a"), &format!("{big}b")), Ordering::Less);
    }

    #[test]
    fn text_compares_case_insensitively_then_exactly() {
        assert_eq!(natural_cmp("Chapter 1", "chapter 2"), Ordering::Less);
        assert_eq!(natural_cmp("alpha", "Beta"), Ordering::Less);
        // Case-insensitively identical strings still get a stable answer.
        assert_ne!(natural_cmp("Alpha", "alpha"), Ordering::Equal);
        assert_eq!(natural_cmp("same", "same"), Ordering::Equal);
    }

    #[test]
    fn prefix_sorts_before_longer_name() {
        assert_eq!(natural_cmp("intro", "intro 2"), Ordering::Less);
        assert_eq!(natural_cmp("a", ""), Ordering::Greater);
    }

    /* ---------------- track ordering ---------------- */

    #[test]
    fn full_track_numbers_beat_file_names() {
        // Names sort the opposite way — the tags have to win.
        let got = order(&[("z-first.mp3", Some(1)), ("a-second.mp3", Some(2))]);
        assert_eq!(got, vec!["z-first.mp3", "a-second.mp3"]);
    }

    #[test]
    fn untagged_files_sort_naturally() {
        let got = order(&[
            ("chapter10.mp3", None),
            ("chapter2.mp3", None),
            ("chapter1.mp3", None),
        ]);
        assert_eq!(got, vec!["chapter1.mp3", "chapter2.mp3", "chapter10.mp3"]);
    }

    #[test]
    fn one_stray_tag_does_not_scatter_the_rest() {
        // Only the last file carries a number; ordering must stay name-based.
        let got = order(&[
            ("chapter1.mp3", None),
            ("chapter2.mp3", None),
            ("chapter3.mp3", Some(1)),
        ]);
        assert_eq!(got, vec!["chapter1.mp3", "chapter2.mp3", "chapter3.mp3"]);
    }

    #[test]
    fn duplicate_track_numbers_fall_back_to_names() {
        let got = order(&[
            ("b-two.mp3", Some(1)),
            ("a-one.mp3", Some(1)),
            ("c-three.mp3", Some(2)),
        ]);
        assert_eq!(got, vec!["a-one.mp3", "b-two.mp3", "c-three.mp3"]);
    }

    #[test]
    fn equal_keys_keep_input_order() {
        // Identical names in different folders: the full-path tie-break decides,
        // and the sort stays stable for genuinely equal keys.
        let got = order(&[
            (r"D:\Book\Disc 2\01.mp3", None),
            (r"D:\Book\Disc 1\01.mp3", None),
        ]);
        assert_eq!(got, vec![r"D:\Book\Disc 1\01.mp3", r"D:\Book\Disc 2\01.mp3"]);
    }

    #[test]
    fn ordering_handles_empty_and_single() {
        assert!(order(&[]).is_empty());
        assert_eq!(order(&[("only.m4b", None)]), vec!["only.m4b"]);
        assert_eq!(order(&[("only.m4b", Some(7))]), vec!["only.m4b"]);
    }

    #[test]
    fn numbered_files_in_folders_sort_by_number() {
        let got = order(&[
            (r"C:\Books\A Book\10 - ten.mp3", Some(10)),
            (r"C:\Books\A Book\02 - two.mp3", Some(2)),
            (r"C:\Books\A Book\01 - one.mp3", Some(1)),
        ]);
        assert_eq!(
            got,
            vec![
                r"C:\Books\A Book\01 - one.mp3",
                r"C:\Books\A Book\02 - two.mp3",
                r"C:\Books\A Book\10 - ten.mp3",
            ]
        );
    }

    /* ---------------- extensions ---------------- */

    #[test]
    fn supported_extensions_are_case_insensitive() {
        for ext in SUPPORTED {
            assert!(is_supported_audio(&format!("book.{ext}")), "{ext}");
            assert!(is_supported_audio(&format!("book.{}", ext.to_uppercase())), "{ext}");
        }
        assert!(is_supported_audio(r"C:\my.books\part one.M4B"));
    }

    #[test]
    fn unsupported_paths_are_rejected() {
        assert!(!is_supported_audio("book.txt"));
        assert!(!is_supported_audio("book.epub"));
        assert!(!is_supported_audio("book.mp3.exe"));
        assert!(!is_supported_audio("noextension"));
        assert!(!is_supported_audio("trailing."));
        // A leading dot is the whole name, not an extension.
        assert!(!is_supported_audio(".mp3"));
        // A dot in a folder name must not be read as the file's extension.
        assert!(!is_supported_audio(r"C:\my.mp3\readme"));
        assert!(!is_supported_audio(""));
    }

    #[test]
    fn import_rejects_empty_and_unsupported_lists() {
        let dir = std::env::temp_dir();
        let err = import_files(&[], &dir).unwrap_err();
        assert_eq!(err.to_string(), "No audio files were selected");

        let err = import_files(&["notes.txt".to_string()], &dir).unwrap_err();
        assert_eq!(err.to_string(), "Not a supported audio file: notes.txt");

        let too_many: Vec<String> = (0..MAX_TRACKS + 1).map(|i| format!("{i}.mp3")).collect();
        let err = import_files(&too_many, &dir).unwrap_err();
        assert_eq!(err.to_string(), "That's too many files for one audiobook");
    }

    /* ---------------- title / author fallbacks ---------------- */

    fn tagged(album: Option<&str>, album_artist: Option<&str>, artist: Option<&str>) -> FileTags {
        FileTags {
            album: album.map(str::to_string),
            album_artist: album_artist.map(str::to_string),
            artist: artist.map(str::to_string),
            ..FileTags::default()
        }
    }

    #[test]
    fn book_title_prefers_album_tag() {
        let tags = vec![
            FileTags::default(),
            tagged(Some("The Hobbit"), None, None),
        ];
        let files = vec![
            r"C:\Audio\Folder Name\01.mp3".to_string(),
            r"C:\Audio\Folder Name\02.mp3".to_string(),
        ];
        assert_eq!(book_title(&tags, &files), "The Hobbit");
    }

    #[test]
    fn book_title_falls_back_to_shared_folder() {
        let tags = vec![FileTags::default(), FileTags::default()];
        let files = vec![
            r"C:\Audio\Folder Name\01.mp3".to_string(),
            r"C:\Audio\Folder Name\02.mp3".to_string(),
        ];
        assert_eq!(book_title(&tags, &files), "Folder Name");

        // Files from different folders have no common name to use.
        let split = vec![
            r"C:\Audio\One\01.mp3".to_string(),
            r"C:\Audio\Two\02.mp3".to_string(),
        ];
        assert_eq!(book_title(&tags, &split), "01");
    }

    #[test]
    fn book_title_falls_back_to_stem_for_a_single_file() {
        let tags = vec![FileTags::default()];
        let files = vec![r"C:\Users\me\Downloads\Dune.m4b".to_string()];
        assert_eq!(book_title(&tags, &files), "Dune");

        // A bare drive is not a folder name either.
        let rooted = vec![r"C:\a.mp3".to_string(), r"C:\b.mp3".to_string()];
        let two = vec![FileTags::default(), FileTags::default()];
        assert_eq!(book_title(&two, &rooted), "a");
    }

    #[test]
    fn book_title_has_a_last_resort() {
        assert_eq!(book_title(&[], &[]), "Audiobook");
        let tags = vec![FileTags::default()];
        assert_eq!(book_title(&tags, &["   ".to_string()]), "Audiobook");
    }

    #[test]
    fn book_author_prefers_album_artist_then_artist() {
        let tags = vec![
            FileTags::default(),
            tagged(None, None, Some("Narrator")),
            tagged(None, Some("Author"), Some("Narrator")),
        ];
        assert_eq!(book_author(&tags), Some("Author".to_string()));

        let no_aart = vec![FileTags::default(), tagged(None, None, Some("Narrator"))];
        assert_eq!(book_author(&no_aart), Some("Narrator".to_string()));

        assert_eq!(book_author(&[FileTags::default()]), None);
        assert_eq!(book_author(&[]), None);
    }

    #[test]
    fn track_title_falls_back_through_tag_stem_name() {
        assert_eq!(track_title(Some("Chapter One"), "x.mp3"), "Chapter One");
        assert_eq!(track_title(Some("   "), r"C:\b\03 - Intro.mp3"), "03 - Intro");
        assert_eq!(track_title(None, r"C:\b\03 - Intro.mp3"), "03 - Intro");
        assert_eq!(track_title(None, r"C:\b\.hidden"), ".hidden");
        assert_eq!(track_title(None, ""), "Untitled");
    }

    /* ---------------- untrusted tag text ---------------- */

    #[test]
    fn clean_tag_strips_control_characters_and_collapses_space() {
        assert_eq!(
            clean_tag(Some("  Chapter\u{0}\u{0} One\r\n")),
            Some("Chapter One".to_string())
        );
        assert_eq!(clean_tag(Some("\u{feff}Title")), Some("Title".to_string()));
        assert_eq!(clean_tag(Some("a\tb")), Some("a b".to_string()));
    }

    #[test]
    fn clean_tag_drops_empty_values() {
        assert_eq!(clean_tag(None), None);
        assert_eq!(clean_tag(Some("")), None);
        assert_eq!(clean_tag(Some("   \r\n\u{0}")), None);
    }

    #[test]
    fn clean_tag_is_length_bounded() {
        let long = "x".repeat(MAX_TAG_CHARS * 4);
        let cleaned = clean_tag(Some(&long)).unwrap();
        assert_eq!(cleaned.chars().count(), MAX_TAG_CHARS);
        // Multi-byte text is cut on character boundaries, not bytes.
        let wide = "é".repeat(MAX_TAG_CHARS * 2);
        assert_eq!(clean_tag(Some(&wide)).unwrap().chars().count(), MAX_TAG_CHARS);
    }

    /* ---------------- cover art ---------------- */

    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0x00];
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nIHDR";

    #[test]
    fn cover_mime_maps_to_an_extension() {
        assert_eq!(cover_target(Some("image/jpeg"), JPEG), Some("jpg"));
        assert_eq!(cover_target(Some("image/png"), PNG), Some("png"));
        assert_eq!(cover_target(Some("IMAGE/JPG"), b"unknown bytes"), Some("jpg"));
        assert_eq!(cover_target(None, PNG), Some("png"));
    }

    #[test]
    fn cover_bytes_outrank_a_lying_mime() {
        // Declared JPEG, actually PNG: the extension must match the content
        // because the written file is served back by extension.
        assert_eq!(cover_target(Some("image/jpeg"), PNG), Some("png"));
        assert_eq!(cover_target(Some("image/png"), JPEG), Some("jpg"));
    }

    #[test]
    fn cover_rejects_unknown_empty_and_oversized() {
        assert_eq!(cover_target(Some("image/webp"), b"RIFF....WEBP"), None);
        assert_eq!(cover_target(None, b"not an image"), None);
        assert_eq!(cover_target(Some("image/png"), b""), None);

        let mut at_cap = vec![0u8; MAX_COVER];
        at_cap[..3].copy_from_slice(&[0xFF, 0xD8, 0xFF]);
        assert_eq!(cover_target(Some("image/jpeg"), &at_cap), Some("jpg"));

        let over = vec![0xFFu8; MAX_COVER + 1];
        assert_eq!(cover_target(Some("image/jpeg"), &over), None);
    }

    #[test]
    fn duration_survives_broken_headers() {
        assert_eq!(sane_duration(f64::NAN), 0.0);
        assert_eq!(sane_duration(f64::INFINITY), 0.0);
        assert_eq!(sane_duration(-5.0), 0.0);
        assert_eq!(sane_duration(0.0), 0.0);
        assert_eq!(sane_duration(12.3456), 12.346);
    }

    /* ---------------- end to end over real files ---------------- */

    /// Minimal 8 kHz mono 16-bit PCM WAV — enough of a real file for lofty to
    /// report a duration, with no fixture to keep in the repo.
    fn wav_bytes(seconds: u32) -> Vec<u8> {
        let (rate, channels, bits) = (8000u32, 1u16, 16u16);
        let block_align = channels * bits / 8;
        let byte_rate = rate * u32::from(block_align);
        let data_len = byte_rate * seconds;
        let mut v = Vec::with_capacity(44 + data_len as usize);
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + data_len).to_le_bytes());
        v.extend_from_slice(b"WAVEfmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&channels.to_le_bytes());
        v.extend_from_slice(&rate.to_le_bytes());
        v.extend_from_slice(&byte_rate.to_le_bytes());
        v.extend_from_slice(&block_align.to_le_bytes());
        v.extend_from_slice(&bits.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&data_len.to_le_bytes());
        v.resize(v.len() + data_len as usize, 0);
        v
    }

    struct TempDir(std::path::PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn temp_dir() -> TempDir {
        let p = std::env::temp_dir().join(format!("tarot-audio-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }

    #[test]
    fn imports_untagged_files_in_name_order() {
        let dir = temp_dir();
        let book = dir.0.join("A Book");
        std::fs::create_dir_all(&book).unwrap();
        let files: Vec<String> = ["chapter10.wav", "chapter2.wav"]
            .iter()
            .map(|n| {
                let p = book.join(n);
                std::fs::write(&p, wav_bytes(2)).unwrap();
                p.to_string_lossy().into_owned()
            })
            .collect();

        let res = import_files(&files, &dir.0).unwrap();
        assert_eq!(res.title, "A Book");
        assert_eq!(res.author, None);
        assert_eq!(res.cover_path, None);
        let names: Vec<&str> = res.tracks.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(names, vec!["chapter2", "chapter10"]);
        assert!((res.tracks[0].duration_sec - 2.0).abs() < 0.05);
    }

    #[test]
    fn unreadable_file_degrades_but_a_whole_unreadable_set_errors() {
        let dir = temp_dir();
        let good = dir.0.join("real.wav");
        std::fs::write(&good, wav_bytes(1)).unwrap();
        let bad = dir.0.join("broken.mp3");
        std::fs::write(&bad, b"this is not audio").unwrap();
        let missing = dir.0.join("gone.m4b");

        let files = vec![
            good.to_string_lossy().into_owned(),
            bad.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
        ];
        let res = import_files(&files, &dir.0).unwrap();
        assert_eq!(res.tracks.len(), 3);
        let broken = res.tracks.iter().find(|t| t.title == "broken").unwrap();
        assert_eq!(broken.duration_sec, 0.0);
        assert!(res.tracks.iter().any(|t| t.title == "gone"));

        let all_bad = vec![
            bad.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
        ];
        let err = import_files(&all_bad, &dir.0).unwrap_err();
        assert_eq!(err.to_string(), "Could not read any of these audio files");
    }

    #[test]
    fn cover_is_written_into_the_item_dir() {
        let dir = temp_dir();
        let art = CoverArt {
            ext: "png",
            data: PNG.to_vec(),
        };
        let written = write_cover(&dir.0, &art).unwrap();
        assert!(written.ends_with("cover.png"));
        assert_eq!(std::fs::read(&written).unwrap(), PNG);
    }

    /// Reads a real audiobook from TAROTALKING_AUDIOBOOK (a file, or several
    /// separated by `;`). Ignored: it needs media that is not in the repo.
    #[test]
    #[ignore]
    fn real_audiobook_smoke() {
        let Ok(spec) = std::env::var("TAROTALKING_AUDIOBOOK") else {
            return;
        };
        let files: Vec<String> = spec.split(';').map(str::to_string).collect();
        let dir = temp_dir();
        let res = import_files(&files, &dir.0).unwrap();
        assert_eq!(res.tracks.len(), files.len());
        assert!(res.tracks.iter().any(|t| t.duration_sec > 0.0));
        println!(
            "title={:?} author={:?} cover={:?} tracks={}",
            res.title,
            res.author,
            res.cover_path,
            res.tracks.len()
        );
        for t in &res.tracks {
            println!("  {:>8.1}s  #{:?}  {}", t.duration_sec, t.track_no, t.title);
        }
    }
}
