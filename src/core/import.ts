// Import pipeline: normalize every source (EPUB, txt/md, pasted text, URL) into
// a ContentDoc + LibraryItem.
//
// Contract (frozen — main.ts and views call these):
//   importFiles(paths)             → item ids created (toasts per-file errors)
//   importPastedText(title?, text) → item id (toasts errors itself, or null)
//   importUrl(url)                 → item id (toasts errors itself, or null)
//   loadDoc(itemId)                → ContentDoc (from the per-item doc.json cache)

import { convertFileSrc } from "@tauri-apps/api/core";
import { describeError, ipc } from "./ipc";
import { addItem } from "./library";
import { countWords } from "./segment";
import { fileExt, fileName, fileStem } from "./format";
import { domToBlocks } from "./epub-blocks";
import { extractArticle } from "./readability";
import type { Block, Chapter, ContentDoc, LibraryItem, SourceType } from "./types";
import { POSITION_ZERO } from "./types";
import { toast } from "../ui/toast";

/* ================= pure helpers (unit-tested) ================= */

/** Strip inline Markdown emphasis, code, and link syntax to plain text.
 *  Deliberately leaves lone underscores alone (snake_case is common). */
export function stripMarkdownInline(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/\*([^*\n]+)\*/g, "$1") // *italic*
    .replace(/`([^`]+)`/g, "$1"); // `code`
}

/** Split plain/markdown text on blank lines into typed blocks. Headings
 *  (`#`..`###`) and blockquotes (`>`) are recognized in both modes; inline
 *  Markdown markers are only stripped when `markdown` is true. */
export function chunkTextToBlocks(text: string, markdown: boolean): Block[] {
  const out: Block[] = [];
  const strip = (s: string): string => (markdown ? stripMarkdownInline(s) : s);
  for (const chunk of text.split(/\n\s*\n/)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    const heading = /^(#{1,3})[ \t]+([\s\S]+)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      const t = strip(normalizeInline(heading[2]!)).trim();
      if (t) out.push({ t: level === 1 ? "h1" : level === 2 ? "h2" : "h3", text: t });
      continue;
    }

    if (/^>/.test(trimmed)) {
      const body = trimmed.replace(/^[ \t]*>[ \t]?/gm, "");
      const t = strip(normalizeInline(body)).trim();
      if (t) out.push({ t: "blockquote", text: t });
      continue;
    }

    const t = strip(normalizeInline(trimmed)).trim();
    if (t) out.push({ t: "p", text: t });
  }
  return out;
}

