// Library home: top bar (brand, search, Add menu, settings), a "Continue
// reading" rail, a filter/sort row (source pills, favorites, collections), and
// a cover grid. Everything below the top bar re-renders from libraryStore so
// cards stay in sync with reading progress; the search input lives in the bar
// so its value and focus survive re-renders.

import "./library.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import { describeError, ipc } from "../core/ipc";
import {
  addCollection,
  getItem,
  libraryStore,
  removeItem,
  toggleItemCollection,
  touchOpened,
  updateItem,
} from "../core/library";
import { navigate } from "../core/nav";
import { escapeHtml, formatTimeLeft, readingMinutes } from "../core/format";
import type { LibraryIndex, LibraryItem, SourceType } from "../core/types";
import { POSITION_ZERO } from "../core/types";
import { trapTab } from "../ui/focus";
import { icon } from "../ui/icons";
import { closeMenu, showMenu, type MenuItem } from "../ui/menu";
import { toast } from "../ui/toast";

export interface LibraryView {
  dispose(): void | Promise<void>;
}

type SortKey = "recent" | "title" | "progress" | "added";

// Filter + sort are session state (module-level per spec — not persisted).
let activeFilter = "all";
let activeSort: SortKey = "recent";

const GRAD_COUNT = 8;

/* ================= pure card helpers ================= */

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function firstWords(s: string, n: number): string {
  return s.split(/\s+/).filter(Boolean).slice(0, n).join(" ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function sourceIcon(type: SourceType): string {
  if (type === "url") return icon.globe;
  if (type === "text") return icon.fileText;
  if (type === "paste") return icon.clipboard;
  return icon.book;
}

function badgeLabel(item: LibraryItem): string | null {
  if (item.sourceType === "url") return "Web";
  if (item.sourceType === "text" || item.sourceType === "paste") return "Text";
  return null;
}

function subLine(item: LibraryItem): string {
  if (item.sourceType === "url") return item.sourceUrl ? hostOf(item.sourceUrl) : "Web";
  return item.author ?? "";
}

function coverInner(item: LibraryItem): string {
  if (item.cover) {
    return `<img class="lib-card__img" src="${escapeHtml(convertFileSrc(item.cover))}" alt="" loading="lazy" />`;
  }
  const gi = hashStr(item.title) % GRAD_COUNT;
  return `<div class="lib-cover cover-grad-${gi}">
      <span class="lib-cover__icon">${sourceIcon(item.sourceType)}</span>
      <span class="lib-cover__title">${escapeHtml(firstWords(item.title, 2))}</span>
    </div>`;
}

function isFinished(item: LibraryItem): boolean {
  return !!item.finished || item.progressPct >= 1;
}

function cardHtml(item: LibraryItem): string {
  const badge = badgeLabel(item);
  const favOn = !!item.favorite;
  const pct = item.progressPct;

  let foot = "";
  if (isFinished(item)) foot = `<div class="lib-card__done">${icon.check}<span>Finished</span></div>`;
  else if (pct > 0) foot = `<div class="lib-card__bar"><span style="width:${Math.round(pct * 100)}%"></span></div>`;

  const sub = subLine(item);
  return `<div class="lib-card" data-id="${escapeHtml(item.id)}" tabindex="0" role="button" title="${escapeHtml(item.title)}">
      <div class="lib-card__cover">
        ${coverInner(item)}
        ${badge ? `<span class="lib-card__badge badge">${badge}</span>` : ""}
        <button class="lib-card__fav${favOn ? " is-on" : ""}" data-fav title="${favOn ? "Remove from favorites" : "Add to favorites"}">${favOn ? icon.starFilled : icon.star}</button>
        <button class="lib-card__more" data-more title="More">${icon.dots}</button>
      </div>
      <div class="lib-card__title">${escapeHtml(item.title)}</div>
      <div class="lib-card__sub">${sub ? escapeHtml(sub) : "&nbsp;"}</div>
      ${foot}
    </div>`;
}

function railCardHtml(item: LibraryItem): string {
  const pct = item.progressPct;
  const left = `${formatTimeLeft(readingMinutes(item.wordCount * (1 - pct)))} left`;
  const sub = subLine(item);
  return `<button class="lib-rail__card" data-id="${escapeHtml(item.id)}">
      <div class="lib-rail__cover">${coverInner(item)}</div>
      <div class="lib-rail__meta">
        <div class="lib-rail__title">${escapeHtml(item.title)}</div>
        ${sub ? `<div class="lib-rail__sub">${escapeHtml(sub)}</div>` : ""}
        <div class="lib-card__bar lib-rail__bar"><span style="width:${Math.round(pct * 100)}%"></span></div>
        <div class="lib-rail__left">${escapeHtml(left)}</div>
      </div>
    </button>`;
}

/* ================= filtering + sorting ================= */

function matchesFilter(item: LibraryItem): boolean {
  switch (activeFilter) {
    case "all":
      return true;
    case "books":
      return item.sourceType === "epub";
    case "articles":
      return item.sourceType === "url";
    case "text":
      return item.sourceType === "text" || item.sourceType === "paste";
    case "favorites":
      return !!item.favorite;
    default:
      return activeFilter.startsWith("col:") && item.collections.includes(activeFilter.slice(4));
  }
}

function sortItems(items: LibraryItem[]): LibraryItem[] {
  const arr = items.slice();
  switch (activeSort) {
    case "title":
      arr.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case "progress":
      arr.sort((a, b) => b.progressPct - a.progressPct);
      break;
    case "added":
      arr.sort((a, b) => b.addedAt - a.addedAt);
      break;
    case "recent":
    default:
      arr.sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt));
      break;
  }
  return arr;
}

