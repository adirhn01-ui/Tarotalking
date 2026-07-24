// PDF → ContentDoc chapters. pdfjs-dist does the raw text extraction; this
// module reconstructs lines/paragraphs/headings from item geometry and slices
// the document into chapters by its outline.
//
// The heavy pdfjs library is pulled in lazily (dynamic import inside the
// loader) so it never lands in the main chunk and never loads in the Node
// test environment. Everything the tests exercise is a PURE helper operating
// on plain {str,x,y,height}[] and {title,pageIndex}[] shapes — no pdfjs import.

import { normalizeWhitespace } from "./segment";
import type { Block, Chapter } from "./types";

/* ================= plain geometry shapes ================= */

/** One positioned text run from a page (pdfjs TextItem, flattened).
 *  x = transform[4], y = transform[5], height = item.height. */
export interface PdfItem {
  str: string;
  x: number;
  y: number;
  height: number;
}

/** A reconstructed line of text with its geometry. */
export interface PdfLine {
  text: string;
  /** Topmost y among the line's items (PDF coords: larger = higher). */
  y: number;
  /** Tallest item height on the line (drives heading detection). */
  maxHeight: number;
}

/** A reconstructed paragraph (one or more merged lines). */
export interface PdfParagraph {
  text: string;
  maxHeight: number;
  lineCount: number;
}

/** A resolved top-level outline entry. */
export interface OutlineTarget {
  title: string;
  /** 0-based page index the entry points at. */
  pageIndex: number;
}

/** An inclusive page range that becomes one chapter. */
export interface ChapterRange {
  title: string;
  start: number;
  end: number;
}

/* ================= tuning constants ================= */

/** Items whose y differ by no more than this share a line. */
const Y_TOLERANCE = 2.0;
/** A gap wider than this × the median line gap starts a new paragraph. */
const PARA_GAP_FACTOR = 1.6;
/** A single line this much taller than the page median reads as a heading. */
const HEADING_HEIGHT_FACTOR = 1.35;
/** Headings are short single lines. */
const HEADING_MAX_CHARS = 80;
/** Pages per chunk when a PDF has no usable outline. */
const CHUNK_PAGES = 20;

/* ================= pure helpers (unit-tested) ================= */

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Median height of the visible (non-blank) text items on a page. */
export function medianItemHeight(items: PdfItem[]): number {
  return median(items.filter((it) => it.str.trim() !== "" && it.height > 0).map((it) => it.height));
}

/** Reconstruct lines from positioned items: items within Y_TOLERANCE in y are
 *  one line, ordered left→right by x; lines are returned top→bottom. Blank
 *  items are dropped; interior whitespace is collapsed. */
export function groupLines(items: PdfItem[]): PdfLine[] {
  const usable = items.filter((it) => it.str.trim() !== "");
  const sorted = usable.slice().sort((a, b) => b.y - a.y); // top → bottom

  const groups: { items: PdfItem[]; refY: number }[] = [];
  for (const it of sorted) {
    const cur = groups[groups.length - 1];
    if (cur && Math.abs(it.y - cur.refY) <= Y_TOLERANCE) cur.items.push(it);
    else groups.push({ items: [it], refY: it.y });
  }

  const lines: PdfLine[] = [];
  for (const g of groups) {
    const ordered = g.items.slice().sort((a, b) => a.x - b.x);
    const text = normalizeWhitespace(ordered.map((i) => i.str).join(" "));
    if (!text) continue;
    lines.push({
      text,
      y: Math.max(...ordered.map((i) => i.y)),
      maxHeight: ordered.reduce((m, i) => Math.max(m, i.height || 0), 0),
    });
  }
  return lines;
}

/** Median vertical gap between consecutive lines (top→bottom order). */
export function medianLineGap(lines: PdfLine[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1]!.y - lines[i]!.y;
    if (gap > 0) gaps.push(gap);
  }
  return median(gaps);
}

/** Merge lines into paragraphs: a gap wider than PARA_GAP_FACTOR × the median
 *  line gap starts a new paragraph. When a line is appended, a trailing hyphen
 *  on the previous text whose continuation starts lowercase is repaired
 *  (hyphen dropped, words joined); otherwise lines join with a space. */