/** Collapse the single newlines inside one chunk into spaces. */
function normalizeInline(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Resolve an EPUB chapter-relative image `src` to its lowercased,
 *  zip-relative lookup key (or null for external/data URIs). */
export function resolveZipImagePath(chapterHref: string, src: string): string | null {
  if (!src) return null;
  let s = src.trim();
  if (/^(https?:|data:|mailto:|blob:)/i.test(s)) return null;
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep the raw form if it isn't valid percent-encoding */
  }
  s = s.replace(/[?#].*$/, "").replace(/\\/g, "/");
  if (!s) return null;

  const dir = chapterHref.replace(/\\/g, "/").replace(/[^/]*$/, "");
  const base = s.startsWith("/") ? s.slice(1) : dir + s;

  const parts: string[] = [];
  for (const seg of base.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const key = parts.join("/").toLowerCase();
  return key || null;
}

/** Choose a title for pasted text: explicit title, else the first non-empty
 *  line (capped at 60 chars), else a generic fallback. */
export function pasteTitle(title: string | null, text: string): string {
  const explicit = (title ?? "").trim();
  if (explicit) return explicit;
  const firstLine = text.split("\n").map((l) => l.trim()).find(Boolean);
  if (firstLine) return firstLine.slice(0, 60).trim();
  return "Pasted text";
}

/** Prepend https:// when the URL carries no scheme. */
export function normalizeUrl(url: string): string {
  const u = url.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return `https://${u}`;
  return u;
}

/** Sum word counts across every text-bearing block in a set of chapters. */
export function countDocWords(chapters: Chapter[]): number {
  let n = 0;
  for (const ch of chapters) {
    for (const b of ch.blocks) if (b.text) n += countWords(b.text);
  }
  return n;
}

/* ================= internals ================= */

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function firstHeadingText(blocks: Block[]): string | null {
  for (const b of blocks) {
    if (b.t === "h1" || b.t === "h2") {
      const t = (b.text ?? "").trim();
      if (t) return t;
    }
  }
  return null;
}

function parseDoc(html: string, mime: DOMParserSupportedType): Document | null {
  if (typeof DOMParser === "undefined") return null;
  return new DOMParser().parseFromString(html, mime);
}

/** XHTML first (EPUB is XML); fall back to lenient HTML parsing on error. */
function parseChapter(html: string): Document | null {
  let doc = parseDoc(html, "application/xhtml+xml");
  if (doc && doc.querySelector("parsererror")) doc = parseDoc(html, "text/html");
  return doc;
}

interface NewItemParams {
  id: string;
  title: string;
  author?: string;
  sourceType: SourceType;
  sourceUrl?: string;
  wordCount: number;
  chapterCount: number;
  cover?: string;
}

function makeItem(p: NewItemParams): LibraryItem {
  return {
    id: p.id,
    title: p.title,
    ...(p.author ? { author: p.author } : {}),
    sourceType: p.sourceType,
    ...(p.sourceUrl ? { sourceUrl: p.sourceUrl } : {}),
    addedAt: Date.now(),
    favorite: false,
    collections: [],
    wordCount: p.wordCount,
    chapterCount: p.chapterCount,
    ...(p.cover ? { cover: p.cover } : {}),
    reading: { ...POSITION_ZERO },
    playback: { ...POSITION_ZERO },
    progressPct: 0,
    bookmarks: [],
  };
}

async function importEpubFile(path: string): Promise<{ id: string; title: string }> {
  const id = crypto.randomUUID();
  const res = await ipc.importEpub(id, path);

  const chapters: Chapter[] = [];
  let included = 0;
  for (const raw of res.chapters) {
    const doc = parseChapter(raw.html);
    const rootEl = doc?.body ?? doc?.documentElement ?? null;
    if (!rootEl) continue;

    const resolveImg = (src: string): string | null => {
      const key = resolveZipImagePath(raw.href, src);
      if (!key) return null;
      const abs = res.images[key];
      return abs ? convertFileSrc(abs) : null;
    };

    const blocks = domToBlocks(rootEl, resolveImg);
    if (blocks.length === 0) continue;

    included++;
    const title = raw.title?.trim() || firstHeadingText(blocks) || `Chapter ${included}`;
    // The reader renders the chapter title itself — drop a leading heading
    // block that just repeats it, or the heading shows twice.
    const first = blocks[0];
    if (
      first &&
      (first.t === "h1" || first.t === "h2" || first.t === "h3") &&
      (first.text ?? "").trim().toLowerCase() === title.trim().toLowerCase()
    ) {
      blocks.shift();
      if (blocks.length === 0) continue;
    }
    chapters.push({ title, blocks });
  }

  if (chapters.length === 0) throw new Error("This EPUB has no readable content");

  const title = res.title?.trim() || fileStem(path);
  const author = res.author?.trim() || undefined;
  const wordCount = countDocWords(chapters);
  const doc: ContentDoc = author
    ? { version: 1, title, author, chapters }
    : { version: 1, title, chapters };

  await ipc.writeDoc(id, doc);
  addItem(
    makeItem({
      id,
      title,
      author,
      sourceType: "epub",
      wordCount,
      chapterCount: chapters.length,
      cover: res.coverPath ?? undefined,
    }),
  );
  return { id, title };
}

async function importPdfFile(path: string): Promise<{ id: string; title: string }> {
  const bytes = await ipc.readFileBytes(path);
  // pdfjs (heavy) lives behind a dynamic import inside extractPdf; loading it
  // here keeps the PDF path fully lazy.
  const { extractPdf } = await import("./pdf-blocks");
  const { chapters, info } = await extractPdf(bytes);
  if (chapters.length === 0) {
    throw new Error("This PDF has no extractable text — it may be a scanned document");
  }

  const title = info.title?.trim() || fileStem(path);
  const author = info.author?.trim() || undefined;
  const id = crypto.randomUUID();
  const wordCount = countDocWords(chapters);
  const doc: ContentDoc = author
    ? { version: 1, title, author, chapters }
    : { version: 1, title, chapters };

  await ipc.writeDoc(id, doc);
  addItem(
    makeItem({ id, title, author, sourceType: "pdf", wordCount, chapterCount: chapters.length }),
  );
  return { id, title };
}

async function importTextFile(path: string, markdown: boolean): Promise<{ id: string; title: string }> {
  const text = await ipc.readTextFile(path);
  const title = fileStem(path);
  // Markdown goes through a real parser (marked → inert DOM → blocks) so
  // lists, nested emphasis, code fences, and tables import faithfully;
  // plain text keeps the fast blank-line chunker.
  let blocks: Block[];
  if (markdown) {
    const { marked } = await import("marked");
    const html = await marked.parse(text, { gfm: true });
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const root = parsed.body ?? parsed.documentElement;
    blocks = root ? domToBlocks(root, () => null) : [];
    if (blocks.length === 0) blocks = chunkTextToBlocks(text, true); // pathological md: fall back
  } else {
    blocks = chunkTextToBlocks(text, false);
  }
  if (blocks.length === 0) throw new Error("This file has no readable text");

  const chapters: Chapter[] = [{ title, blocks }];
  const id = crypto.randomUUID();
  const wordCount = countDocWords(chapters);
  const doc: ContentDoc = { version: 1, title, chapters };

  await ipc.writeDoc(id, doc);
  addItem(makeItem({ id, title, sourceType: "text", wordCount, chapterCount: 1 }));
  return { id, title };
}

/* ================= public API ================= */

export async function importFiles(paths: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const path of paths) {
    try {
      const ext = fileExt(path);
      let created: { id: string; title: string };
      if (ext === "epub") created = await importEpubFile(path);
      else if (ext === "pdf") created = await importPdfFile(path);
      else if (ext === "txt" || ext === "md") created = await importTextFile(path, ext === "md");
      else throw new Error("Unsupported file type");
      ids.push(created.id);
      toast.info(`Added ${created.title}`);
    } catch (e) {
      toast.error(`${fileName(path)}: ${describeError(e)}`);
    }
  }
  return ids;
}

export async function importPastedText(title: string | null, text: string): Promise<string | null> {
  try {
    if (!text || !text.trim()) throw new Error("Nothing to import");
    const finalTitle = pasteTitle(title, text);
    const blocks = chunkTextToBlocks(text, false);
    if (blocks.length === 0) throw new Error("Nothing to import");

    const chapters: Chapter[] = [{ title: finalTitle, blocks }];
    const id = crypto.randomUUID();
    const wordCount = countDocWords(chapters);
    const doc: ContentDoc = { version: 1, title: finalTitle, chapters };

    await ipc.writeDoc(id, doc);
    addItem(makeItem({ id, title: finalTitle, sourceType: "paste", wordCount, chapterCount: 1 }));
    return id;
  } catch (e) {
    toast.error(describeError(e));
    return null;
  }
}

export async function importUrl(url: string): Promise<string | null> {
  try {
    const page = await ipc.fetchUrl(normalizeUrl(url));
    const doc = parseDoc(page.body, "text/html");
    if (!doc) throw new Error("Couldn't read this page");

    const article = extractArticle(doc);
    if (!article || article.blocks.length === 0) {
      throw new Error("Couldn't find readable article content on this page");
    }

    const title = article.title?.trim() || hostOf(page.finalUrl) || "Web article";
    const chapters: Chapter[] = [{ title, blocks: article.blocks }];
    const id = crypto.randomUUID();
    const wordCount = countDocWords(chapters);
    const doc2: ContentDoc = article.byline
      ? { version: 1, title, author: article.byline, chapters }
      : { version: 1, title, chapters };

    await ipc.writeDoc(id, doc2);
    addItem(
      makeItem({
        id,
        title,
        author: article.byline,
        sourceType: "url",
        sourceUrl: page.finalUrl,
        wordCount,
        chapterCount: 1,
      }),
    );
    return id;
  } catch (e) {
    toast.error(describeError(e));
    return null;
  }
}

export async function loadDoc(itemId: string): Promise<ContentDoc> {
  const raw = await ipc.readDoc(itemId);
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { chapters?: unknown }).chapters)) {
    throw new Error("This item's content is unreadable");
  }
  return raw as ContentDoc;
}