/* ================= shared modal shell ================= */

interface ModalHandle {
  backdrop: HTMLElement;
  close: () => void;
}

function makeModal(innerHtml: string): ModalHandle {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = innerHtml;
  document.body.appendChild(backdrop);

  const release = trapTab(backdrop);
  let closed = false;
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    release();
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
  };
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) close();
  });
  return { backdrop, close };
}

function modalHeader(title: string): string {
  return `<div class="modal__header">${escapeHtml(title)}<button class="btn btn--ghost btn--icon lib-modal__x" data-close type="button">${icon.x}</button></div>`;
}

/** A single-input prompt (rename, new collection). */
function openPrompt(opts: {
  title: string;
  label: string;
  value?: string;
  placeholder?: string;
  confirmLabel: string;
  onConfirm: (value: string) => void;
}): void {
  const { backdrop, close } = makeModal(
    `<div class="modal lib-modal" role="dialog" aria-modal="true">
      ${modalHeader(opts.title)}
      <div class="modal__body">
        <div class="field">
          <label for="lib-prompt">${escapeHtml(opts.label)}</label>
          <input class="input" id="lib-prompt" spellcheck="false" ${opts.placeholder ? `placeholder="${escapeHtml(opts.placeholder)}"` : ""} />
        </div>
      </div>
      <div class="modal__footer">
        <button class="btn" data-close type="button">Cancel</button>
        <button class="btn btn--primary" data-confirm type="button">${escapeHtml(opts.confirmLabel)}</button>
      </div>
    </div>`,
  );
  const input = backdrop.querySelector<HTMLInputElement>("#lib-prompt")!;
  input.value = opts.value ?? "";
  const submit = (): void => {
    const v = input.value.trim();
    if (!v) {
      input.focus();
      return;
    }
    close();
    opts.onConfirm(v);
  };
  backdrop.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  backdrop.querySelector("[data-confirm]")!.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

/** A confirm dialog (delete). */
function openConfirm(opts: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}): void {
  const { backdrop, close } = makeModal(
    `<div class="modal lib-modal" role="dialog" aria-modal="true">
      ${modalHeader(opts.title)}
      <div class="modal__body"><div class="lib-modal__text">${escapeHtml(opts.message)}</div></div>
      <div class="modal__footer">
        <button class="btn" data-close type="button">Cancel</button>
        <button class="btn ${opts.danger ? "btn--danger" : "btn--primary"}" data-confirm type="button">${escapeHtml(opts.confirmLabel)}</button>
      </div>
    </div>`,
  );
  backdrop.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  const confirm = backdrop.querySelector<HTMLButtonElement>("[data-confirm]")!;
  confirm.addEventListener("click", () => {
    close();
    opts.onConfirm();
  });
  requestAnimationFrame(() => confirm.focus());
}

