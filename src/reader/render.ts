// Reader block rendering + sentence-span management.
//
// This file is split in two: a set of PURE helpers (position math, class
// computation, chapter word math, range math) with no DOM dependency — unit
// tested in render.test.ts — and the DOM builders below them. The pure section
// touches no globals at module load, so importing this file under Node (the
// vitest environment) is safe; the DOM functions are only ever called in the
// WebView.

import { countWords, splitSentences, type SentenceSpan } from "../core/segment";
import type { BlockType, ContentDoc, HighlightMode, Position } from "../core/types";

/* ============================================================
   PURE helpers (no DOM) — unit tested
   ============================================================ */

/** Char-weighted cumulative index over a document, used for reading-progress
 *  math. Mirrors the playback engine's own char index (same speakable rule and
 *  +1 per block) so reading and listening percentages agree. */
export interface CharIndex {
  /** Absolute char offset at the start of each chapter. */
  chapterStart: number[];
  /** Absolute char offset at the start of each block (per chapter). */
  blockStart: number[][];
  /** Total document chars (>= 1). */
  total: number;
}

function blockChars(t: BlockType, text: string | undefined): number {
  if (t === "img" || t === "hr") return 0;
  if (typeof text !== "string" || text.trim().length === 0) return 0;
  return text.length + 1;
}

export function buildCharIndex(doc: ContentDoc): CharIndex {
  const chapterStart: number[] = [];
  const blockStart: number[][] = [];
  let acc = 0;
  for (const ch of doc.chapters) {
    chapterStart.push(acc);
    const starts: number[] = [];
    for (const b of ch.blocks) {
      starts.push(acc);
      acc += blockChars(b.t, b.text);
    }
    blockStart.push(starts);
  }
  return { chapterStart, blockStart, total: Math.max(1, acc) };
}

/** Overall document fraction (0..1) for a position, at block granularity
 *  (reading position tracks the top block, sentence 0). */
export function pctForPosition(index: CharIndex, pos: Position): number {
  const base = index.blockStart[pos.chapter]?.[pos.block] ?? index.chapterStart[pos.chapter] ?? 0;
  return Math.max(0, Math.min(1, base / index.total));
}

/** Word count per chapter (for TOC time estimates). */
export function chapterWordCounts(doc: ContentDoc): number[] {
  return doc.chapters.map((ch) => {
    let n = 0;
    for (const b of ch.blocks) if (typeof b.text === "string") n += countWords(b.text);
    return n;
  });
}

/** Bucket a column width into a human label for the width stepper. */
export function widthBucketLabel(width: number): string {
  if (width <= 560) return "Narrow";
  if (width <= 760) return "Medium";
  return "Wide";
}

/** Index of the topmost block at or above `scrollTop`, from a sorted list of
 *  block offsets. Binary search; returns 0 when nothing is above, -1 when the
 *  list is empty. */
export function topmostBlockIndex(offsets: number[], scrollTop: number): number {
  if (offsets.length === 0) return -1;
  let lo = 0;
  let hi = offsets.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid]! <= scrollTop) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Nearest sentence index for a char offset, given precomputed spans. The span
 *  the offset falls inside wins; otherwise the closest span by interval distance
 *  (ties favor the earlier sentence). */
function nearestSentence(spans: SentenceSpan[], charOffset: number): number {
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    if (charOffset >= s.start && charOffset < s.end) return i;
  }
  // Gap / out-of-range: pick the span whose [start, end) interval is closest.
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    const dist = charOffset < s.start ? s.start - charOffset : charOffset - (s.end - 1);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** Map a char offset within a block's full text to the sentence index that
 *  contains it (click-a-word-to-read resolution). When the offset lands in
 *  inter-sentence whitespace (a gap between spans, or before the first / past
 *  the last), fall back to the nearest sentence by interval distance. Uses the
 *  same splitSentences offsets the engine speaks, so the returned index maps to
 *  a real playback position. */
export function sentenceIndexForOffset(blockText: string, charOffset: number): number {
  const spans = splitSentences(blockText);
  if (spans.length === 0) return 0;
  return nearestSentence(spans, charOffset);
}

/** Resolve a block-text char offset to BOTH the sentence it falls in and the
 *  char offset WITHIN that sentence (clamped to >= 0), from a single
 *  splitSentences pass. Powers exact-word click-to-read: the reader hands the
 *  in-sentence offset to the engine, which seeks to that word's audio boundary
 *  when the provider reports one (otherwise playback starts at the sentence). */
