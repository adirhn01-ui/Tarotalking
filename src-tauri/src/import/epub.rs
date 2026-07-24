// EPUB import: unzip, parse container/OPF/TOC with quick-xml, extract images
// (and the cover) into the item dir, return raw chapter XHTML for the
// frontend to convert into blocks.
// Signatures + shapes are frozen (mirrored in ipc.ts).

use crate::error::{AppError, Result};
use crate::paths;
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use serde::Serialize;
use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read, Seek};
use std::path::Path;
use zip::ZipArchive;

const MAX_EPUB: u64 = 400 * 1024 * 1024;
const MAX_IMAGE: u64 = 20 * 1024 * 1024;
/// Upper bound on the buffer reserved from an entry's declared size, so a bogus
/// zip header cannot make us allocate wildly before the read even starts.
const READ_RESERVE_CAP: u64 = 8 * 1024 * 1024;
const NOT_EPUB: &str = "Not a valid EPUB file";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubChapterRaw {
    pub href: String,
    pub title: Option<String>,
    pub html: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubImportResult {
    pub item_dir: String,
    pub title: Option<String>,
    pub author: Option<String>,
    pub cover_path: Option<String>,
    pub chapters: Vec<EpubChapterRaw>,
    /// zip-relative image path (lowercased, forward slashes) → absolute extracted path
    pub images: HashMap<String, String>,
}

#[tauri::command]
pub async fn import_epub(id: String, path: String) -> Result<EpubImportResult> {
    tauri::async_runtime::spawn_blocking(move || import_epub_blocking(&id, &path))
        .await
        .map_err(|e| AppError::wrap("Import task", e))?
}

/* ============================ core ============================ */

struct ManifestItem {
    id: String,
    /// Normalized zip path (forward slashes, resolved against the OPF dir).
    zip_path: String,
    /// Lowercased media type.
    media_type: String,
    /// Lowercased, space-separated properties attribute.
    properties: String,
}

struct Opf {
    title: Option<String>,
    author: Option<String>,
    manifest: Vec<ManifestItem>,
    spine: Vec<String>,
    spine_toc: Option<String>,
    cover_meta_id: Option<String>,
}

fn import_epub_blocking(id: &str, path: &str) -> Result<EpubImportResult> {
    let item_dir = paths::item_dir(id)?;

    let file = File::open(path).map_err(|_| AppError::msg("Could not open this file"))?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len > MAX_EPUB {
        return Err(AppError::msg("This EPUB is too large"));
    }

    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|_| AppError::msg(NOT_EPUB))?;
    let names: Vec<String> = archive.file_names().map(str::to_string).collect();
    let names = NameIndex::new(&names);

    // container.xml → OPF path.
    let container =
        read_named(&mut archive, &names, "META-INF/container.xml").ok_or_else(|| AppError::msg(NOT_EPUB))?;
    let opf_raw = parse_container(&container).ok_or_else(|| AppError::msg(NOT_EPUB))?;
    let opf_path = normalize_join("", &percent_decode(&opf_raw));
    let opf_bytes = read_named(&mut archive, &names, &opf_path).ok_or_else(|| AppError::msg(NOT_EPUB))?;
    let opf_dir = dir_of(&opf_path);
    let opf = parse_opf(&opf_bytes, &opf_dir);

    // id → manifest index.
    let mut id_map: HashMap<&str, usize> = HashMap::new();
    for (i, m) in opf.manifest.iter().enumerate() {
        id_map.entry(m.id.as_str()).or_insert(i);
    }

    // TOC: href (normalized zip path, no fragment) → title.
    let toc_map = build_toc(&mut archive, &names, &opf);

    // Chapters in spine order.
    let mut chapters: Vec<EpubChapterRaw> = Vec::with_capacity(opf.spine.len());
    for idref in &opf.spine {
        let Some(&idx) = id_map.get(idref.as_str()) else {
            continue;
        };
        let item = &opf.manifest[idx];
        if !is_html(&item.media_type) {
            continue;
        }
        let Some(bytes) = read_named(&mut archive, &names, &item.zip_path) else {
            continue; // missing spine file: skip gracefully
        };
        // Chapter XHTML is UTF-8 in practice; take the buffer over as-is and
        // let only genuinely broken bytes pay for a lossy copy.
        let html = String::from_utf8(bytes)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
        let title = toc_map.get(&item.zip_path).cloned();
        chapters.push(EpubChapterRaw {
            href: item.zip_path.clone(),
            title,
            html,
        });
    }
    if chapters.is_empty() {
        return Err(AppError::msg("This EPUB has no readable chapters"));
    }

    // Extract images.
    paths::ensure_dir(&item_dir)?;
    let images_dir = item_dir.join("images");
    // Created on the first image that reaches the write, so a book without any
    // gets no empty dir — and a book with 300 gets one create_dir_all, not 300.
    let mut images_dir_ready = false;
    let mut images: HashMap<String, String> = HashMap::new();
    for m in &opf.manifest {
        if !m.media_type.starts_with("image/") {
            continue;
        }
        let Some(actual) = names.find(&m.zip_path) else {
            continue;
        };
        let data = {
            let mut f = match archive.by_name(actual) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let declared = f.size();
            if declared > MAX_IMAGE {
                continue; // skip oversized images
            }
            match read_entry(&mut f, declared) {
                Some(v) => v,
                None => continue,
            }
        };
        if !images_dir_ready {
            paths::ensure_dir(&images_dir)?;
            images_dir_ready = true;
        }
        let out = images_dir.join(flat_name(&m.zip_path));
        if std::fs::write(&out, &data).is_err() {
            continue;
        }
        images.insert(m.zip_path.to_lowercase(), out.to_string_lossy().into_owned());
    }

    // Cover (extracted separately to cover.<ext>, also surfaced in the images map).
    let cover_path = extract_cover(&mut archive, &names, &opf, &item_dir, &mut images);

    Ok(EpubImportResult {
        item_dir: item_dir.to_string_lossy().into_owned(),
        title: opf.title,
        author: opf.author,
        cover_path,
        chapters,
        images,
    })
}