/* ================= import entry points ================= */

async function pickAndImportFiles(): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: true,
      filters: [{ name: "Readable files", extensions: ["epub", "txt", "md"] }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    const { importFiles } = await import("../core/import");
    await importFiles(paths);
  } catch (e) {
    toast.error(describeError(e));
  }
}

function openPasteModal(): void {
  const { backdrop, close } = makeModal(
    `<div class="modal lib-modal" role="dialog" aria-modal="true">
      ${modalHeader("Paste text")}
      <div class="modal__body">
        <div class="field">
          <label for="lib-paste-title">Title</label>
          <input class="input" id="lib-paste-title" placeholder="Optional" spellcheck="false" />
        </div>
        <div class="field">
          <label for="lib-paste-text">Text</label>
          <textarea class="input lib-paste__area" id="lib-paste-text" placeholder="Paste or type the text to read"></textarea>
        </div>
        <div class="lib-modal__count faint" data-count>0 characters</div>
      </div>
      <div class="modal__footer">
        <button class="btn" data-close type="button">Cancel</button>
        <button class="btn btn--primary" data-confirm type="button">Add to library</button>
      </div>
    </div>`,
  );
  const titleInput = backdrop.querySelector<HTMLInputElement>("#lib-paste-title")!;
  const textArea = backdrop.querySelector<HTMLTextAreaElement>("#lib-paste-text")!;
  const countEl = backdrop.querySelector<HTMLElement>("[data-count]")!;
  const updateCount = (): void => {
    const n = textArea.value.length;
    countEl.textContent = `${n} ${n === 1 ? "character" : "characters"}`;
  };
  textArea.addEventListener("input", updateCount);

  let busy = false;
  const submit = async (): Promise<void> => {
    if (busy) return;
    if (!textArea.value.trim()) {
      textArea.focus();
      return;
    }
    busy = true;
    const { importPastedText } = await import("../core/import");
    const id = await importPastedText(titleInput.value.trim() || null, textArea.value);
    if (id) {
      close();
      navigate({ view: "reader", itemId: id });
    } else {
      busy = false;
    }
  };
  backdrop.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  backdrop.querySelector("[data-confirm]")!.addEventListener("click", () => void submit());
  requestAnimationFrame(() => titleInput.focus());
}

function openWebModal(): void {
  const { backdrop, close } = makeModal(
    `<div class="modal lib-modal" role="dialog" aria-modal="true">
      ${modalHeader("Add from web")}
      <div class="modal__body">
        <div class="field">
          <label for="lib-url">Article URL</label>
          <input class="input" id="lib-url" placeholder="https://example.com/article" spellcheck="false" />
        </div>
        <div class="lib-modal__hint">Paste a link to an article or blog post. Tarotalking fetches it and pulls out the readable text.</div>
        <div class="lib-modal__error" data-error hidden></div>
      </div>
      <div class="modal__footer">
        <button class="btn" data-close type="button">Cancel</button>
        <button class="btn btn--primary" data-confirm type="button"><span data-label>Fetch article</span></button>
      </div>
    </div>`,
  );
  const input = backdrop.querySelector<HTMLInputElement>("#lib-url")!;
  const goBtn = backdrop.querySelector<HTMLButtonElement>("[data-confirm]")!;
  const label = goBtn.querySelector<HTMLElement>("[data-label]")!;
  const errEl = backdrop.querySelector<HTMLElement>("[data-error]")!;

  let busy = false;
  let cancelled = false;
  const doClose = (): void => {
    cancelled = true;
    close();
  };
  const submit = async (): Promise<void> => {
    if (busy) return;
    const url = input.value.trim();
    if (!url) {
      input.focus();
      return;
    }
    busy = true;
    goBtn.disabled = true;
    input.disabled = true;
    errEl.hidden = true;
    goBtn.classList.add("is-busy");
    label.textContent = "Fetching";

    const { importUrl } = await import("../core/import");
    const id = await importUrl(url);
    if (cancelled) return;

    if (id) {
      close();
      navigate({ view: "reader", itemId: id });
      return;
    }
    busy = false;
    goBtn.disabled = false;
    input.disabled = false;
    goBtn.classList.remove("is-busy");
    label.textContent = "Fetch article";
    errEl.textContent = "Couldn't fetch that article. Check the URL and try again.";
    errEl.hidden = false;
    input.focus();
  };
  backdrop.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", doClose));
  goBtn.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  });
  requestAnimationFrame(() => input.focus());
}

