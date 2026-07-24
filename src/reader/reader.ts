// Reader view — the core reading surface. Owns the top bar, the scrolling page,
// the TOC panel, and the embedded player bar; integrates with the playback
// engine for live sentence/word highlighting, auto-scroll, and position sync.
//
// Contract: `mountReader(el, itemId): Promise<ReaderView>`. The engine is a
// global singleton that outlives this view, so dispose never unloads it (saved
// positions persist). Dispose does pause it, though: leaving the book stops
// playback, and reopening resumes from the same spot showing paused. Closing to
// the tray keeps playing — that path is handled in main.ts, not here.

import "./reader.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import { describeError } from "../core/ipc";
import { loadDoc } from "../core/import";
import {
  addAnnotation,
  addBookmark,
  flushLibrary,
  getItem,
  libraryStore,
  removeAnnotation,
  removeBookmark,
  setReadingPosition,
  touchOpened,
  updateAnnotation,
} from "../core/library";
import { formatPct, formatTimeLeft, readingMinutes } from "../core/format";
import { navigate } from "../core/nav";
import { normalizeWhitespace } from "../core/segment";
import { settingsStore, updateReaderPrefs } from "../core/session";
import { normalizeChord, ShortcutManager } from "../core/shortcuts";
import { subscribeSelect } from "../core/store";
import {
  ACTION_LABELS,
  PLAYBACK_RATES,
  READER_FONTS,
  readerFontStack,
  type ActionId,
  type Annotation,
  type AnnotationColor,
  type ContentDoc,
  type Position,
  type ReaderTheme,
} from "../core/types";
import { icon } from "../ui/icons";
import { trapTab } from "../ui/focus";
import { toast } from "../ui/toast";
import { activeWord, engine, engineState } from "../player/engine";
import { mountPlayerBar } from "../player/bar";
import {
  applyAnnotations,
  blockAnnotationRange,
  buildCharIndex,
  chapterWordCounts,
  createHighlighter,
  pctForPosition,
  renderChapter,
  sentenceHitForOffset,
  topmostBlockIndex,
  widthBucketLabel,
  type AnnRange,
} from "./render";
import { mountToc, type TocController } from "./toc";

export interface ReaderView {
  dispose(): void | Promise<void>;
}

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));
const round1 = (n: number): number => Math.round(n * 10) / 10;
const NARROW = 900;

// Panel open/closed default — module-level so it persists across reader remounts
// within a session (not to disk).
let tocOpenDefault = false;

const READER_THEMES: ReaderTheme[] = ["default", "paper", "sepia", "slate", "black"];
const THEME_LABELS: Record<ReaderTheme, string> = {
  default: "Default",
  paper: "Paper",
  sepia: "Sepia",
  slate: "Slate",
  black: "Black",
};

const HL_COLORS: AnnotationColor[] = ["yellow", "green", "blue", "pink"];
const HL_COLOR_LABELS: Record<AnnotationColor, string> = {
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  pink: "Pink",
};

/** A resolved selection mapped into block/char coordinates of one chapter. */
interface SelRange {
  chapter: number;
  startBlock: number;
  startChar: number;
  endBlock: number;
  endChar: number;
  snippet: string;
}