fn extract_cover<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    names: &NameIndex,
    opf: &Opf,
    item_dir: &Path,
    images: &mut HashMap<String, String>,
) -> Option<String> {
    // EPUB3: manifest item whose properties contain "cover-image".
    // EPUB2: <meta name="cover" content="ID"> → that manifest item.
    let cover = opf
        .manifest
        .iter()
        .find(|m| m.properties.split_whitespace().any(|p| p == "cover-image"))
        .or_else(|| {
            opf.cover_meta_id
                .as_ref()
                .and_then(|cid| opf.manifest.iter().find(|m| &m.id == cid))
        })?;

    let actual = names.find(&cover.zip_path)?;
    let data = {
        let mut f = archive.by_name(actual).ok()?;
        let declared = f.size();
        if declared > MAX_IMAGE {
            return None;
        }
        read_entry(&mut f, declared)?
    };

    let ext = match ext_of(&cover.zip_path) {
        e if e.is_empty() => "img".to_string(),
        e => e,
    };
    let out = item_dir.join(format!("cover.{ext}"));
    if std::fs::write(&out, &data).is_err() {
        return None;
    }
    let abs = out.to_string_lossy().into_owned();
    images.insert(cover.zip_path.to_lowercase(), abs.clone());
    Some(abs)
}

/* ============================ zip helpers ============================ */

/// Entry-name lookup for the archive. A book resolves one name per chapter,
/// image, OPF and TOC entry, so scanning the whole name list per lookup is
/// quadratic on exactly the books that are already slowest to import. The
/// case-insensitive fallback map is built only if some href actually needs it —
/// well-formed EPUBs match exactly and never pay for it.
struct NameIndex<'a> {
    names: &'a [String],
    exact: HashSet<&'a str>,
    lower: OnceCell<HashMap<String, &'a str>>,
}