/* ================= per-item actions ================= */

function openItem(id: string): void {
  touchOpened(id);
  navigate({ view: "reader", itemId: id });
}

function markFinished(id: string): void {
  updateItem(id, { progressPct: 1, finished: true });
}

function markUnread(id: string): void {
  updateItem(id, {
    progressPct: 0,
    finished: false,
    reading: { ...POSITION_ZERO },
    playback: { ...POSITION_ZERO },
  });
}

function promptRename(item: LibraryItem): void {
  openPrompt({
    title: "Rename",
    label: "Title",
    value: item.title,
    confirmLabel: "Save",
    onConfirm: (value) => updateItem(item.id, { title: value }),
  });
}

function promptDelete(item: LibraryItem): void {
  openConfirm({
    title: "Delete item",
    message: `Delete '${item.title}' from your library? Its imported content is removed. This can't be undone.`,
    confirmLabel: "Delete",
    danger: true,
    onConfirm: () => {
      void (async () => {
        try {
          await ipc.deleteItem(item.id);
        } catch {
          // The content dir may already be gone; the index removal is what the
          // UI cares about, so proceed regardless.
        }
        removeItem(item.id);
        toast.info(`Removed ${item.title}`);
      })();
    },
  });
}

function openItemMenu(item: LibraryItem, x: number, y: number): void {
  const idx = libraryStore.get();
  const items: MenuItem[] = [
    { label: "Resume reading", onSelect: () => openItem(item.id) },
    { label: "Play from current position", onSelect: () => openItem(item.id) },
    {
      label: item.favorite ? "Remove from favorites" : "Add to favorites",
      onSelect: () => updateItem(item.id, { favorite: !item.favorite }),
    },
  ];
  for (const col of idx.collections) {
    const inCol = item.collections.includes(col.id);
    items.push({
      label: `${inCol ? "✓ " : " "}${col.name}`,
      onSelect: () => toggleItemCollection(item.id, col.id),
    });
  }
  items.push({ label: "Rename", onSelect: () => promptRename(item) });
  if (isFinished(item)) items.push({ label: "Mark as unread", onSelect: () => markUnread(item.id) });
  else items.push({ label: "Mark as finished", onSelect: () => markFinished(item.id) });
  items.push({ label: "Delete", danger: true, onSelect: () => promptDelete(item) });
  showMenu(x, y, items);
}

function openNewCollection(): void {
  openPrompt({
    title: "New collection",
    label: "Name",
    placeholder: "e.g. To read",
    confirmLabel: "Create",
    onConfirm: (name) => {
      const col = addCollection(name);
      activeFilter = `col:${col.id}`;
    },
  });
}

/* ================= section rendering ================= */