export function splitParagraphs(lines: PdfLine[]): PdfParagraph[] {
  const out: PdfParagraph[] = [];
  if (lines.length === 0) return out;

  const medGap = medianLineGap(lines);
  const threshold = medGap > 0 ? medGap * PARA_GAP_FACTOR : Infinity;

  let cur: PdfParagraph | null = null;
  let prevY = 0;
  for (const ln of lines) {
    const gap = cur ? prevY - ln.y : 0;
    if (!cur || gap > threshold) {
      if (cur) out.push(cur);
      cur = { text: ln.text, maxHeight: ln.maxHeight, lineCount: 1 };
    } else {
      if (/-$/.test(cur.text) && /^[a-z]/.test(ln.text)) {
        cur.text = cur.text.replace(/-$/, "") + ln.text;
      } else {
        cur.text = `${cur.text} ${ln.text}`;
      }
      cur.maxHeight = Math.max(cur.maxHeight, ln.maxHeight);
      cur.lineCount++;
    }
    prevY = ln.y;
  }
  if (cur) out.push(cur);
  return out;
}

/** Classify paragraphs into typed blocks. A short single-line paragraph that
 *  is markedly taller than the page median becomes an h2; everything else is a
 *  paragraph. */
export function paragraphsToBlocks(paras: PdfParagraph[], pageMedianHeight: number): Block[] {
  const out: Block[] = [];
  for (const p of paras) {
    const text = p.text.trim();
    if (!text) continue;
    const isHeading =
      p.lineCount === 1 &&
      text.length <= HEADING_MAX_CHARS &&
      pageMedianHeight > 0 &&
      p.maxHeight >= pageMedianHeight * HEADING_HEIGHT_FACTOR;
    out.push({ t: isHeading ? "h2" : "p", text });
  }
  return out;
}

/** Full pure pipeline for one page's items → blocks. */
export function pageToBlocks(items: PdfItem[]): Block[] {
  const lines = groupLines(items);
  if (lines.length === 0) return [];
  return paragraphsToBlocks(splitParagraphs(lines), medianItemHeight(items));
}

/** Build inclusive chapter page ranges from resolved outline targets. Invalid
 *  targets (out of range, blank title) are dropped; targets are sorted by page
 *  and de-duplicated (first title wins per page); each range runs to the page
 *  before the next entry (the last to numPages-1). Pages before the first
 *  entry become a "Front matter" range. Returns [] when nothing is usable. */
export function outlineRanges(targets: OutlineTarget[], numPages: number): ChapterRange[] {
  if (numPages <= 0) return [];

  const valid = targets
    .filter(
      (t) =>
        Number.isInteger(t.pageIndex) &&
        t.pageIndex >= 0 &&
        t.pageIndex < numPages &&
        normalizeWhitespace(t.title) !== "",
    )
    .map((t) => ({ title: normalizeWhitespace(t.title), pageIndex: t.pageIndex }))
    .sort((a, b) => a.pageIndex - b.pageIndex);

  const uniq: OutlineTarget[] = [];
  for (const t of valid) {
    if (uniq.length && uniq[uniq.length - 1]!.pageIndex === t.pageIndex) continue;
    uniq.push(t);
  }
  if (uniq.length === 0) return [];

  const ranges: ChapterRange[] = [];
  if (uniq[0]!.pageIndex > 0) {
    ranges.push({ title: "Front matter", start: 0, end: uniq[0]!.pageIndex - 1 });
  }
  for (let i = 0; i < uniq.length; i++) {
    const start = uniq[i]!.pageIndex;
    const end = i + 1 < uniq.length ? uniq[i + 1]!.pageIndex - 1 : numPages - 1;
    ranges.push({ title: uniq[i]!.title, start, end });
  }
  return ranges;
}

/** Fallback when a PDF has no usable outline: fixed-size page chunks. */
export function chunkPageRanges(numPages: number, size: number = CHUNK_PAGES): ChapterRange[] {
  const ranges: ChapterRange[] = [];
  if (numPages <= 0 || size <= 0) return ranges;
  for (let start = 0; start < numPages; start += size) {
    const end = Math.min(start + size - 1, numPages - 1);
    ranges.push({ title: `Pages ${start + 1}–${end + 1}`, start, end });
  }
  return ranges;
}