impl<'a> NameIndex<'a> {
    fn new(names: &'a [String]) -> Self {
        NameIndex {
            names,
            exact: names.iter().map(String::as_str).collect(),
            lower: OnceCell::new(),
        }
    }

    /// Resolve a target zip path to the archive's actual entry name.
    fn find(&self, target: &str) -> Option<&'a str> {
        if let Some(n) = self.exact.get(target) {
            return Some(n);
        }
        let lower = self.lower.get_or_init(|| {
            let mut map: HashMap<String, &'a str> = HashMap::with_capacity(self.names.len());
            for n in self.names {
                // First entry wins, matching the old first-match scan.
                map.entry(n.to_lowercase()).or_insert(n.as_str());
            }
            map
        });
        lower.get(&target.to_lowercase()).copied()
    }
}

/// Read an archive entry fully, reserving its declared size up front instead of
/// growing a buffer from empty (a 500 KB chapter costs a dozen reallocations
/// and copies otherwise).
fn read_entry(f: &mut impl Read, declared: u64) -> Option<Vec<u8>> {
    let mut v = Vec::with_capacity(declared.min(READ_RESERVE_CAP) as usize);
    f.read_to_end(&mut v).ok()?;
    Some(v)
}

/// Resolve a target zip path to an actual entry name and read it fully.
fn read_named<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    names: &NameIndex,
    target: &str,
) -> Option<Vec<u8>> {
    let actual = names.find(target)?;
    let mut f = archive.by_name(actual).ok()?;
    let declared = f.size();
    read_entry(&mut f, declared)
}

/* ============================ TOC ============================ */

fn build_toc<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    names: &NameIndex,
    opf: &Opf,
) -> HashMap<String, String> {
    // EPUB3 nav document (manifest item with the "nav" property).
    if let Some(nav) = opf
        .manifest
        .iter()
        .find(|m| m.properties.split_whitespace().any(|p| p == "nav"))
    {
        if let Some(bytes) = read_named(archive, names, &nav.zip_path) {
            let map = parse_nav(&bytes, &dir_of(&nav.zip_path));
            if !map.is_empty() {
                return map;
            }
        }
    }

    // EPUB2 NCX: spine toc idref → manifest item, else any .ncx / dtbncx item.
    let ncx = opf
        .spine_toc
        .as_ref()
        .and_then(|tid| opf.manifest.iter().find(|m| &m.id == tid))
        .or_else(|| {
            opf.manifest.iter().find(|m| {
                m.media_type == "application/x-dtbncx+xml" || m.zip_path.to_lowercase().ends_with(".ncx")
            })
        });
    if let Some(ncx) = ncx {
        if let Some(bytes) = read_named(archive, names, &ncx.zip_path) {
            return parse_ncx(&bytes, &dir_of(&ncx.zip_path));
        }
    }

    HashMap::new()
}

