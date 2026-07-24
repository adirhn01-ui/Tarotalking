// Reader side panel: Contents + Bookmarks + Highlights tabs. Owns no reading
// surface — it asks the reader to jump via callbacks and reads live library
// state for bookmarks/highlights. The Contents tab also drives per-chapter
// audio pre-synthesis, which goes through the shared job queue so it lines up
// with whole-book prepares and exports instead of colliding with them.
// Mounted into the reader's TOC host.

import { cancelJob, enqueue, jobsStore } from "../core/jobs";
import { formatRelative, formatTimeLeft, readingMinutes } from "../core/format";
import { getItem, libraryStore, removeAnnotation, removeBookmark } from "../core/library";
import { splitSentences } from "../core/segment";
import { settingsStore } from "../core/session";
import { subscribeSelect } from "../core/store";
import type { Chapter, ContentDoc, LibraryItem, Position, VoiceRef } from "../core/types";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";
import { filterByLabel, prepareAudioSizeLabel } from "./render";

export interface TocOptions {
  doc: ContentDoc;
  itemId: string;
  chapterWordCounts: number[];
  /** Currently rendered chapter index (for the "you are here" highlight). */
  currentChapter(): number;
  /** Jump to a chapter start (no flash). */
  onJumpChapter(pos: Position): void;
  /** Jump to a bookmark (reader flashes the block). */
  onJumpBookmark(pos: Position): void;
  /** Jump to a highlight's start block (reader flashes the block). */
  onJumpHighlight(pos: Position): void;
}

export interface TocController {
  dispose(): void;
  /** Re-render the active list (current-chapter highlight, bookmark changes). */
  refresh(): void;
}

type Tab = "contents" | "bookmarks" | "highlights";

const SEARCH_PLACEHOLDER: Record<Tab, string> = {
  contents: "Search chapters",
  bookmarks: "Search bookmarks",
  highlights: "Search highlights",
};