export function sentenceHitForOffset(
  blockText: string,
  charOffset: number,
): { sentence: number; offset: number } {
  const spans = splitSentences(blockText);
  if (spans.length === 0) return { sentence: 0, offset: 0 };
  const sentence = nearestSentence(spans, charOffset);
  return { sentence, offset: Math.max(0, charOffset - spans[sentence]!.start) };
}

export interface WordParts {
  before: string;
  word: string;
  after: string;
}

/** Split sentence text into [before, word, after] around a char range,
 *  clamping to the string so a stale boundary can never throw. */
export function splitWordParts(text: string, charStart: number, charLen: number): WordParts {
  const len = text.length;
  const start = Math.max(0, Math.min(charStart, len));
  const end = Math.max(start, Math.min(charStart + Math.max(0, charLen), len));
  return { before: text.slice(0, start), word: text.slice(start, end), after: text.slice(end) };
}

/** Result of filtering a labeled list for the TOC search. */
export interface LabelFilter {
  /** Indices into the source array to render — capped at `cap` while filtering,
   *  every index (uncapped) for an empty query. */
  indices: number[];
  /** Matched items dropped by the cap (0 when nothing was dropped). */
  overflow: number;
  /** Whether a non-empty query was applied (drives "No matches" vs the full list). */
  filtered: boolean;
}

/** Case-insensitive substring filter over a labeled list, returning matched
 *  indices. An empty/whitespace query is a no-op (all indices, uncapped). While
 *  filtering, at most `cap` indices are returned and the remainder is reported
 *  as `overflow`, so a 6k-chapter book's matches never blow up the DOM. */
export function filterByLabel<T>(
  items: T[],
  query: string,
  labelOf: (item: T, index: number) => string,
  cap = 400,
): LabelFilter {
  const q = query.trim().toLowerCase();
  if (q === "") return { indices: items.map((_, i) => i), overflow: 0, filtered: false };
  const indices: number[] = [];
  let matched = 0;
  for (let i = 0; i < items.length; i++) {
    if (labelOf(items[i]!, i).toLowerCase().includes(q)) {
      matched++;
      if (indices.length < cap) indices.push(i);
    }
  }
  return { indices, overflow: matched - indices.length, filtered: true };
}

/** The HTML tag a text block renders into. */
export function blockTag(t: BlockType): string {
  switch (t) {
    case "h1":
      return "h1";
    case "h2":
      return "h2";
    case "h3":
      return "h3";
    case "blockquote":
      return "blockquote";
    case "li":
      return "li";
    case "code":
      return "pre";
    default:
      return "p";
  }
}

/* ============================================================
   DOM builders (WebView only — never touched by tests)
   ============================================================ */

export interface RenderResolvers {
  /** Map an absolute image path to a URL the WebView can load. */
  imageSrc(absPath: string): string;
}

/** Render one chapter's blocks into `surface`, replacing prior content.
 *  Every text block carries data-c / data-b so highlight + position tracking
 *  can find it. Sentence spans are NOT added here — only on demand. */
export function renderChapter(
  surface: HTMLElement,
  doc: ContentDoc,
  chapterIndex: number,
  resolvers: RenderResolvers,
): void {
  surface.textContent = "";
  const ch = doc.chapters[chapterIndex];
  if (!ch) return;
  const frag = document.createDocumentFragment();

  const title = document.createElement("h1");
  title.className = "reader-chapter-title";
  title.textContent = ch.title ?? "";
  frag.appendChild(title);

  ch.blocks.forEach((b, i) => {
    const el = renderBlock(b.t, b.text, b.src, b.marker, chapterIndex, i, resolvers);
    if (el) frag.appendChild(el);
  });
  surface.appendChild(frag);
}

function renderBlock(
  t: BlockType,
  text: string | undefined,
  src: string | undefined,
  marker: string | undefined,
  chapter: number,
  index: number,
  resolvers: RenderResolvers,
): HTMLElement | null {
  if (t === "hr") {
    const hr = document.createElement("hr");
    hr.className = "reader-hr";
    return hr;
  }
  if (t === "img") {
    if (!src) return null;
    const img = document.createElement("img");
    img.className = "reader-img";
    img.loading = "lazy";
    img.alt = "";
    img.src = resolvers.imageSrc(src);
    return img;
  }
  const el = document.createElement(blockTag(t));
  el.className = `reader-block reader-block--${t}`;
  el.dataset.c = String(chapter);
  el.dataset.b = String(index);
  if (t === "li") el.dataset.marker = marker && marker.trim() ? marker.trim() : "•";
  el.textContent = text ?? "";
  return el;
}

