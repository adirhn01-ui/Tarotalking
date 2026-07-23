// The library index store: loaded once at boot, mutated through helpers,
// saved atomically (debounced) through Rust. Reading/listening progress from
// the reader and the playback engine flows through here, which is what keeps
// the library cards in sync automatically.

import { ipc } from "./ipc";
import { Store } from "./store";
import type { Bookmark, Collection, LibraryIndex, LibraryItem, Position } from "./types";
import { EMPTY_LIBRARY } from "./types";

export const libraryStore = new Store<LibraryIndex>(EMPTY_LIBRARY);

let loaded = false;
let saveTimer: number | undefined;

function sanitizeIndex(raw: unknown): LibraryIndex {
  if (!raw || typeof raw !== "object") return EMPTY_LIBRARY;
  const o = raw as Record<string, unknown>;
  const items = Array.isArray(o.items) ? (o.items as LibraryItem[]) : [];
  const collections = Array.isArray(o.collections) ? (o.collections as Collection[]) : [];
  // Drop obviously broken rows rather than crashing the whole library.
  const okItems = items.filter(
    (it) => it && typeof it.id === "string" && typeof it.title === "string",
  );
  return { version: 1, items: okItems, collections: collections.filter((c) => c && typeof c.id === "string") };
}

export async function initLibrary(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await ipc.loadLibrary();
    if (raw) libraryStore.set(sanitizeIndex(raw));
  } catch {
    // empty library is a valid state; import errors surface in the UI
  }
}

function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void ipc.saveLibrary(libraryStore.get()).catch(() => {});
  }, 400);
}

/** Flush a pending save immediately (call before app hide/close). */
export async function flushLibrary(): Promise<void> {
  window.clearTimeout(saveTimer);
  try {
    await ipc.saveLibrary(libraryStore.get());
  } catch {
    /* surfaced elsewhere */
  }
}

export function mutateLibrary(fn: (index: LibraryIndex) => LibraryIndex): void {
  const before = libraryStore.get();
  const after = fn(before);
  if (after === before) return;
  libraryStore.set(after);
  scheduleSave();
}

export function getItem(id: string): LibraryItem | undefined {
  return libraryStore.get().items.find((it) => it.id === id);
}

export function addItem(item: LibraryItem): void {
  mutateLibrary((idx) => ({ ...idx, items: [item, ...idx.items] }));
}

export function updateItem(id: string, patch: Partial<LibraryItem>): void {
  mutateLibrary((idx) => {
    const i = idx.items.findIndex((it) => it.id === id);
    if (i < 0) return idx;
    const items = idx.items.slice();
    items[i] = { ...items[i]!, ...patch };
    return { ...idx, items };
  });
}

export function removeItem(id: string): void {
  mutateLibrary((idx) => ({
    ...idx,
    items: idx.items.filter((it) => it.id !== id),
  }));
}

export function touchOpened(id: string): void {
  updateItem(id, { lastOpenedAt: Date.now() });
}

export function setReadingPosition(
  id: string,
  pos: Position,
  progressPct: number,
  chapterLabel?: string,
): void {
  updateItem(id, {
    reading: pos,
    progressPct,
    ...(chapterLabel !== undefined ? { chapterLabel } : {}),
  });
}

export function setPlaybackPosition(id: string, pos: Position, chapterLabel?: string): void {
  updateItem(id, {
    playback: pos,
    ...(chapterLabel !== undefined ? { chapterLabel } : {}),
  });
}

export function addBookmark(id: string, bm: Bookmark): void {
  const it = getItem(id);
  if (!it) return;
  updateItem(id, { bookmarks: [...it.bookmarks, bm] });
}

export function removeBookmark(id: string, bookmarkId: string): void {
  const it = getItem(id);
  if (!it) return;
  updateItem(id, { bookmarks: it.bookmarks.filter((b) => b.id !== bookmarkId) });
}

/* ---- collections ---- */

export function addCollection(name: string): Collection {
  const col: Collection = { id: crypto.randomUUID(), name, createdAt: Date.now() };
  mutateLibrary((idx) => ({ ...idx, collections: [...idx.collections, col] }));
  return col;
}

export function renameCollection(id: string, name: string): void {
  mutateLibrary((idx) => ({
    ...idx,
    collections: idx.collections.map((c) => (c.id === id ? { ...c, name } : c)),
  }));
}

export function removeCollection(id: string): void {
  mutateLibrary((idx) => ({
    ...idx,
    collections: idx.collections.filter((c) => c.id !== id),
    items: idx.items.map((it) =>
      it.collections.includes(id)
        ? { ...it, collections: it.collections.filter((c) => c !== id) }
        : it,
    ),
  }));
}

export function toggleItemCollection(itemId: string, collectionId: string): void {
  const it = getItem(itemId);
  if (!it) return;
  const has = it.collections.includes(collectionId);
  updateItem(itemId, {
    collections: has
      ? it.collections.filter((c) => c !== collectionId)
      : [...it.collections, collectionId],
  });
}