function emptyStateHtml(): string {
  return `<div class="lib-empty">
      <div class="empty-state">
        ${icon.bookOpen}
        <div class="lib-empty__title">Your library is empty</div>
        <div class="lib-empty__sub">Import an EPUB or text file, paste text, or add an article from the web — or just drop files here.</div>
        <div class="lib-empty__actions">
          <button class="btn btn--primary" data-act="import" type="button">${icon.plus}Import files</button>
          <button class="btn" data-act="paste" type="button">${icon.clipboard}Paste text</button>
          <button class="btn" data-act="web" type="button">${icon.globe}Add from web</button>
        </div>
      </div>
    </div>`;
}

function filtersHtml(idx: LibraryIndex): string {
  const items = idx.items;
  const pill = (key: string, label: string): string =>
    `<button class="btn btn--sm lib-pill${activeFilter === key ? " btn--on" : ""}" data-filter="${key}" type="button">${label}</button>`;

  const cols = idx.collections
    .map((c) => {
      const key = `col:${c.id}`;
      const n = items.filter((it) => it.collections.includes(c.id)).length;
      return `<button class="btn btn--sm lib-pill${activeFilter === key ? " btn--on" : ""}" data-filter="${key}" type="button">${escapeHtml(c.name)}<span class="lib-pill__count">${n}</span></button>`;
    })
    .join("");

  return `<div class="lib-filters">
      <div class="lib-filters__pills">
        ${pill("all", "All")}
        ${pill("books", "Books")}
        ${pill("articles", "Articles")}
        ${pill("text", "Text")}
        ${pill("favorites", `<span class="lib-pill__ico">${icon.star}</span>Favorites`)}
        ${cols}
        <button class="btn btn--sm btn--ghost lib-pill lib-pill--new" data-newcol type="button">${icon.plus}New collection</button>
      </div>
      <select class="select select--sm lib-sort" data-sort aria-label="Sort library">
        <option value="recent">Recent</option>
        <option value="title">Title</option>
        <option value="progress">Progress</option>
        <option value="added">Added</option>
      </select>
    </div>`;
}

/* ================= mount ================= */