export function mountToc(host: HTMLElement, opts: TocOptions): TocController {
  let tab: Tab = "contents";
  let query = "";

  const root = document.createElement("div");
  root.className = "toc";
  root.innerHTML = `
    <div class="toc__tabs">
      <button class="btn btn--sm toc__tab" data-tab="contents">Contents</button>
      <button class="btn btn--sm toc__tab" data-tab="bookmarks">Bookmarks</button>
      <button class="btn btn--sm toc__tab" data-tab="highlights">Highlights</button>
    </div>
    <div class="toc__search">
      <span class="toc__search-icon" aria-hidden="true">${icon.search}</span>
      <input class="input toc__search-input" type="text" autocomplete="off" spellcheck="false" aria-label="Search the contents">
      <button class="toc__search-clear" type="button" title="Clear search" aria-label="Clear search" hidden>${icon.x}</button>
    </div>
    <div class="toc__list" role="list"></div>`;
  host.appendChild(root);

  const list = root.querySelector<HTMLElement>(".toc__list")!;
  const search = root.querySelector<HTMLInputElement>(".toc__search-input")!;
  const clearBtn = root.querySelector<HTMLButtonElement>(".toc__search-clear")!;
  const tabButtons = Array.from(root.querySelectorAll<HTMLButtonElement>(".toc__tab"));

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      tab = btn.dataset.tab as Tab;
      // Keep the query across tabs and re-apply it to the newly active list.
      renderTabs();
      renderList();
    });
  });

  function applyQuery(next: string): void {
    query = next;
    clearBtn.hidden = query === "";
    renderList();
  }
  search.addEventListener("input", () => applyQuery(search.value));
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // Clear in place; never let Escape bubble to the reader's Back action.
      e.stopPropagation();
      e.preventDefault();
      if (search.value !== "") {
        search.value = "";
        applyQuery("");
      }
    }
  });
  clearBtn.addEventListener("click", () => {
    search.value = "";
    applyQuery("");
    search.focus();
  });

  function chapterLabel(ch: Chapter, i: number): string {
    return ch.title && ch.title.trim() ? ch.title : `Chapter ${i + 1}`;
  }

  function appendNote(text: string): void {
    const note = document.createElement("div");
    note.className = "toc__note faint";
    note.textContent = text;
    list.appendChild(note);
  }

  function renderTabs(): void {
    tabButtons.forEach((btn) => btn.classList.toggle("btn--on", btn.dataset.tab === tab));
    search.placeholder = SEARCH_PLACEHOLDER[tab];
  }

  function renderList(): void {
    list.textContent = "";
    if (tab === "contents") renderContents();
    else if (tab === "bookmarks") renderBookmarks();
    else renderHighlights();
  }

  /* ---------------- per-chapter prepare-audio ---------------- */

  const preparedChapters = new Set<number>(); // completed this session
  let runningChapter: number | null = null;
  let runningPct = 0;

  /** Chapter index → its queued/running job id. */
  const chapterJobs = new Map<number, string>();

  function effectiveVoice(): VoiceRef | null {
    return getItem(opts.itemId)?.voice ?? settingsStore.get().playback.voice;
  }

  function prepareSizeLabel(ci: number): string {
    const voice = effectiveVoice();
    // No voice yet → estimate against the default free provider; the click still
    // asks the user to pick one before actually pre-synthesizing.
    const provider = voice?.provider ?? "edge";
    return prepareAudioSizeLabel(
      opts.chapterWordCounts[ci] ?? 0,
      provider,
      settingsStore.get().audioQuality,
    );
  }

  /** The chapter's speakable sentences, in order (mirrors the engine's rule). */
  function chapterSentences(ci: number): string[] {
    const ch = opts.doc.chapters[ci];
    if (!ch) return [];
    const out: string[] = [];
    for (const b of ch.blocks) {
      if (b.t === "img" || b.t === "hr") continue;
      if (typeof b.text !== "string" || b.text.trim().length === 0) continue;
      for (const s of splitSentences(b.text)) out.push(s.text);
    }
    return out;
  }

  function renderPrepareButton(btn: HTMLButtonElement, ci: number): void {
    btn.classList.remove("toc__prep--running", "toc__prep--done");
    if (runningChapter === ci) {
      btn.classList.add("toc__prep--running");
      btn.textContent = `${Math.round(runningPct * 100)}%`;
      btn.title = "Preparing audio — click to cancel";
    } else if (chapterJobs.has(ci)) {
      // Waiting behind another audio job; clicking still cancels it.
      btn.classList.add("toc__prep--running");
      btn.textContent = "…";
      btn.title = "Queued — click to cancel";
    } else if (preparedChapters.has(ci)) {
      btn.classList.add("toc__prep--done");
      btn.innerHTML = icon.check;
      btn.title = "Audio prepared";
    } else {
      btn.innerHTML = icon.download;
      btn.title = `Prepare audio (~${prepareSizeLabel(ci)})`;
    }
  }

  function updatePrepareButton(ci: number): void {
    const btn = list.querySelector<HTMLButtonElement>(`[data-prep="${ci}"]`);
    if (btn) renderPrepareButton(btn, ci);
  }

  function startPrepare(ci: number): void {
    const voice = effectiveVoice();
    if (!voice) {
      toast.error("Pick a voice first");
      return;
    }
    const texts = chapterSentences(ci);
    if (texts.length === 0) {
      toast.info("Nothing to prepare in this chapter");
      return;
    }
    const item = getItem(opts.itemId);
    const jobId = enqueue({
      kind: "prepare",
      itemId: opts.itemId,
      title: `${item?.title ?? opts.doc.title} · ${chapterLabel(opts.doc.chapters[ci]!, ci)}`,
      cover: item?.cover,
      // Per-chapter jobs of one book must queue side by side, not dedupe.
      scope: `ch-${ci}`,
      provider: voice.provider,
      voiceId: voice.id,
      texts,
    });
    chapterJobs.set(ci, jobId);
    syncFromJobs();
  }

  function onPrepareClick(ci: number): void {
    const jobId = chapterJobs.get(ci);
    if (jobId) {
      cancelJob(jobId);
      return;
    }
    if (preparedChapters.has(ci)) return; // already prepared this session
    startPrepare(ci);
  }

  /** Mirror queue state onto the chapter buttons. The queue owns failure
   *  toasts, so this only tracks per-chapter visuals. */
  function syncFromJobs(): void {
    const jobs = jobsStore.get().jobs;
    let nextRunning: number | null = null;
    let nextPct = 0;
    for (const [ci, jobId] of [...chapterJobs]) {
      const job = jobs.find((j) => j.id === jobId);
      if (!job) {
        chapterJobs.delete(ci);
        updatePrepareButton(ci);
        continue;
      }
      if (job.status === "running") {
        nextRunning = ci;
        nextPct = job.total > 0 ? job.received / job.total : 0;
      } else if (job.status !== "queued") {
        if (job.status === "done") preparedChapters.add(ci);
        chapterJobs.delete(ci);
        updatePrepareButton(ci);
      }
    }
    if (nextRunning !== runningChapter || nextPct !== runningPct) {
      const prev = runningChapter;
      runningChapter = nextRunning;
      runningPct = nextPct;
      if (prev !== null && prev !== nextRunning) updatePrepareButton(prev);
      if (nextRunning !== null) updatePrepareButton(nextRunning);
    }
  }

  const unsubJobs = jobsStore.subscribe(() => syncFromJobs());

  /* ---------------- lists ---------------- */

  function renderContents(): void {
    const current = opts.currentChapter();
    const chapters = opts.doc.chapters;
    const { indices, overflow, filtered } = filterByLabel(chapters, query, chapterLabel);
    if (filtered && indices.length === 0) {
      appendNote("No matches");
      return;
    }
    for (const i of indices) {
      const ch = chapters[i]!;
      const row = document.createElement("div");
      row.className = "toc__row toc__chapter";
      row.classList.toggle("toc__row--current", i === current);

      const main = document.createElement("button");
      main.className = "toc__chapter-main";
      main.type = "button";

      const title = document.createElement("span");
      title.className = "toc__row-title";
      title.textContent = chapterLabel(ch, i);

      const mins = document.createElement("span");
      mins.className = "toc__row-meta faint";
      const words = opts.chapterWordCounts[i] ?? 0;
      mins.textContent = words > 0 ? formatTimeLeft(readingMinutes(words)) : "";

      main.append(title, mins);
      main.addEventListener("click", () => opts.onJumpChapter({ chapter: i, block: 0, sentence: 0 }));

      const prep = document.createElement("button");
      prep.className = "btn btn--ghost btn--icon btn--sm toc__prep";
      prep.type = "button";
      prep.dataset.prep = String(i);
      renderPrepareButton(prep, i);
      prep.addEventListener("click", (e) => {
        e.stopPropagation();
        onPrepareClick(i);
      });

      row.append(main, prep);
      list.appendChild(row);
    }
    if (overflow > 0) appendNote(`…and ${overflow} more — keep typing`);
  }

  function renderBookmarks(): void {
    const item = getItem(opts.itemId);
    const bookmarks = item?.bookmarks ?? [];
    if (bookmarks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "toc__empty faint";
      empty.textContent = "No bookmarks yet — press B while reading.";
      list.appendChild(empty);
      return;
    }
    // Newest first.
    const sorted = [...bookmarks].sort((a, b) => b.createdAt - a.createdAt);
    const { indices, overflow, filtered } = filterByLabel(sorted, query, (bm) => bm.label || "Bookmark");
    if (filtered && indices.length === 0) {
      appendNote("No matches");
      return;
    }
    for (const idx of indices) {
      const bm = sorted[idx]!;
      const row = document.createElement("div");
      row.className = "toc__row toc__bookmark";

      const main = document.createElement("button");
      main.className = "toc__bookmark-main";
      main.type = "button";

      const label = document.createElement("span");
      label.className = "toc__row-title";
      label.textContent = bm.label || "Bookmark";

      const time = document.createElement("span");
      time.className = "toc__row-meta faint";
      time.textContent = formatRelative(bm.createdAt);

      main.append(label, time);
      main.addEventListener("click", () => opts.onJumpBookmark(bm.pos));

      const del = document.createElement("button");
      del.className = "btn btn--ghost btn--icon btn--sm toc__bookmark-del";
      del.type = "button";
      del.title = "Remove bookmark";
      del.innerHTML = icon.x;
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        removeBookmark(opts.itemId, bm.id);
      });

      row.append(main, del);
      list.appendChild(row);
    }
    if (overflow > 0) appendNote(`…and ${overflow} more — keep typing`);
  }

  function renderHighlights(): void {
    const item = getItem(opts.itemId);
    const anns = item?.annotations ?? [];
    if (anns.length === 0) {
      const empty = document.createElement("div");
      empty.className = "toc__empty faint";
      empty.textContent = "No highlights yet — select some text while reading.";
      list.appendChild(empty);
      return;
    }
    // Newest first.
    const sorted = [...anns].sort((a, b) => b.createdAt - a.createdAt);
    const { indices, overflow, filtered } = filterByLabel(
      sorted,
      query,
      (a) => `${a.snippet} ${a.note ?? ""}`,
    );
    if (filtered && indices.length === 0) {
      appendNote("No matches");
      return;
    }
    for (const idx of indices) {
      const ann = sorted[idx]!;
      const row = document.createElement("div");
      row.className = "toc__row toc__hl";

      const main = document.createElement("button");
      main.className = "toc__hl-main";
      main.type = "button";

      const dot = document.createElement("span");
      dot.className = `toc__hl-dot hl-c-${ann.color}`;

      const textWrap = document.createElement("span");
      textWrap.className = "toc__hl-text";

      const title = document.createElement("span");
      title.className = "toc__row-title";
      title.textContent = ann.snippet || "Highlight";
      textWrap.appendChild(title);

      if (ann.note && ann.note.trim()) {
        const note = document.createElement("span");
        note.className = "toc__hl-note";
        note.textContent = ann.note.trim();
        textWrap.appendChild(note);
      }

      main.append(dot, textWrap);
      main.addEventListener("click", () =>
        opts.onJumpHighlight({ chapter: ann.chapter, block: ann.startBlock, sentence: 0 }),
      );

      const del = document.createElement("button");
      del.className = "btn btn--ghost btn--icon btn--sm toc__bookmark-del";
      del.type = "button";
      del.title = "Remove highlight";
      del.innerHTML = icon.x;
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        removeAnnotation(opts.itemId, ann.id);
      });

      row.append(main, del);
      list.appendChild(row);
    }
    if (overflow > 0) appendNote(`…and ${overflow} more — keep typing`);
  }

  // Live-refresh bookmarks + highlights when the item's lists change.
  const unsubBookmarks = subscribeSelect(
    libraryStore,
    (idx) => idx.items.find((it: LibraryItem) => it.id === opts.itemId)?.bookmarks,
    () => {
      if (tab === "bookmarks") renderList();
    },
  );
  const unsubAnnotations = subscribeSelect(
    libraryStore,
    (idx) => idx.items.find((it: LibraryItem) => it.id === opts.itemId)?.annotations,
    () => {
      if (tab === "highlights") renderList();
    },
  );

  renderTabs();
  renderList();

  return {
    dispose(): void {
      unsubBookmarks();
      unsubAnnotations();
      unsubJobs();
      root.remove();
    },
    refresh(): void {
      renderList();
    },
  };
}
