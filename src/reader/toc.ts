// Reader side panel: Contents + Bookmarks tabs. Owns no reading surface — it
// asks the reader to jump via callbacks and reads live library state for
// bookmarks. Mounted into the reader's TOC host.

import { formatRelative, formatTimeLeft, readingMinutes } from "../core/format";
import { getItem, libraryStore, removeBookmark } from "../core/library";
import { subscribeSelect } from "../core/store";
import type { Chapter, ContentDoc, LibraryItem, Position } from "../core/types";
import { icon } from "../ui/icons";
import { filterByLabel } from "./render";

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
}

export interface TocController {
  dispose(): void;
  /** Re-render the active list (current-chapter highlight, bookmark changes). */
  refresh(): void;
}

type Tab = "contents" | "bookmarks";

export function mountToc(host: HTMLElement, opts: TocOptions): TocController {
  let tab: Tab = "contents";
  let query = "";

  const root = document.createElement("div");
  root.className = "toc";
  root.innerHTML = `
    <div class="toc__tabs">
      <button class="btn btn--sm toc__tab" data-tab="contents">Contents</button>
      <button class="btn btn--sm toc__tab" data-tab="bookmarks">Bookmarks</button>
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
    search.placeholder = tab === "contents" ? "Search chapters" : "Search bookmarks";
  }

  function renderList(): void {
    list.textContent = "";
    if (tab === "contents") renderContents();
    else renderBookmarks();
  }

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
      const row = document.createElement("button");
      row.className = "toc__row toc__chapter";
      row.classList.toggle("toc__row--current", i === current);
      row.type = "button";

      const title = document.createElement("span");
      title.className = "toc__row-title";
      title.textContent = chapterLabel(ch, i);

      const mins = document.createElement("span");
      mins.className = "toc__row-meta faint";
      const words = opts.chapterWordCounts[i] ?? 0;
      mins.textContent = words > 0 ? formatTimeLeft(readingMinutes(words)) : "";

      row.append(title, mins);
      row.addEventListener("click", () => opts.onJumpChapter({ chapter: i, block: 0, sentence: 0 }));
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

  // Live-refresh the bookmarks list when the item's bookmarks change.
  const unsubBookmarks = subscribeSelect(
    libraryStore,
    (idx) => idx.items.find((it: LibraryItem) => it.id === opts.itemId)?.bookmarks,
    () => {
      if (tab === "bookmarks") renderList();
    },
  );

  renderTabs();
  renderList();

  return {
    dispose(): void {
      unsubBookmarks();
      root.remove();
    },
    refresh(): void {
      renderList();
    },
  };
}