export function mountLibrary(el: HTMLElement): LibraryView {
  const root = document.createElement("div");
  root.className = "lib no-select";
  root.innerHTML = `
    <header class="lib__bar">
      <div class="lib__brand"><span class="lib__brand-ico">${icon.bookOpen}</span>Tarotalking</div>
      <div class="lib__search-wrap">
        <div class="lib__search-box">
          <span class="lib__search-ico">${icon.search}</span>
          <input class="input lib__search" id="lib-search" placeholder="Search library" spellcheck="false" />
        </div>
      </div>
      <div class="lib__actions">
        <button class="btn btn--primary lib__add" id="lib-add" type="button">${icon.plus}<span>Add</span>${icon.chevronDown}</button>
        <button class="btn btn--ghost btn--icon" id="lib-settings" title="Settings" type="button">${icon.settings}</button>
      </div>
    </header>
    <div class="lib__scroll">
      <div class="lib__content" id="lib-content"></div>
    </div>`;
  el.appendChild(root);

  const search = root.querySelector<HTMLInputElement>("#lib-search")!;
  const content = root.querySelector<HTMLElement>("#lib-content")!;
  const addBtn = root.querySelector<HTMLButtonElement>("#lib-add")!;

  function visibleItems(idx: LibraryIndex): LibraryItem[] {
    const q = search.value.trim().toLowerCase();
    let items = idx.items.filter(matchesFilter);
    if (q) {
      items = items.filter(
        (it) => it.title.toLowerCase().includes(q) || (it.author ?? "").toLowerCase().includes(q),
      );
    }
    return sortItems(items);
  }

  function render(): void {
    const idx = libraryStore.get();
    if (idx.items.length === 0) {
      content.innerHTML = emptyStateHtml();
      return;
    }
    const searching = search.value.trim().length > 0;
    const rail = searching
      ? []
      : idx.items
          .filter((it) => it.lastOpenedAt && it.progressPct > 0 && it.progressPct < 1)
          .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
          .slice(0, 8);
    const vis = visibleItems(idx);

    const railHtml = rail.length
      ? `<section class="lib-rail">
          <div class="lib-section-head">Continue reading</div>
          <div class="lib-rail__row">${rail.map(railCardHtml).join("")}</div>
        </section>`
      : "";
    const gridHtml = vis.length
      ? `<div class="lib-grid">${vis.map(cardHtml).join("")}</div>`
      : `<div class="lib-grid-empty">${searching ? "No items match your search." : "Nothing here yet."}</div>`;

    content.innerHTML = `${railHtml}${filtersHtml(idx)}${gridHtml}`;
    const sortSel = content.querySelector<HTMLSelectElement>("[data-sort]");
    if (sortSel) sortSel.value = activeSort;
  }

  /* ---- delegated events on the (re-rendered) content area ---- */

  content.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;

    const act = t.closest<HTMLElement>("[data-act]");
    if (act) {
      const a = act.dataset.act;
      if (a === "import") void pickAndImportFiles();
      else if (a === "paste") openPasteModal();
      else if (a === "web") openWebModal();
      return;
    }
    const pill = t.closest<HTMLElement>("[data-filter]");
    if (pill) {
      activeFilter = pill.dataset.filter!;
      render();
      return;
    }
    if (t.closest("[data-newcol]")) {
      openNewCollection();
      return;
    }
    const railCard = t.closest<HTMLElement>(".lib-rail__card");
    if (railCard) {
      openItem(railCard.dataset.id!);
      return;
    }
    const fav = t.closest<HTMLElement>("[data-fav]");
    if (fav) {
      e.stopPropagation();
      const id = fav.closest<HTMLElement>(".lib-card")?.dataset.id;
      const it = id ? getItem(id) : undefined;
      if (it) updateItem(it.id, { favorite: !it.favorite });
      return;
    }
    const more = t.closest<HTMLElement>("[data-more]");
    if (more) {
      const id = more.closest<HTMLElement>(".lib-card")?.dataset.id;
      const it = id ? getItem(id) : undefined;
      if (it) {
        const r = more.getBoundingClientRect();
        openItemMenu(it, r.left, r.bottom + 4);
      }
      return;
    }
    const card = t.closest<HTMLElement>(".lib-card");
    if (card) openItem(card.dataset.id!);
  });

  content.addEventListener("change", (e) => {
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>("[data-sort]");
    if (sel) {
      activeSort = sel.value as SortKey;
      render();
    }
  });

  content.addEventListener("contextmenu", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".lib-card");
    if (!card) return;
    e.preventDefault();
    const it = getItem(card.dataset.id!);
    if (it) openItemMenu(it, e.clientX, e.clientY);
  });

  content.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const card = (e.target as HTMLElement).closest<HTMLElement>(".lib-card");
    if (card) {
      e.preventDefault();
      openItem(card.dataset.id!);
    }
  });

  /* ---- top-bar wiring ---- */

  addBtn.addEventListener("click", () => {
    const r = addBtn.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, [
      { label: "Import files", onSelect: () => void pickAndImportFiles() },
      { label: "Paste text", onSelect: openPasteModal },
      { label: "Add from web", onSelect: openWebModal },
    ]);
  });
  root.querySelector("#lib-settings")!.addEventListener("click", () => navigate({ view: "settings" }));
  search.addEventListener("input", render);

  // "/" focuses search when not already typing and no modal is open.
  const onSlash = (e: KeyboardEvent): void => {
    if (e.key !== "/") return;
    const a = document.activeElement;
    if (
      a instanceof HTMLInputElement ||
      a instanceof HTMLTextAreaElement ||
      (a instanceof HTMLElement && a.isContentEditable)
    ) {
      return;
    }
    if (document.querySelector(".modal-backdrop")) return;
    e.preventDefault();
    search.focus();
    search.select();
  };
  document.addEventListener("keydown", onSlash);

  const unsubscribe = libraryStore.subscribe(() => render());
  render();

  return {
    dispose() {
      unsubscribe();
      document.removeEventListener("keydown", onSlash);
      closeMenu();
      root.remove();
    },
  };
}