/// EPUB3 nav: pick the toc nav (epub:type="toc"), else the first nav with
/// anchors; map each `<a href>` (resolved, fragment-stripped) → text.
fn parse_nav(bytes: &[u8], toc_dir: &str) -> HashMap<String, String> {
    struct NavAcc {
        is_toc: bool,
        anchors: Vec<(String, String)>,
    }
    let mut reader = Reader::from_reader(bytes);
    let mut buf = Vec::new();
    let mut navs: Vec<NavAcc> = Vec::new();
    let mut cur: Option<NavAcc> = None;
    let mut in_a = false;
    let mut cur_href: Option<String> = None;
    let mut text_buf = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) | Err(_) => break,
            Ok(Event::Start(e)) => {
                let name = e.name();
                match name.local_name().as_ref() {
                    b"nav" => {
                        let is_toc = attr_local(&e, b"type")
                            .map(|v| v.to_lowercase().contains("toc"))
                            .unwrap_or(false);
                        cur = Some(NavAcc {
                            is_toc,
                            anchors: Vec::new(),
                        });
                    }
                    b"a" if cur.is_some() => {
                        cur_href = attr_local(&e, b"href");
                        in_a = true;
                        text_buf.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let name = e.name();
                if name.local_name().as_ref() == b"a" {
                    if let (Some(h), Some(c)) = (attr_local(&e, b"href"), cur.as_mut()) {
                        c.anchors.push((h, String::new()));
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if in_a {
                    if let Ok(t) = e.unescape() {
                        text_buf.push_str(&t);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.name();
                match name.local_name().as_ref() {
                    b"a" if in_a => {
                        in_a = false;
                        if let (Some(h), Some(c)) = (cur_href.take(), cur.as_mut()) {
                            c.anchors.push((h, collapse_ws(&text_buf)));
                        }
                    }
                    b"nav" => {
                        if let Some(c) = cur.take() {
                            navs.push(c);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        buf.clear();
    }

    let chosen = navs
        .iter()
        .find(|n| n.is_toc)
        .or_else(|| navs.iter().find(|n| !n.anchors.is_empty()));

    let mut map = HashMap::new();
    if let Some(nav) = chosen {
        for (href, text) in &nav.anchors {
            let path = resolve_href(toc_dir, href);
            if path.is_empty() || text.is_empty() {
                continue;
            }
            map.entry(path).or_insert_with(|| text.clone());
        }
    }
    map
}

/// EPUB2 NCX: navPoint → (content src, navLabel text).
fn parse_ncx(bytes: &[u8], toc_dir: &str) -> HashMap<String, String> {
    let mut reader = Reader::from_reader(bytes);
    let mut buf = Vec::new();
    let mut map = HashMap::new();
    let mut in_navlabel = false;
    let mut in_text = false;
    let mut text_buf = String::new();
    let mut cur_label: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) | Err(_) => break,
            Ok(Event::Start(e)) => {
                let name = e.name();
                match name.local_name().as_ref() {
                    b"navPoint" => cur_label = None,
                    b"navLabel" => {
                        in_navlabel = true;
                        text_buf.clear();
                    }
                    b"text" if in_navlabel => {
                        in_text = true;
                        text_buf.clear();
                    }
                    b"content" => ncx_content(&e, toc_dir, &cur_label, &mut map),
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let name = e.name();
                if name.local_name().as_ref() == b"content" {
                    ncx_content(&e, toc_dir, &cur_label, &mut map);
                }
            }
            Ok(Event::Text(e)) => {
                if in_text {
                    if let Ok(t) = e.unescape() {
                        text_buf.push_str(&t);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.name();
                match name.local_name().as_ref() {
                    b"text" if in_text => in_text = false,
                    b"navLabel" => {
                        in_navlabel = false;
                        cur_label = Some(collapse_ws(&text_buf));
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        buf.clear();
    }
    map
}

fn ncx_content(
    e: &BytesStart,
    toc_dir: &str,
    label: &Option<String>,
    map: &mut HashMap<String, String>,
) {
    let Some(src) = attr_local(e, b"src") else {
        return;
    };
    let path = resolve_href(toc_dir, &src);
    if path.is_empty() {
        return;
    }
    if let Some(l) = label {
        if !l.is_empty() {
            map.entry(path).or_insert_with(|| l.clone());
        }
    }
}

/* ============================ OPF ============================ */

fn parse_container(bytes: &[u8]) -> Option<String> {
    let mut reader = Reader::from_reader(bytes);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) | Err(_) => break,
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                if e.name().local_name().as_ref() == b"rootfile" {
                    if let Some(p) = attr_local(&e, b"full-path") {
                        if !p.is_empty() {
                            return Some(p);
                        }
                    }
                }
            }
            _ => {}
        }
        buf.clear();
    }
    None
}

fn parse_opf(bytes: &[u8], opf_dir: &str) -> Opf {
    // section: 0 none, 1 metadata, 2 manifest, 3 spine.
    let mut section = 0u8;
    // capture: 0 none, 1 title, 2 creator.
    let mut capture = 0u8;
    let mut text_buf = String::new();

    let mut title: Option<String> = None;
    let mut author: Option<String> = None;
    let mut manifest: Vec<ManifestItem> = Vec::new();
    let mut spine: Vec<String> = Vec::new();
    let mut spine_toc: Option<String> = None;
    let mut cover_meta_id: Option<String> = None;

    let mut reader = Reader::from_reader(bytes);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) | Err(_) => break,
            Ok(Event::Start(e)) => {
                let name = e.name();
                match name.local_name().as_ref() {
                    b"metadata" => section = 1,
                    b"manifest" => section = 2,
                    b"spine" => {
                        section = 3;
                        if spine_toc.is_none() {
                            spine_toc = attr_local(&e, b"toc");
                        }
                    }
                    b"item" if section == 2 => push_item(&e, opf_dir, &mut manifest),
                    b"itemref" if section == 3 => {
                        if let Some(idref) = attr_local(&e, b"idref") {
                            spine.push(idref);
                        }
                    }
                    b"meta" if section == 1 => check_cover_meta(&e, &mut cover_meta_id),
                    b"title" if section == 1 && title.is_none() => {
                        capture = 1;
                        text_buf.clear();
                    }
                    b"creator" if section == 1 && author.is_none() => {
                        capture = 2;
                        text_buf.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let name = e.name();
                match name.local_name().as_ref() {
                    b"item" if section == 2 => push_item(&e, opf_dir, &mut manifest),
                    b"itemref" if section == 3 => {
                        if let Some(idref) = attr_local(&e, b"idref") {
                            spine.push(idref);
                        }
                    }
                    b"meta" if section == 1 => check_cover_meta(&e, &mut cover_meta_id),
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if capture != 0 {
                    if let Ok(t) = e.unescape() {
                        text_buf.push_str(&t);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.name();
                match name.local_name().as_ref() {
                    b"metadata" | b"manifest" | b"spine" => section = 0,
                    b"title" if capture == 1 => {
                        title = Some(collapse_ws(&text_buf));
                        capture = 0;
                    }
                    b"creator" if capture == 2 => {
                        author = Some(collapse_ws(&text_buf));
                        capture = 0;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        buf.clear();
    }

    Opf {
        title,
        author,
        manifest,
        spine,
        spine_toc,
        cover_meta_id,
    }
}

fn push_item(e: &BytesStart, opf_dir: &str, manifest: &mut Vec<ManifestItem>) {
    let (Some(id), Some(href)) = (attr_local(e, b"id"), attr_local(e, b"href")) else {
        return;
    };
    let media_type = attr_local(e, b"media-type")
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let properties = attr_local(e, b"properties").unwrap_or_default().to_lowercase();
    let zip_path = resolve_href(opf_dir, &href);
    manifest.push(ManifestItem {
        id,
        zip_path,
        media_type,
        properties,
    });
}

fn check_cover_meta(e: &BytesStart, cover_meta_id: &mut Option<String>) {
    let is_cover = attr_local(e, b"name")
        .map(|v| v.eq_ignore_ascii_case("cover"))
        .unwrap_or(false);
    if is_cover && cover_meta_id.is_none() {
        if let Some(content) = attr_local(e, b"content") {
            *cover_meta_id = Some(content);
        }
    }
}

/// First attribute whose *local* name (prefix-stripped) matches, XML-unescaped.
fn attr_local(e: &BytesStart, local: &[u8]) -> Option<String> {
    for a in e.attributes() {
        let Ok(a) = a else { continue };
        if a.key.local_name().as_ref() == local {
            return a.unescape_value().ok().map(|c| c.into_owned());
        }
    }
    None
}

/* ============================ path utils ============================ */

fn is_html(media_type: &str) -> bool {
    media_type == "application/xhtml+xml" || media_type == "text/html"
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn dir_of(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[..i].to_string(),
        None => String::new(),
    }
}

/// Resolve an href relative to `base_dir`: strip fragment/query, percent-decode,
/// then normalize `.`/`..` segments into a clean zip path.
fn resolve_href(base_dir: &str, href: &str) -> String {
    let href = href.split('#').next().unwrap_or(href);
    let href = href.split('?').next().unwrap_or(href);
    normalize_join(base_dir, &percent_decode(href))
}

fn normalize_join(base_dir: &str, rel: &str) -> String {
    let combined = if let Some(stripped) = rel.strip_prefix('/') {
        stripped.to_string()
    } else if base_dir.is_empty() {
        rel.to_string()
    } else {
        format!("{base_dir}/{rel}")
    };
    let mut stack: Vec<&str> = Vec::new();
    for seg in combined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            s => stack.push(s),
        }
    }
    stack.join("/")
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Flatten a zip path into a filesystem-safe single filename.
fn flat_name(zip_path: &str) -> String {
    zip_path
        .replace('/', "__")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn ext_of(path: &str) -> String {
    let file = path.rsplit('/').next().unwrap_or(path);
    match file.rfind('.') {
        Some(i) if i + 1 < file.len() => file[i + 1..]
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>()
            .to_lowercase(),
        _ => String::new(),
    }
}

/* ============================ tests ============================ */

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use std::path::PathBuf;
    use std::sync::PoisonError;
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("tarotalking-epub-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn build_epub() -> Vec<u8> {
        let mut zw = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

        let add = |zw: &mut zip::ZipWriter<Cursor<Vec<u8>>>, name: &str, data: &[u8]| {
            zw.start_file(name, opts).unwrap();
            zw.write_all(data).unwrap();
        };

        add(
            &mut zw,
            "META-INF/container.xml",
            br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
        );

        add(
            &mut zw,
            "OEBPS/content.opf",
            br#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title>
    <dc:creator>Jane Doe</dc:creator>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="chap1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chap2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="img1" href="images/pic%20one.png" media-type="image/png"/>
    <item id="cover-img" href="images/cover.png" media-type="image/png"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chap1"/>
    <itemref idref="chap2"/>
  </spine>
</package>"#,
        );

        add(
            &mut zw,
            "OEBPS/toc.ncx",
            br#"<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>Chapter One</text></navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
    <navPoint id="np2" playOrder="2">
      <navLabel><text>Chapter Two</text></navLabel>
      <content src="text/chapter2.xhtml#frag"/>
    </navPoint>
  </navMap>
</ncx>"#,
        );

        add(
            &mut zw,
            "OEBPS/chapter1.xhtml",
            br#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>C1</title></head>
<body><p>Hello one</p></body></html>"#,
        );

        // Note the ../ segment: resolves back up out of text/ then into images.
        add(
            &mut zw,
            "OEBPS/text/chapter2.xhtml",
            br#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>C2</title></head>
<body><p>Hello two</p><img src="../images/pic%20one.png"/></body></html>"#,
        );

        add(&mut zw, "OEBPS/images/pic one.png", b"\x89PNG\r\n\x1a\nFAKEPIC");
        add(&mut zw, "OEBPS/images/cover.png", b"\x89PNG\r\n\x1a\nFAKECOVER");

        zw.finish().unwrap().into_inner()
    }

    #[test]
    fn imports_full_epub() {
        let _guard = crate::library::ENV_LOCK
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let tmp = temp_dir("ok");
        std::env::set_var("APPDATA", &tmp);

        let epub_path = tmp.join("book.epub");
        std::fs::write(&epub_path, build_epub()).unwrap();

        let res = import_epub_blocking("test-book-1", epub_path.to_str().unwrap()).unwrap();

        // Metadata.
        assert_eq!(res.title.as_deref(), Some("Test Book"));
        assert_eq!(res.author.as_deref(), Some("Jane Doe"));

        // Chapter order + TOC title mapping.
        assert_eq!(res.chapters.len(), 2);
        assert_eq!(res.chapters[0].href, "OEBPS/chapter1.xhtml");
        assert_eq!(res.chapters[0].title.as_deref(), Some("Chapter One"));
        assert!(res.chapters[0].html.contains("Hello one"));
        assert_eq!(res.chapters[1].href, "OEBPS/text/chapter2.xhtml");
        // Fragment (#frag) must be stripped when mapping href → title.
        assert_eq!(res.chapters[1].title.as_deref(), Some("Chapter Two"));

        // Image extraction: keys are lowercased normalized zip paths; the
        // URL-encoded href resolved to a real, decoded zip path.
        assert!(res.images.contains_key("oebps/images/pic one.png"));
        let img_path = &res.images["oebps/images/pic one.png"];
        assert!(Path::new(img_path).exists());

        // Cover: extracted to cover.<ext>, present in the images map + cover_path.
        let cover = res.cover_path.expect("cover extracted");
        assert!(cover.ends_with("cover.png"));
        assert!(Path::new(&cover).exists());
        assert_eq!(res.images.get("oebps/images/cover.png"), Some(&cover));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn malformed_zip_is_friendly_error() {
        let _guard = crate::library::ENV_LOCK
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let tmp = temp_dir("bad");
        std::env::set_var("APPDATA", &tmp);

        let bad = tmp.join("broken.epub");
        std::fs::write(&bad, b"this is definitely not a zip archive").unwrap();

        let err = match import_epub_blocking("bad-id", bad.to_str().unwrap()) {
            Err(e) => e,
            Ok(_) => panic!("expected a malformed-zip error"),
        };
        assert_eq!(err.to_string(), "Not a valid EPUB file");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn name_lookup_prefers_exact_then_falls_back_to_case() {
        let names: Vec<String> = ["OEBPS/Chapter1.xhtml", "OEBPS/chapter1.xhtml", "OEBPS/Cover.PNG"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let idx = NameIndex::new(&names);

        // Exact match wins even when a case-variant sibling exists.
        assert_eq!(idx.find("OEBPS/chapter1.xhtml"), Some("OEBPS/chapter1.xhtml"));
        assert_eq!(idx.find("OEBPS/Chapter1.xhtml"), Some("OEBPS/Chapter1.xhtml"));
        // No exact match: case-insensitive fallback, first entry in zip order.
        assert_eq!(idx.find("oebps/CHAPTER1.xhtml"), Some("OEBPS/Chapter1.xhtml"));
        assert_eq!(idx.find("OEBPS/cover.png"), Some("OEBPS/Cover.PNG"));
        // Genuinely absent stays absent.
        assert_eq!(idx.find("OEBPS/missing.xhtml"), None);
    }

    #[test]
    fn entry_reads_are_capped_but_complete() {
        // A lying size header must not drive the allocation, and the data read
        // is whatever the reader actually yields.
        let data = vec![7u8; 100];
        let got = read_entry(&mut Cursor::new(data.clone()), u64::MAX).unwrap();
        assert_eq!(got, data);
        let got = read_entry(&mut Cursor::new(data.clone()), 0).unwrap();
        assert_eq!(got, data, "an under-declared entry still reads to the end");
    }

    #[test]
    fn path_normalization() {
        assert_eq!(normalize_join("OEBPS/text", "../images/x.png"), "OEBPS/images/x.png");
        assert_eq!(normalize_join("OEBPS", "chapter1.xhtml"), "OEBPS/chapter1.xhtml");
        assert_eq!(normalize_join("", "content.opf"), "content.opf");
        assert_eq!(percent_decode("pic%20one.png"), "pic one.png");
        assert_eq!(flat_name("OEBPS/images/pic one.png"), "OEBPS__images__pic_one.png");
        assert_eq!(ext_of("images/cover.PNG"), "png");
    }
}