/* ================= thin pdfjs loader (not unit-tested) ================= */

export interface PdfInfo {
  title?: string;
  author?: string;
}

/** Flatten a pdfjs TextContent item list into plain PdfItems. */
function toPdfItems(rawItems: unknown[]): PdfItem[] {
  const items: PdfItem[] = [];
  for (const raw of rawItems) {
    const it = raw as { str?: unknown; transform?: unknown; height?: unknown };
    if (typeof it.str !== "string" || !Array.isArray(it.transform)) continue; // skip marked-content
    items.push({
      str: it.str,
      x: Number(it.transform[4]) || 0,
      y: Number(it.transform[5]) || 0,
      height: typeof it.height === "number" ? it.height : 0,
    });
  }
  return items;
}

/** Resolve an outline entry's `dest` (array ref or named string) to a 0-based
 *  page index. Returns null when it can't be resolved. */
async function resolveDest(
  doc: { getDestination(name: string): Promise<unknown[] | null>; getPageIndex(ref: unknown): Promise<number> },
  dest: string | unknown[] | null,
): Promise<number | null> {
  let explicit: unknown[] | null;
  if (typeof dest === "string") explicit = await doc.getDestination(dest);
  else explicit = Array.isArray(dest) ? dest : null;
  if (!explicit || explicit.length === 0) return null;
  const ref = explicit[0];
  if (!ref || typeof ref !== "object") return null;
  const idx = await doc.getPageIndex(ref);
  return typeof idx === "number" && idx >= 0 ? idx : null;
}

/** Parse PDF bytes into chapters + document metadata. Throws when the document
 *  yields no extractable text (e.g. a scanned/image-only PDF). */
export async function extractPdf(bytes: Uint8Array): Promise<{ chapters: Chapter[]; info: PdfInfo }> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const numPages = doc.numPages;

  // Document metadata (title/author) — tolerate a missing info dictionary.
  const info: PdfInfo = {};
  try {
    const meta = await doc.getMetadata();
    const raw = (meta.info ?? {}) as { Title?: unknown; Author?: unknown };
    const title = typeof raw.Title === "string" ? raw.Title.trim() : "";
    const author = typeof raw.Author === "string" ? raw.Author.trim() : "";
    if (title) info.title = title;
    if (author) info.author = author;
  } catch {
    /* no metadata */
  }

  // Per-page blocks, computed once each (ranges are disjoint, but memoize
  // defensively so a page is never rendered twice).
  const cache = new Map<number, Block[]>();
  const pageBlocks = async (pageIndex: number): Promise<Block[]> => {
    const hit = cache.get(pageIndex);
    if (hit) return hit;
    const page = await doc.getPage(pageIndex + 1); // pdfjs pages are 1-based
    const content = await page.getTextContent();
    const blocks = pageToBlocks(toPdfItems(content.items));
    cache.set(pageIndex, blocks);
    return blocks;
  };

  // Resolve the top-level outline into page targets (skip anything unresolvable).
  const targets: OutlineTarget[] = [];
  try {
    const outline = await doc.getOutline();
    if (outline) {
      for (const entry of outline) {
        try {
          const pageIndex = await resolveDest(doc, entry.dest);
          const title = (entry.title ?? "").trim();
          if (pageIndex != null && title) targets.push({ title, pageIndex });
        } catch {
          /* skip this entry */
        }
      }
    }
  } catch {
    /* no outline */
  }

  let ranges = outlineRanges(targets, numPages);
  if (ranges.length === 0) ranges = chunkPageRanges(numPages);

  const chapters: Chapter[] = [];
  for (const r of ranges) {
    const blocks: Block[] = [];
    for (let p = r.start; p <= r.end; p++) {
      for (const b of await pageBlocks(p)) blocks.push(b);
    }
    if (blocks.length > 0) chapters.push({ title: r.title, blocks });
  }

  if (chapters.length === 0) {
    throw new Error("This PDF has no extractable text — it may be a scanned document");
  }
  return { chapters, info };
}