/** Wrap a block element's text into sentence spans (idempotent). Uses the same
 *  splitSentences offsets as the engine, so data-s indices line up with the
 *  engine's sentence positions exactly. Gaps between sentences are preserved as
 *  plain text nodes. */
export function ensureSentenceSpans(el: HTMLElement, text: string): void {
  if (el.dataset.spanned === "1") return;
  const spans = splitSentences(text);
  const frag = document.createDocumentFragment();
  let cursor = 0;
  spans.forEach((s, i) => {
    if (s.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, s.start)));
    const span = document.createElement("span");
    span.className = "sent";
    span.dataset.s = String(i);
    span.textContent = text.slice(s.start, s.end);
    frag.appendChild(span);
    cursor = s.end;
  });
  if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
  el.textContent = "";
  el.appendChild(frag);
  el.dataset.spanned = "1";
}

/** Restore a block element to plain text (drops sentence spans). */
export function clearSentenceSpans(el: HTMLElement, text: string): void {
  if (el.dataset.spanned !== "1") return;
  el.textContent = text;
  delete el.dataset.spanned;
}

/** Wrap the active word inside a sentence span (rebuilds only that span). */
export function setSentenceWord(sentEl: HTMLElement, charStart: number, charLen: number): void {
  const text = sentEl.textContent ?? "";
  const { before, word, after } = splitWordParts(text, charStart, charLen);
  if (!word) {
    clearSentenceWord(sentEl);
    return;
  }
  sentEl.textContent = "";
  if (before) sentEl.appendChild(document.createTextNode(before));
  const w = document.createElement("span");
  w.className = "sent__word";
  w.textContent = word;
  sentEl.appendChild(w);
  if (after) sentEl.appendChild(document.createTextNode(after));
}

/** Collapse a sentence span back to a single text node (drops word markup). */
export function clearSentenceWord(sentEl: HTMLElement): void {
  if (sentEl.querySelector(".sent__word")) sentEl.textContent = sentEl.textContent;
}

/** Stateful controller for the single highlighted block/sentence. Only ever one
 *  block carries spans at a time. */
export interface Highlighter {
  /** Drop internal refs without touching the DOM (after a chapter re-render). */
  reset(): void;
  /** Remove spans from the current block and reset. */
  clear(): void;
  /** Move the highlight to a sentence in `blockEl` (null clears). Returns the
   *  sentence element so the caller can scroll it into view. */
  move(blockEl: HTMLElement | null, text: string, sentence: number, mode: HighlightMode): HTMLElement | null;
  word(charStart: number, charLen: number): void;
  clearWord(): void;
}

export function createHighlighter(): Highlighter {
  let curBlockEl: HTMLElement | null = null;
  let curText = "";
  let curSentEl: HTMLElement | null = null;

  function dropBlock(): void {
    if (curBlockEl && curBlockEl.isConnected) clearSentenceSpans(curBlockEl, curText);
    curBlockEl = null;
    curText = "";
    curSentEl = null;
  }

  return {
    reset(): void {
      curBlockEl = null;
      curText = "";
      curSentEl = null;
    },
    clear(): void {
      dropBlock();
    },
    move(blockEl, text, sentence, mode): HTMLElement | null {
      if (curBlockEl && curBlockEl !== blockEl) dropBlock();
      if (!blockEl) {
        curSentEl = null;
        return null;
      }
      if (curBlockEl !== blockEl) {
        ensureSentenceSpans(blockEl, text);
        curBlockEl = blockEl;
        curText = text;
      }
      if (curSentEl) {
        curSentEl.classList.remove("sent--speaking");
        clearSentenceWord(curSentEl);
      }
      const sentEl = blockEl.querySelector<HTMLElement>(`.sent[data-s="${sentence}"]`);
      if (sentEl) {
        sentEl.classList.add("sent--speaking");
        if (mode !== "word") clearSentenceWord(sentEl);
      }
      curSentEl = sentEl;
      return sentEl;
    },
    word(charStart, charLen): void {
      if (curSentEl) setSentenceWord(curSentEl, charStart, charLen);
    },
    clearWord(): void {
      if (curSentEl) clearSentenceWord(curSentEl);
    },
  };
}