/** The subset of DOMRect the floating-element placer needs. */
interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export async function mountReader(el: HTMLElement, itemId: string): Promise<ReaderView> {
  const item = getItem(itemId);
  if (!item) {
    toast.error("This item is no longer in your library");
    navigate({ view: "library" });
    return { dispose(): void {} };
  }

  let doc: ContentDoc;
  try {
    doc = await loadDoc(itemId);
  } catch (e) {
    toast.error(describeError(e) || "This book could not be opened");
    navigate({ view: "library" });
    return { dispose(): void {} };
  }

  touchOpened(itemId);
  engine.load(itemId, doc, item.playback);

  const charIndex = buildCharIndex(doc);
  const chWordCounts = chapterWordCounts(doc);
  // When a speaking block drops its sentence spans, repaint its highlight marks.
  const highlighter = createHighlighter((blockEl) => {
    if (Number(blockEl.dataset.c) === renderedChapter) {
      applyBlockAnnotations(blockEl, renderedChapter, Number(blockEl.dataset.b));
    }
  });
  const chapterCount = doc.chapters.length;
  const wordCount = item.wordCount;

  // Extracted image paths → asset-protocol URLs (a no-op fallback off-desktop).
  const toAssetUrl = (p: string): string => {
    try {
      return convertFileSrc(p);
    } catch {
      return p;
    }
  };

  /* ---------------- layout ---------------- */

  const root = document.createElement("div");
  root.className = "reader no-select";
  root.innerHTML = `
    <div class="reader-body">
      <aside class="reader-toc"><div class="reader-toc__inner"></div></aside>
      <div class="reader-scroll">
        <article class="reader-surface"></article>
      </div>
    </div>
    <header class="reader-top">
      <div class="reader-top__side reader-top__left">
        <button class="btn btn--ghost btn--icon" data-a="back" title="Back to library">${icon.back}</button>
        <button class="btn btn--ghost btn--icon" data-a="toc" title="Contents (T)">${icon.list}</button>
      </div>
      <div class="reader-top__center">
        <div class="reader-title">
          <span class="reader-title__book"></span>
          <span class="reader-title__sep"> · </span>
          <span class="reader-title__chapter"></span>
          <span class="reader-eq" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
        <div class="reader-title__left faint"></div>
      </div>
      <div class="reader-top__side reader-top__right">
        <button class="btn btn--ghost btn--icon" data-a="aa" title="Display options">${icon.type}</button>
        <button class="btn btn--ghost btn--icon" data-a="bookmark" title="Bookmark (B)">${icon.bookmark}</button>
        <button class="btn btn--ghost btn--icon" data-a="focus" title="Focus mode (F)">${icon.focus}</button>
        <button class="btn btn--ghost btn--icon" data-a="full" title="Fullscreen (F11)">${icon.expand}</button>
      </div>
    </header>
    <footer class="reader-bottom"></footer>
    <div class="reader-pill" aria-hidden="true">
      <button class="btn btn--primary btn--icon btn--lg reader-pill__play" title="Play / pause">${icon.play}</button>
      <button class="btn btn--ghost btn--icon reader-pill__exit" title="Exit focus (Esc)">${icon.shrink}</button>
    </div>`;
  el.appendChild(root);

  const surface = root.querySelector<HTMLElement>(".reader-surface")!;
  const scroll = root.querySelector<HTMLElement>(".reader-scroll")!;
  const tocInner = root.querySelector<HTMLElement>(".reader-toc__inner")!;
  const bottom = root.querySelector<HTMLElement>(".reader-bottom")!;
  const bookTitleEl = root.querySelector<HTMLElement>(".reader-title__book")!;
  const chapterEl = root.querySelector<HTMLElement>(".reader-title__chapter")!;
  const leftEl = root.querySelector<HTMLElement>(".reader-title__left")!;
  const eqEl = root.querySelector<HTMLElement>(".reader-eq")!;
  const tocBtn = root.querySelector<HTMLButtonElement>('[data-a="toc"]')!;
  const aaBtn = root.querySelector<HTMLButtonElement>('[data-a="aa"]')!;
  const bookmarkBtn = root.querySelector<HTMLButtonElement>('[data-a="bookmark"]')!;
  const focusBtn = root.querySelector<HTMLButtonElement>('[data-a="focus"]')!;
  const fullBtn = root.querySelector<HTMLButtonElement>('[data-a="full"]')!;
  const pillPlay = root.querySelector<HTMLButtonElement>(".reader-pill__play")!;
  const pillExit = root.querySelector<HTMLButtonElement>(".reader-pill__exit")!;

  bookTitleEl.textContent = doc.title || item.title;

  const bar = mountPlayerBar(bottom);

  /* ---------------- reader style ---------------- */

  function applyReaderStyle(): void {
    const r = settingsStore.get().reader;
    surface.style.setProperty("--reader-font", readerFontStack(r.font));
    surface.style.setProperty("--reader-size", `${r.fontSize}px`);
    surface.style.setProperty("--reader-leading", String(r.lineHeight));
    surface.style.setProperty("--reader-width", `${r.width}px`);
    surface.dataset.justify = r.justify ? "on" : "off";
    scroll.dataset.readerTheme = r.theme;
  }
  applyReaderStyle();

  /* ---------------- chapter rendering ---------------- */

  let renderedChapter = -1;
  let blockEls: HTMLElement[] = [];
  let blockOffsets: number[] = [];
  // Block indices in the rendered chapter currently showing highlight marks.
  const markedBlocks = new Set<number>();

  function measure(): void {
    const scrollTop = scroll.getBoundingClientRect().top;
    const base = scroll.scrollTop - scrollTop;
    blockOffsets = blockEls.map((b) => b.getBoundingClientRect().top + base);
  }

  function renderChapterAt(ci: number): void {
    const target = clamp(ci, 0, Math.max(0, chapterCount - 1));
    highlighter.reset();
    renderedChapter = target;
    renderChapter(surface, doc, target, { imageSrc: toAssetUrl });
    blockEls = Array.from(surface.querySelectorAll<HTMLElement>("[data-b]"));
    markedBlocks.clear();
    applyAllAnnotations();
    measure();
    updateChapterLabel();
    toc.refresh();
    syncHighlight();
  }

  /* ---------------- highlight marks (annotations) ---------------- */

  // Char ranges every annotation covers within one block of the current chapter.
  function annRangesForBlock(chapter: number, block: number): AnnRange<Annotation>[] {
    const anns = getItem(itemId)?.annotations;
    if (!anns || anns.length === 0) return [];
    const text = doc.chapters[chapter]?.blocks[block]?.text ?? "";
    if (!text) return [];
    const out: AnnRange<Annotation>[] = [];
    for (const ann of anns) {
      if (ann.chapter !== chapter) continue;
      const r = blockAnnotationRange(ann, block, text.length);
      if (r) out.push({ ann, startChar: r.startChar, endChar: r.endChar });
    }
    return out;
  }

  // Paint (or strip) one block's marks. Never touches the speaking block, which
  // shows sentence spans instead; its marks are restored when spans are dropped.
  function applyBlockAnnotations(blockEl: HTMLElement, chapter: number, block: number): void {
    if (blockEl.dataset.spanned === "1") return;
    const text = doc.chapters[chapter]?.blocks[block]?.text ?? "";
    const ranges = annRangesForBlock(chapter, block);
    if (ranges.length === 0) {
      if (blockEl.querySelector("mark[data-ann]")) blockEl.textContent = text;
      markedBlocks.delete(block);
      return;
    }
    applyAnnotations(blockEl, text, ranges);
    markedBlocks.add(block);
  }

  function applyAllAnnotations(): void {
    const anns = getItem(itemId)?.annotations;
    if (!anns || anns.length === 0) return;
    const blocks = new Set<number>();
    for (const ann of anns) {
      if (ann.chapter !== renderedChapter) continue;
      for (let b = ann.startBlock; b <= ann.endBlock; b++) blocks.add(b);
    }
    for (const b of blocks) {
      const el = blockElByIndex(b);
      if (el) applyBlockAnnotations(el, renderedChapter, b);
    }
  }

  // Re-sync every mark in the chapter to the live annotation list. Strips blocks
  // that lost their annotations, then re-applies the rest — covers create,
  // color/note edits, and deletes (including edits from the Highlights tab).
  function refreshAnnotations(): void {
    for (const b of [...markedBlocks]) {
      const el = blockElByIndex(b);
      if (el && el.dataset.spanned !== "1" && el.querySelector("mark[data-ann]")) {
        el.textContent = doc.chapters[renderedChapter]?.blocks[b]?.text ?? "";
      }
    }
    markedBlocks.clear();
    applyAllAnnotations();
  }

  function blockElByIndex(blockIndex: number): HTMLElement | undefined {
    return blockEls.find((b) => Number(b.dataset.b) === blockIndex);
  }

  function scrollToBlockInstant(blockIndex: number, adjust = 12): void {
    const target = blockElByIndex(blockIndex) ?? blockEls[0];
    if (!target) return;
    const top =
      target.getBoundingClientRect().top -
      scroll.getBoundingClientRect().top +
      scroll.scrollTop -
      adjust;
    scroll.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  }

  /* ---------------- labels ---------------- */

  function updateChapterLabel(): void {
    const ch = doc.chapters[renderedChapter];
    chapterEl.textContent = ch && ch.title.trim() ? ch.title : `Chapter ${renderedChapter + 1}`;
  }

  function updateProgressLabel(pct: number): void {
    const words = wordCount;
    if (words <= 0 || pct <= 0) {
      leftEl.textContent = "";
      return;
    }
    const remaining = words * (1 - pct);
    leftEl.textContent = `≈ ${formatTimeLeft(readingMinutes(remaining))} left · ${formatPct(pct)}`;
  }

  /* ---------------- reading position tracking ---------------- */

  function currentTopPos(): Position {
    const idx = topmostBlockIndex(blockOffsets, scroll.scrollTop + 8);
    const el = blockEls[idx];
    if (!el) return { chapter: renderedChapter < 0 ? 0 : renderedChapter, block: 0, sentence: 0 };
    return { chapter: Number(el.dataset.c), block: Number(el.dataset.b), sentence: 0 };
  }

  function trackReadingPosition(): void {
    if (blockEls.length === 0) return;
    const pos = currentTopPos();
    const pct = pctForPosition(charIndex, pos);
    setReadingPosition(itemId, pos, pct, doc.chapters[pos.chapter]?.title);
    updateProgressLabel(pct);
    updateBookmarkBtn(pos);
  }

  let trackTimer: number | undefined;
  let lastTrack = 0;
  function scheduleTrack(): void {
    const now = Date.now();
    const elapsed = now - lastTrack;
    window.clearTimeout(trackTimer);
    if (elapsed >= 300) {
      lastTrack = now;
      requestAnimationFrame(trackReadingPosition);
    } else {
      trackTimer = window.setTimeout(() => {
        lastTrack = Date.now();
        requestAnimationFrame(trackReadingPosition);
      }, 300 - elapsed);
    }
  }

  /* ---------------- auto-scroll ---------------- */

  let suppressUntil = 0;
  const suppress = (): void => {
    suppressUntil = Date.now() + 3000;
  };
  const autoScrollAllowed = (): boolean => Date.now() >= suppressUntil;

  function scrollToActive(pos: Position, behavior: ScrollBehavior): void {
    const blockEl = blockElByIndex(pos.block);
    if (!blockEl || Number(blockEl.dataset.c) !== pos.chapter) return;
    const target =
      blockEl.querySelector<HTMLElement>(`.sent[data-s="${pos.sentence}"]`) ?? blockEl;
    target.scrollIntoView({ block: "center", behavior });
  }

  /* ---------------- highlight sync ---------------- */

  function applyHighlight(pos: Position | null): void {
    const status = engineState.get().status;
    const mode = settingsStore.get().playback.highlight;
    if (!pos || status === "idle" || mode === "off" || pos.chapter !== renderedChapter) {
      highlighter.clear();
      return;
    }
    const blockEl = blockElByIndex(pos.block);
    const text = doc.chapters[pos.chapter]?.blocks[pos.block]?.text ?? "";
    if (!blockEl) {
      highlighter.clear();
      return;
    }
    highlighter.move(blockEl, text, pos.sentence, mode);
  }

  function syncHighlight(): void {
    const s = engineState.get();
    if (s.itemId !== itemId) {
      highlighter.clear();
      return;
    }
    applyHighlight(s.pos);
  }

  /* ---------------- listening equalizer ---------------- */

  function updateEq(): void {
    const s = engineState.get();
    const mine = s.itemId === itemId;
    const active = mine && (s.status === "playing" || s.status === "loading" || s.status === "paused");
    const anim = mine && (s.status === "playing" || s.status === "loading");
    eqEl.classList.toggle("reader-eq--show", active);
    eqEl.classList.toggle("reader-eq--anim", anim);
  }

  let lastPillGlyph = "";
  function updatePill(): void {
    const s = engineState.get();
    const playing = s.itemId === itemId && (s.status === "playing" || s.status === "loading");
    const glyph = playing ? "pause" : "play";
    if (glyph !== lastPillGlyph) {
      lastPillGlyph = glyph;
      pillPlay.innerHTML = icon[glyph];
    }
  }

  /* ---------------- bookmark ---------------- */

  function updateBookmarkBtn(pos: Position = currentTopPos()): void {
    const it = getItem(itemId);
    const has = !!it?.bookmarks.some((bm) => bm.pos.chapter === pos.chapter && bm.pos.block === pos.block);
    bookmarkBtn.innerHTML = has ? icon.bookmarkFilled : icon.bookmark;
    bookmarkBtn.classList.toggle("btn--on", has);
  }

  function toggleBookmark(): void {
    const pos = currentTopPos();
    const it = getItem(itemId);
    if (!it) return;
    const existing = it.bookmarks.find(
      (bm) => bm.pos.chapter === pos.chapter && bm.pos.block === pos.block,
    );
    if (existing) {
      removeBookmark(itemId, existing.id);
      toast.info("Bookmark removed");
    } else {
      const raw =
        doc.chapters[pos.chapter]?.blocks[pos.block]?.text ??
        doc.chapters[pos.chapter]?.title ??
        "Bookmark";
      const label = raw.trim().slice(0, 60);
      addBookmark(itemId, { id: crypto.randomUUID(), pos, label, createdAt: Date.now() });
      toast.info("Bookmarked");
    }
    updateBookmarkBtn(pos);
    toc.refresh();
  }

  function flashBlock(blockIndex: number): void {
    const el = blockElByIndex(blockIndex);
    if (!el) return;
    el.classList.remove("block--flash");
    void el.offsetWidth; // restart animation
    el.classList.add("block--flash");
    window.setTimeout(() => el.classList.remove("block--flash"), 1300);
  }

  /* ---------------- jumping (TOC / bookmarks) ---------------- */

  function jumpTo(pos: Position, flash: boolean): void {
    if (pos.chapter !== renderedChapter) renderChapterAt(pos.chapter);
    scrollToBlockInstant(pos.block, 12);
    const p: Position = { chapter: pos.chapter, block: pos.block, sentence: 0 };
    const pct = pctForPosition(charIndex, p);
    setReadingPosition(itemId, p, pct, doc.chapters[p.chapter]?.title);
    updateProgressLabel(pct);
    updateBookmarkBtn(p);
    if (flash) flashBlock(pos.block);
  }

  const isNarrow = (): boolean => window.innerWidth < NARROW;

  const toc: TocController = mountToc(tocInner, {
    doc,
    itemId,
    chapterWordCounts: chWordCounts,
    currentChapter: () => renderedChapter,
    onJumpChapter: (pos) => {
      jumpTo(pos, false);
      if (isNarrow()) setToc(false);
    },
    onJumpBookmark: (pos) => {
      jumpTo(pos, true);
      if (isNarrow()) setToc(false);
    },
    onJumpHighlight: (pos) => {
      jumpTo(pos, true);
      if (isNarrow()) setToc(false);
    },
  });

  /* ---------------- TOC / focus / fullscreen ---------------- */

  function setToc(open: boolean): void {
    tocOpenDefault = open;
    root.classList.toggle("reader--toc-open", open);
    tocBtn.classList.toggle("btn--on", open);
  }
  function toggleToc(): void {
    setToc(!root.classList.contains("reader--toc-open"));
  }
  setToc(tocOpenDefault);

  let focusMode = false;
  function setFocus(on: boolean): void {
    focusMode = on;
    root.classList.toggle("reader--focus", on);
    focusBtn.classList.toggle("btn--on", on);
    if (on) setToc(false);
  }
  function toggleFocus(): void {
    setFocus(!focusMode);
  }

  const isFullscreen = (): boolean => document.fullscreenElement != null;
  function toggleFullscreen(): void {
    if (isFullscreen()) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen().catch(() => {});
  }
  const onFsChange = (): void => {
    fullBtn.innerHTML = isFullscreen() ? icon.shrink : icon.expand;
    fullBtn.title = isFullscreen() ? "Exit fullscreen (F11)" : "Fullscreen (F11)";
  };
  document.addEventListener("fullscreenchange", onFsChange);

  function onBack(): void {
    if (isFullscreen()) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (focusMode) {
      setFocus(false);
      return;
    }
    if (root.classList.contains("reader--toc-open")) {
      setToc(false);
      return;
    }
    navigate({ view: "library" });
  }

  /* ---------------- Aa popover ---------------- */

  let pop: HTMLElement | null = null;

  const onPopOutside = (e: PointerEvent): void => {
    if (pop && !pop.contains(e.target as Node) && e.target !== aaBtn && !aaBtn.contains(e.target as Node)) {
      closeAa();
    }
  };
  const onPopKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeAa();
    }
  };

  function closeAa(): void {
    if (!pop) return;
    pop.remove();
    pop = null;
    document.removeEventListener("pointerdown", onPopOutside, true);
    document.removeEventListener("keydown", onPopKey, true);
    aaBtn.classList.remove("btn--on");
  }

  function openAa(): void {
    pop = document.createElement("div");
    pop.className = "reader-pop";
    pop.innerHTML = `
      <div class="reader-pop__group">
        <div class="reader-fonts" data-ctl="font">
          ${READER_FONTS.map(
            (f) =>
              `<button type="button" class="reader-font" data-font="${f.id}" title="${f.label}"><span class="reader-font__ag" style="font-family:${f.stack}">Ag</span><span class="reader-font__label">${f.label}</span></button>`,
          ).join("")}
        </div>
      </div>
      <div class="reader-pop__group">
        <span class="reader-pop__label">Text size</span>
        <div class="reader-step">
          <button type="button" class="btn btn--ghost btn--sm" data-step="size" data-dir="-1">A−</button>
          <span class="reader-step__val" data-val="size"></span>
          <button type="button" class="btn btn--ghost btn--sm" data-step="size" data-dir="1">A+</button>
        </div>
      </div>
      <div class="reader-pop__group">
        <span class="reader-pop__label">Line spacing</span>
        <div class="reader-step">
          <button type="button" class="btn btn--ghost btn--sm" data-step="leading" data-dir="-1">−</button>
          <span class="reader-step__val" data-val="leading"></span>
          <button type="button" class="btn btn--ghost btn--sm" data-step="leading" data-dir="1">+</button>
        </div>
      </div>
      <div class="reader-pop__group">
        <span class="reader-pop__label">Width</span>
        <div class="reader-step">
          <button type="button" class="btn btn--ghost btn--sm" data-step="width" data-dir="-1">−</button>
          <span class="reader-step__val" data-val="width"></span>
          <button type="button" class="btn btn--ghost btn--sm" data-step="width" data-dir="1">+</button>
        </div>
      </div>
      <div class="reader-pop__group reader-pop__row">
        <span class="reader-pop__label">Justify</span>
        <input type="checkbox" class="switch" data-ctl="justify">
      </div>
      <div class="reader-pop__group">
        <div class="reader-swatches">
          ${READER_THEMES.map(
            (t) => `<button type="button" class="reader-swatch" data-theme="${t}" title="${THEME_LABELS[t]}"></button>`,
          ).join("")}
        </div>
      </div>`;
    root.appendChild(pop);

    // position under the Aa button, clamped into the viewport
    const r = aaBtn.getBoundingClientRect();
    pop.style.visibility = "hidden";
    const pw = pop.getBoundingClientRect().width;
    const left = clamp(r.right - pw, 8, window.innerWidth - pw - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${r.bottom + 8}px`;
    pop.style.visibility = "";

    pop.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-font],[data-step],[data-theme]");
      if (!el) return;
      const reader = settingsStore.get().reader;
      if (el.dataset.font) {
        updateReaderPrefs({ font: el.dataset.font });
      } else if (el.dataset.theme) {
        updateReaderPrefs({ theme: el.dataset.theme as ReaderTheme });
      } else if (el.dataset.step) {
        const dir = Number(el.dataset.dir);
        if (el.dataset.step === "size") {
          updateReaderPrefs({ fontSize: clamp(reader.fontSize + dir, 13, 30) });
        } else if (el.dataset.step === "leading") {
          updateReaderPrefs({ lineHeight: clamp(round1(reader.lineHeight + dir * 0.1), 1.2, 2.4) });
        } else if (el.dataset.step === "width") {
          updateReaderPrefs({ width: clamp(reader.width + dir * 40, 480, 1040) });
        }
      }
    });
    const justifyToggle = pop.querySelector<HTMLInputElement>('[data-ctl="justify"]')!;
    justifyToggle.addEventListener("change", () => updateReaderPrefs({ justify: justifyToggle.checked }));

    renderPop();
    aaBtn.classList.add("btn--on");
    // defer so the opening click doesn't immediately close it
    setTimeout(() => {
      if (pop) {
        document.addEventListener("pointerdown", onPopOutside, true);
        document.addEventListener("keydown", onPopKey, true);
      }
    });
  }

  function renderPop(): void {
    if (!pop) return;
    const r = settingsStore.get().reader;
    pop.querySelectorAll<HTMLElement>("[data-font]").forEach((b) => {
      b.classList.toggle("reader-font--on", b.dataset.font === r.font);
    });
    const size = pop.querySelector<HTMLElement>('[data-val="size"]');
    if (size) size.textContent = `${r.fontSize} px`;
    const leading = pop.querySelector<HTMLElement>('[data-val="leading"]');
    if (leading) leading.textContent = round1(r.lineHeight).toFixed(1);
    const width = pop.querySelector<HTMLElement>('[data-val="width"]');
    if (width) width.textContent = widthBucketLabel(r.width);
    const justify = pop.querySelector<HTMLInputElement>('[data-ctl="justify"]');
    if (justify) justify.checked = r.justify;
    pop.querySelectorAll<HTMLElement>("[data-theme]").forEach((b) => {
      b.classList.toggle("reader-swatch--on", b.dataset.theme === r.theme);
    });
  }

  function toggleAa(): void {
    if (pop) closeAa();
    else openAa();
  }

  /* ---------------- shortcuts modal ---------------- */

  const openCloseFns: Array<() => void> = [];

  function showShortcutsModal(): void {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal reader-shortcuts";
    modal.innerHTML = `
      <div class="modal__header">Keyboard shortcuts
        <button class="btn btn--ghost btn--icon" data-x title="Close">${icon.x}</button>
      </div>
      <div class="modal__body"><div class="reader-shortcuts__grid"></div></div>`;
    const grid = modal.querySelector<HTMLElement>(".reader-shortcuts__grid")!;
    const sh = settingsStore.get().shortcuts;
    (Object.keys(ACTION_LABELS) as ActionId[]).forEach((a) => {
      const row = document.createElement("div");
      row.className = "reader-shortcuts__row";
      const label = document.createElement("span");
      label.textContent = ACTION_LABELS[a];
      const kbd = document.createElement("kbd");
      kbd.textContent = normalizeChord(sh[a] ?? "") || "—";
      row.append(label, kbd);
      grid.appendChild(row);
    });
    const tipRow = document.createElement("div");
    tipRow.className = "reader-shortcuts__row";
    const tipLabel = document.createElement("span");
    tipLabel.textContent = "Click any sentence — start speaking from there";
    const tipKbd = document.createElement("kbd");
    tipKbd.textContent = "Click";
    tipRow.append(tipLabel, tipKbd);
    grid.appendChild(tipRow);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    const release = trapTab(modal);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    const close = (): void => {
      release();
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      const i = openCloseFns.indexOf(close);
      if (i >= 0) openCloseFns.splice(i, 1);
    };
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) close();
    });
    modal.querySelector("[data-x]")!.addEventListener("click", close);
    openCloseFns.push(close);
    modal.querySelector<HTMLButtonElement>("[data-x]")!.focus();
  }

  /* ---------------- top-bar wiring ---------------- */

  root.querySelector('[data-a="back"]')!.addEventListener("click", onBack);
  tocBtn.addEventListener("click", toggleToc);
  aaBtn.addEventListener("click", toggleAa);
  bookmarkBtn.addEventListener("click", toggleBookmark);
  focusBtn.addEventListener("click", toggleFocus);
  fullBtn.addEventListener("click", toggleFullscreen);
  pillPlay.addEventListener("click", () => engine.toggle());
  pillExit.addEventListener("click", () => setFocus(false));

  /* ---------------- shortcuts ---------------- */

  const sc = new ShortcutManager();
  const rebind = (): void => sc.setBindings(settingsStore.get().shortcuts);
  rebind();
  function stepRate(dir: number): void {
    const cur = settingsStore.get().playback.rate;
    let i = PLAYBACK_RATES.indexOf(cur);
    if (i < 0) i = PLAYBACK_RATES.indexOf(1);
    i = clamp(i + dir, 0, PLAYBACK_RATES.length - 1);
    engine.setRate(PLAYBACK_RATES[i]!);
  }
  sc.on("playPause", () => engine.toggle());
  sc.on("stop", () => engine.stop());
  sc.on("prevSentence", () => engine.prevSentence());
  sc.on("nextSentence", () => engine.nextSentence());
  sc.on("prevParagraph", () => engine.prevParagraph());
  sc.on("nextParagraph", () => engine.nextParagraph());
  sc.on("prevChapter", () => engine.prevChapter());
  sc.on("nextChapter", () => engine.nextChapter());
  sc.on("pageUp", () => scroll.scrollBy({ top: -0.9 * scroll.clientHeight, behavior: "smooth" }));
  sc.on("pageDown", () => scroll.scrollBy({ top: 0.9 * scroll.clientHeight, behavior: "smooth" }));
  sc.on("speedUp", () => stepRate(1));
  sc.on("speedDown", () => stepRate(-1));
  sc.on("addBookmark", toggleBookmark);
  sc.on("toggleToc", toggleToc);
  sc.on("toggleFocus", toggleFocus);
  sc.on("toggleFullscreen", toggleFullscreen);
  sc.on("fontBigger", () =>
    updateReaderPrefs({ fontSize: clamp(settingsStore.get().reader.fontSize + 1, 13, 30) }),
  );
  sc.on("fontSmaller", () =>
    updateReaderPrefs({ fontSize: clamp(settingsStore.get().reader.fontSize - 1, 13, 30) }),
  );
  sc.on("back", onBack);
  sc.on("openSettings", () => navigate({ view: "settings" }));
  sc.on("showShortcuts", showShortcutsModal);
  sc.attach();

  /* ---------------- reactive subscriptions ---------------- */

  const unsubReader = subscribeSelect(
    settingsStore,
    (s) => s.reader,
    () => {
      applyReaderStyle();
      renderPop();
      requestAnimationFrame(measure);
    },
  );
  const unsubShortcuts = subscribeSelect(settingsStore, (s) => s.shortcuts, rebind);
  const unsubHighlightMode = subscribeSelect(
    settingsStore,
    (s) => s.playback.highlight,
    () => syncHighlight(),
  );
  // Repaint marks whenever this item's annotations change (create/edit/delete),
  // including edits made from the Highlights tab.
  const unsubAnnotations = subscribeSelect(
    libraryStore,
    (idx) => idx.items.find((it) => it.id === itemId)?.annotations,
    () => refreshAnnotations(),
  );

  let lastPosKey = "";
  const unsubEngine = engineState.subscribe((s) => {
    updateEq();
    updatePill();
    if (s.itemId !== itemId) {
      highlighter.clear();
      return;
    }
    // Stopped / finished / errored: drop the highlight and re-arm so the next
    // playback re-applies it even if the position is unchanged.
    if (s.status === "idle" || s.status === "error") {
      highlighter.clear();
      lastPosKey = "";
      return;
    }
    const posKey = s.pos ? `${s.pos.chapter}.${s.pos.block}.${s.pos.sentence}` : "";
    if (posKey === lastPosKey) return;
    lastPosKey = posKey;
    if (!s.pos) {
      highlighter.clear();
      return;
    }
    const autoScroll = settingsStore.get().playback.autoScroll;
    const chapterChanged = s.pos.chapter !== renderedChapter;
    if (chapterChanged && autoScroll) {
      // Following playback into a new chapter: re-render and snap to the
      // spoken sentence instantly (we've committed to moving the view).
      renderChapterAt(s.pos.chapter);
      applyHighlight(s.pos);
      scrollToActive(s.pos, "auto");
      return;
    }
    applyHighlight(s.pos);
    if (autoScroll && autoScrollAllowed() && s.pos.chapter === renderedChapter) {
      scrollToActive(s.pos, "smooth");
    }
  });

  const unsubWord = activeWord.subscribe((w) => {
    if (settingsStore.get().playback.highlight !== "word") return;
    const s = engineState.get();
    if (s.itemId !== itemId || !s.pos || s.pos.chapter !== renderedChapter) return;
    if (w) highlighter.word(w.charStart, w.charLen);
    else highlighter.clearWord();
  });

  /* ---------------- click a sentence → read from there ---------------- */

  // Char offset of a hit (text node + offset) within its block's full text,
  // walking the block's text nodes in document order — works whether or not the
  // block currently carries sentence spans.
  function charOffsetInBlock(blockEl: Element, hitNode: Node, hitOffset: number): number {
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
    let total = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n === hitNode) return total + hitOffset;
      total += n.textContent?.length ?? 0;
    }
    return total;
  }

  function resolveClickPos(
    clientX: number,
    clientY: number,
  ): { pos: Position; charOffset: number } | null {
    const range = document.caretRangeFromPoint(clientX, clientY);
    if (!range) return null;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return null;
    const blockEl = node.parentElement?.closest<HTMLElement>("[data-b]");
    if (!blockEl) return null;
    const chapter = Number(blockEl.dataset.c);
    const block = Number(blockEl.dataset.b);
    const text = doc.chapters[chapter]?.blocks[block]?.text ?? "";
    if (!text) return null;
    const blockOffset = charOffsetInBlock(blockEl, node, range.startOffset);
    const { sentence, offset } = sentenceHitForOffset(text, blockOffset);
    return { pos: { chapter, block, sentence }, charOffset: offset };
  }

  let clickDownX = 0;
  let clickDownY = 0;
  let clickDownBad = true;
  const onSurfacePointerDown = (e: PointerEvent): void => {
    clickDownX = e.clientX;
    clickDownY = e.clientY;
    clickDownBad = e.button !== 0 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey;
  };
  const onSurfacePointerUp = (e: PointerEvent): void => {
    // A live (non-collapsed) selection is a highlight gesture, not a tap-to-read
    // one — show the highlight toolbar and stop. The click-to-read path below is
    // only ever reached with a COLLAPSED selection, so the two never conflict.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      showHlToolbar(sel);
      return;
    }
    // Clean primary click only: no modifiers, no drag.
    if (clickDownBad || e.button !== 0 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
    const dx = e.clientX - clickDownX;
    const dy = e.clientY - clickDownY;
    if (dx * dx + dy * dy >= 36) return; // moved >= 6px → treat as a drag, not a click
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // Click on an existing highlight → open its editor, not read-from-here.
    const mark = target.closest<HTMLElement>("mark[data-ann]");
    if (mark?.dataset.ann) {
      openAnnotationPopover(mark.dataset.ann, false, mark.getBoundingClientRect());
      return;
    }
    if (target.closest("img, hr, a, .reader-chapter-title")) return;
    const hit = resolveClickPos(e.clientX, e.clientY);
    // Start at the exact clicked word (in-sentence char offset), not the top of
    // the sentence — the engine seeks to that word when boundaries exist.
    if (hit) engine.playFrom(hit.pos, hit.charOffset);
  };
  surface.addEventListener("pointerdown", onSurfacePointerDown);
  surface.addEventListener("pointerup", onSurfacePointerUp);

  /* ---------------- highlight create / edit toolbars ---------------- */

  let hlToolbar: HTMLElement | null = null;
  let hlPop: HTMLElement | null = null;
  let pendingRange: SelRange | null = null;
  let hlPopFlush: (() => void) | null = null;

  // Place a fixed-position floating element centered over an anchor rect,
  // preferring above/below, clamped into the viewport.
  function placeFloating(elm: HTMLElement, anchor: RectLike, prefer: "above" | "below"): void {
    elm.style.visibility = "hidden";
    elm.style.left = "0px";
    elm.style.top = "0px";
    const r = elm.getBoundingClientRect();
    const pad = 8;
    const cx = (anchor.left + anchor.right) / 2;
    const left = clamp(cx - r.width / 2, pad, Math.max(pad, window.innerWidth - r.width - pad));
    let top = prefer === "above" ? anchor.top - r.height - pad : anchor.bottom + pad;
    if (prefer === "above" && top < pad) top = anchor.bottom + pad; // flip below if no room
    top = clamp(top, pad, Math.max(pad, window.innerHeight - r.height - pad));
    elm.style.left = `${left}px`;
    elm.style.top = `${top}px`;
    elm.style.visibility = "";
  }

  // The [data-b] block element containing a node, if within the reader surface.
  function nodeBlockEl(node: Node | null): HTMLElement | null {
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null);
    const block = el?.closest<HTMLElement>("[data-b]") ?? null;
    return block && surface.contains(block) ? block : null;
  }

  // Map a live selection to block/char coordinates of the rendered chapter. Both
  // endpoints must land in [data-b] blocks of this chapter; a range that starts
  // or ends outside them clamps to the first/last block it actually covers.
  function resolveSelectionRange(sel: Selection): SelRange | null {
    if (sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const covered = blockEls.filter(
      (el) => Number(el.dataset.c) === renderedChapter && range.intersectsNode(el),
    );
    if (covered.length === 0) return null;
    const startBlockEl = covered[0]!;
    const endBlockEl = covered[covered.length - 1]!;
    const startBlock = Number(startBlockEl.dataset.b);
    const endBlock = Number(endBlockEl.dataset.b);
    const startText = doc.chapters[renderedChapter]?.blocks[startBlock]?.text ?? "";
    const endText = doc.chapters[renderedChapter]?.blocks[endBlock]?.text ?? "";
    let startChar = 0;
    if (range.startContainer.nodeType === Node.TEXT_NODE && nodeBlockEl(range.startContainer) === startBlockEl) {
      startChar = charOffsetInBlock(startBlockEl, range.startContainer, range.startOffset);
    }
    let endChar = endText.length;
    if (range.endContainer.nodeType === Node.TEXT_NODE && nodeBlockEl(range.endContainer) === endBlockEl) {
      endChar = charOffsetInBlock(endBlockEl, range.endContainer, range.endOffset);
    }
    startChar = Math.max(0, Math.min(startChar, startText.length));
    endChar = Math.max(0, Math.min(endChar, endText.length));
    if (startBlock === endBlock && endChar <= startChar) return null;
    const snippet = normalizeWhitespace(range.toString()).slice(0, 80);
    if (!snippet) return null;
    return { chapter: renderedChapter, startBlock, startChar, endBlock, endChar, snippet };
  }

  const onHlToolbarOutside = (e: PointerEvent): void => {
    if (hlToolbar && !hlToolbar.contains(e.target as Node)) hideHlToolbar();
  };
  const onHlToolbarKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && hlToolbar) {
      e.preventDefault();
      e.stopPropagation();
      hideHlToolbar();
    }
  };
  const onHlSelectionChange = (): void => {
    const s = window.getSelection();
    if (hlToolbar && (!s || s.isCollapsed)) hideHlToolbar();
  };

  function hideHlToolbar(): void {
    if (!hlToolbar) return;
    hlToolbar.remove();
    hlToolbar = null;
    pendingRange = null;
    document.removeEventListener("pointerdown", onHlToolbarOutside, true);
    document.removeEventListener("keydown", onHlToolbarKey, true);
    document.removeEventListener("selectionchange", onHlSelectionChange);
  }

  function showHlToolbar(sel: Selection): void {
    const resolved = resolveSelectionRange(sel);
    hideHlToolbar();
    closeAnnotationPopover();
    if (!resolved) return;
    pendingRange = resolved;

    const bar = document.createElement("div");
    bar.className = "hl-toolbar";
    bar.innerHTML =
      HL_COLORS.map(
        (c) =>
          `<button type="button" class="hl-dot hl-c-${c}" data-color="${c}" title="${HL_COLOR_LABELS[c]}" aria-label="Highlight ${HL_COLOR_LABELS[c].toLowerCase()}"></button>`,
      ).join("") +
      `<span class="hl-toolbar__sep" aria-hidden="true"></span>` +
      `<button type="button" class="btn btn--ghost btn--sm hl-toolbar__note">Note</button>` +
      `<span class="hl-toolbar__sep hl-toolbar__sep--end" aria-hidden="true"></span>` +
      `<button type="button" class="btn btn--ghost btn--icon btn--sm hl-toolbar__dismiss" title="Dismiss">${icon.x}</button>`;
    root.appendChild(bar);
    hlToolbar = bar;

    const rects = sel.getRangeAt(0).getClientRects();
    const anchor = rects.length ? rects[rects.length - 1]! : sel.getRangeAt(0).getBoundingClientRect();
    placeFloating(bar, anchor, "above");

    bar.addEventListener("click", (e) => {
      const dot = (e.target as HTMLElement).closest<HTMLElement>("[data-color]");
      if (dot?.dataset.color) {
        createAnnotation(dot.dataset.color as AnnotationColor, false);
      } else if ((e.target as HTMLElement).closest(".hl-toolbar__note")) {
        createAnnotation("yellow", true);
      } else if ((e.target as HTMLElement).closest(".hl-toolbar__dismiss")) {
        hideHlToolbar();
        window.getSelection()?.removeAllRanges();
      }
    });

    // Defer so the opening pointerup doesn't immediately dismiss the toolbar.
    setTimeout(() => {
      if (!hlToolbar) return;
      document.addEventListener("pointerdown", onHlToolbarOutside, true);
      document.addEventListener("keydown", onHlToolbarKey, true);
      document.addEventListener("selectionchange", onHlSelectionChange);
    });
  }

  function createAnnotation(color: AnnotationColor, openNote: boolean): void {
    const r = pendingRange;
    if (!r) {
      hideHlToolbar();
      return;
    }
    const ann: Annotation = {
      id: crypto.randomUUID(),
      color,
      chapter: r.chapter,
      startBlock: r.startBlock,
      startChar: r.startChar,
      endBlock: r.endBlock,
      endChar: r.endChar,
      snippet: r.snippet,
      createdAt: Date.now(),
    };
    hideHlToolbar();
    addAnnotation(itemId, ann);
    window.getSelection()?.removeAllRanges();
    // Paint immediately (the store subscription also fires, on a microtask).
    refreshAnnotations();
    if (openNote) {
      const el = blockElByIndex(ann.startBlock)?.querySelector<HTMLElement>(`mark[data-ann="${ann.id}"]`);
      openAnnotationPopover(ann.id, true, el ? el.getBoundingClientRect() : null);
    }
  }

  const onHlPopOutside = (e: PointerEvent): void => {
    if (hlPop && !hlPop.contains(e.target as Node)) closeAnnotationPopover();
  };
  const onHlPopKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && hlPop) {
      e.preventDefault();
      e.stopPropagation();
      closeAnnotationPopover();
    }
  };

  function closeAnnotationPopover(): void {
    if (!hlPop) return;
    hlPopFlush?.();
    hlPopFlush = null;
    hlPop.remove();
    hlPop = null;
    document.removeEventListener("pointerdown", onHlPopOutside, true);
    document.removeEventListener("keydown", onHlPopKey, true);
  }

  function openAnnotationPopover(annId: string, focusNote: boolean, anchor: RectLike | null): void {
    closeAnnotationPopover();
    hideHlToolbar();
    const getAnn = (): Annotation | undefined =>
      getItem(itemId)?.annotations?.find((a) => a.id === annId);
    const ann = getAnn();
    if (!ann) return;

    const popEl = document.createElement("div");
    popEl.className = "hl-pop";
    popEl.innerHTML = `
      <div class="hl-pop__dots">
        ${HL_COLORS.map(
          (c) =>
            `<button type="button" class="hl-dot hl-c-${c}" data-color="${c}" title="${HL_COLOR_LABELS[c]}" aria-label="${HL_COLOR_LABELS[c]}"></button>`,
        ).join("")}
      </div>
      <textarea class="input hl-pop__note" placeholder="Add a note" spellcheck="true"></textarea>
      <button type="button" class="btn btn--ghost btn--danger btn--sm hl-pop__del">Delete</button>`;
    root.appendChild(popEl);
    hlPop = popEl;

    const note = popEl.querySelector<HTMLTextAreaElement>(".hl-pop__note")!;
    note.value = ann.note ?? "";

    const paintDots = (color: AnnotationColor): void => {
      popEl.querySelectorAll<HTMLElement>("[data-color]").forEach((d) => {
        d.classList.toggle("hl-dot--on", d.dataset.color === color);
      });
    };
    paintDots(ann.color);

    popEl.querySelector(".hl-pop__dots")!.addEventListener("click", (e) => {
      const dot = (e.target as HTMLElement).closest<HTMLElement>("[data-color]");
      if (!dot?.dataset.color) return;
      const color = dot.dataset.color as AnnotationColor;
      updateAnnotation(itemId, annId, { color });
      paintDots(color);
    });

    let noteTimer: number | undefined;
    note.addEventListener("input", () => {
      window.clearTimeout(noteTimer);
      noteTimer = window.setTimeout(() => updateAnnotation(itemId, annId, { note: note.value }), 400);
    });
    hlPopFlush = (): void => {
      window.clearTimeout(noteTimer);
      const cur = getAnn();
      if (cur && (cur.note ?? "") !== note.value) updateAnnotation(itemId, annId, { note: note.value });
    };

    popEl.querySelector(".hl-pop__del")!.addEventListener("click", () => {
      hlPopFlush = null; // don't flush a note write for an annotation we're deleting
      closeAnnotationPopover();
      removeAnnotation(itemId, annId);
    });

    placeFloating(
      popEl,
      anchor ?? { left: window.innerWidth / 2, right: window.innerWidth / 2, top: 96, bottom: 96 },
      "below",
    );
    if (focusNote) setTimeout(() => note.focus());
    setTimeout(() => {
      if (!hlPop) return;
      document.addEventListener("pointerdown", onHlPopOutside, true);
      document.addEventListener("keydown", onHlPopKey, true);
    });
  }

  /* ---------------- scroll + resize ---------------- */

  scroll.addEventListener("scroll", scheduleTrack, { passive: true });
  scroll.addEventListener("wheel", suppress, { passive: true });
  scroll.addEventListener("touchstart", suppress, { passive: true });
  scroll.addEventListener("touchmove", suppress, { passive: true });
  scroll.addEventListener("pointerdown", suppress);
  const onResize = (): void => measure();
  window.addEventListener("resize", onResize);

  /* ---------------- initial paint ---------------- */

  renderChapterAt(item.reading.chapter);
  scrollToBlockInstant(item.reading.block);
  updateBookmarkBtn();
  updateProgressLabel(item.progressPct);
  updateEq();
  updatePill();

  /* ---------------- dispose ---------------- */

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;

      // With the mini player enabled (default), leaving the reader keeps playback
      // going — the library shows a compact now-playing bar (sibling-built). With
      // it off, leaving pauses (position persists, so reopening resumes from the
      // same spot showing paused). Window-close/tray keeps playing and is handled
      // in main.ts. pause() is a no-op when nothing is playing.
      if (!settingsStore.get().miniPlayer) engine.pause();

      // Persist the reading position immediately.
      const pos = currentTopPos();
      setReadingPosition(itemId, pos, pctForPosition(charIndex, pos), doc.chapters[pos.chapter]?.title);
      void flushLibrary();

      unsubReader();
      unsubShortcuts();
      unsubHighlightMode();
      unsubAnnotations();
      unsubEngine();
      unsubWord();
      sc.detach();
      bar.dispose();
      toc.dispose();
      closeAa();
      hideHlToolbar();
      closeAnnotationPopover();
      for (const close of openCloseFns.splice(0)) close();

      surface.removeEventListener("pointerdown", onSurfacePointerDown);
      surface.removeEventListener("pointerup", onSurfacePointerUp);
      scroll.removeEventListener("scroll", scheduleTrack);
      scroll.removeEventListener("wheel", suppress);
      scroll.removeEventListener("touchstart", suppress);
      scroll.removeEventListener("touchmove", suppress);
      scroll.removeEventListener("pointerdown", suppress);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("fullscreenchange", onFsChange);
      window.clearTimeout(trackTimer);

      if (isFullscreen()) void document.exitFullscreen().catch(() => {});
      root.remove();
    },
  };
}
