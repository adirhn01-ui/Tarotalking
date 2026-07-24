// The "Export audiobook" dialog: pick which chapters to write (the whole book,
// a range, or an arbitrary set), a voice (grouped by the providers that are
// actually available) and a destination folder, see the estimated output size,
// then hand the choice back to the library view. This module only collects the
// user's choices — building chapter payloads happens in library.ts, and the run
// itself goes through the audio-job queue, so an export is never refused because
// another book is busy.

import { describeError } from "../core/ipc";
import { escapeHtml, formatBytes, formatTimeLeft, listeningMinutes } from "../core/format";
import { settingsStore } from "../core/session";
import { audioBytesPerSecond, PROVIDER_LABELS, SPEAKING_WPM } from "../core/types";
import type { LibraryItem, ProviderId, VoiceInfo, VoiceRef } from "../core/types";
import { allProviders } from "../player/providers/provider";
import { trapTab } from "../ui/focus";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";

/** BYO-key cloud providers — exporting a whole book with one spends the user's
 *  own API credits, so the dialog warns before they commit. Kept local (a tiny
 *  set) to avoid pulling the settings module's graph into the library view. */
const CREDIT_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "eleven",
  "openai",
  "speechify",
  "deepgram",
  "cartesia",
]);

interface VoiceGroup {
  provider: ProviderId;
  label: string;
  voices: VoiceInfo[];
}

/* ================= chapter selection (pure, unit-tested) ================= */

export type ChapterMode = "all" | "range" | "choose";

/** One row of the chapter list: the chapter's real place in the book, its
 *  title, and how much speakable text it holds (the size estimate's weight). */
export interface ExportChapterSummary {
  /** 1-based position in the book — matches the reader's chapter numbering. */
  number: number;
  title: string;
  /** Characters of speakable text in the chapter. */
  chars: number;
}

/** What the Chapters row currently says. `from`/`to` only matter in "range"
 *  mode, `chosen` only in "choose" mode — keeping all three alive means
 *  switching modes never loses what was already picked. */
export interface ChapterSelection {
  mode: ChapterMode;
  /** Inclusive 1-based range bounds, as typed (resolved on read). */
  from: number;
  to: number;
  /** Ticked chapter numbers. */
  chosen: ReadonlySet<number>;
}

/** Clamp a 1-based chapter number into 1..total; anything unusable falls back. */
function clampChapter(n: number, total: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), 1), Math.max(total, 1));
}

/** Resolve the two range inputs: both clamped into 1..total, and reversed
 *  bounds swapped rather than treated as an error. */
export function resolveRange(
  from: number,
  to: number,
  total: number,
): { from: number; to: number } {
  const a = clampChapter(from, total, 1);
  const b = clampChapter(to, total, total);
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

/** The chapter numbers a selection resolves to: ascending, deduped, and always
 *  a subset of `available` (the book's chapters that actually hold text, in
 *  reading order). `total` is the book's full chapter count — what the range
 *  bounds clamp to, so the numbers the user types match the reader's. */
export function resolveSelection(
  sel: ChapterSelection,
  available: readonly number[],
  total: number,
): number[] {
  if (sel.mode === "range") {
    const { from, to } = resolveRange(sel.from, sel.to, total);
    return available.filter((n) => n >= from && n <= to);
  }
  if (sel.mode === "choose") return available.filter((n) => sel.chosen.has(n));
  return [...available];
}

/** True when a chapter row stays visible under the list filter — a match on the
 *  chapter number or anywhere in its (already lowercased) title. Display only:
 *  filtering never touches what is selected. */
export function chapterMatchesFilter(
  number: number,
  lowerTitle: string,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return String(number).includes(q) || lowerTitle.includes(q);
}

/** Words attributable to a chapter selection. Per-chapter word counts aren't
 *  stored, so the book's word count is split by the selected chapters' share of
 *  its text length — exact for a whole book, and a faithful proportion for any
 *  slice of one. */
export function selectionWordCount(
  totalWords: number,
  selectedChars: number,
  totalChars: number,
): number {
  if (!(totalWords > 0) || !(totalChars > 0) || !(selectedChars > 0)) return 0;
  return Math.round(totalWords * Math.min(1, selectedChars / totalChars));
}

/* ================= the dialog ================= */

export interface ExportChoice {
  voice: VoiceRef;
  destDir: string;
  /** Chapter numbers to export: 1-based book positions, ascending. */
  chapters: number[];
}

/** Middle-truncate a long path so both ends stay readable ("C:\a…\book"). */
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/** Read one range input, falling back to its end of the book when cleared. */
function readBound(el: HTMLInputElement, fallback: number): number {
  const raw = el.value.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function openExportDialog(opts: {
  item: LibraryItem;
  /** The book's exportable chapters, in reading order. */
  chapters: ExportChapterSummary[];
  /** The book's full chapter count, empty chapters included. */
  totalChapters: number;
  onExport: (choice: ExportChoice) => void;
}): void {
  const { item, chapters, onExport } = opts;
  const quality = settingsStore.get().audioQuality;
  const total = Math.max(opts.totalChapters, chapters.length, 1);

  let destDir: string | null = null;
  let voiceGroups: VoiceGroup[] = [];
  let closed = false;

  // Selection state. Ranges are clamped on read, so the typed values can be
  // anything mid-edit without the summary ever showing an impossible count.
  let mode: ChapterMode = "all";
  let from = 1;
  let to = total;
  const chosen = new Set<number>();

  const available = chapters.map((c) => c.number);
  const charsByNumber = new Map<number, number>(chapters.map((c) => [c.number, c.chars]));
  const totalChars = chapters.reduce((n, c) => n + c.chars, 0);
  let selected: number[] = [...available];

  const chapterPart = `${item.chapterCount} ${item.chapterCount === 1 ? "chapter" : "chapters"}`;
  const mins = listeningMinutes(item.wordCount, 1);
  const timePart = item.wordCount > 0 && mins >= 1 ? ` · about ${formatTimeLeft(mins)}` : "";
  const bookLine = `${item.title} · ${chapterPart}${timePart}`;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal lib-modal" role="dialog" aria-modal="true" aria-label="Export audiobook">
      <div class="modal__header">Export audiobook<button class="btn btn--ghost btn--icon lib-modal__x" data-close type="button">${icon.x}</button></div>
      <div class="modal__body">
        <div class="lib-modal__text">${escapeHtml(bookLine)}</div>
        <div class="field">
          <label for="exp-voice">Voice</label>
          <select class="select" id="exp-voice" disabled><option>Loading voices…</option></select>
        </div>
        <div class="field">
          <label for="exp-scope">Chapters</label>
          <select class="select" id="exp-scope">
            <option value="all">All chapters</option>
            <option value="range">Range</option>
            <option value="choose">Choose chapters</option>
          </select>
        </div>
        <div class="exp-range" data-range hidden>
          <div class="field exp-range__field">
            <label for="exp-from">From</label>
            <input class="input exp-range__num" id="exp-from" type="number" inputmode="numeric" min="1" max="${total}" value="1">
          </div>
          <div class="field exp-range__field">
            <label for="exp-to">To</label>
            <input class="input exp-range__num" id="exp-to" type="number" inputmode="numeric" min="1" max="${total}" value="${total}">
          </div>
        </div>
        <div class="exp-pick" data-pick hidden>
          <div class="exp-pick__bar">
            <input class="input exp-pick__filter" type="search" placeholder="Filter by title or number" aria-label="Filter chapters" data-filter>
            <button class="btn btn--sm" data-all type="button">Select all</button>
            <button class="btn btn--sm" data-none type="button">Select none</button>
          </div>
          <div class="exp-pick__list" data-list></div>
          <div class="lib-modal__hint" data-nomatch hidden>No chapters match that filter</div>
        </div>
        <div class="lib-modal__hint" data-info></div>
        <div class="lib-modal__text" data-credit hidden></div>
        <div class="lib-modal__hint">Files play at normal speed — set listening speed in your player app.</div>
        <div class="field">
          <label>Save to</label>
          <div style="display:flex; align-items:center; gap: var(--sp-3); flex-wrap: wrap;">
            <button class="btn btn--sm" data-choose type="button">${icon.folder}Choose folder</button>
            <span class="lib-modal__hint" style="min-width:0;" data-path>No folder chosen</span>
          </div>
        </div>
      </div>
      <div class="modal__footer">
        <button class="btn" data-close type="button">Cancel</button>
        <button class="btn btn--primary" data-export type="button" disabled>Export</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const release = trapTab(backdrop);

  const sel = backdrop.querySelector<HTMLSelectElement>("#exp-voice")!;
  const scopeEl = backdrop.querySelector<HTMLSelectElement>("#exp-scope")!;
  const rangeEl = backdrop.querySelector<HTMLElement>("[data-range]")!;
  const fromEl = backdrop.querySelector<HTMLInputElement>("#exp-from")!;
  const toEl = backdrop.querySelector<HTMLInputElement>("#exp-to")!;
  const pickEl = backdrop.querySelector<HTMLElement>("[data-pick]")!;
  const listEl = backdrop.querySelector<HTMLElement>("[data-list]")!;
  const filterEl = backdrop.querySelector<HTMLInputElement>("[data-filter]")!;
  const noMatchEl = backdrop.querySelector<HTMLElement>("[data-nomatch]")!;
  const infoEl = backdrop.querySelector<HTMLElement>("[data-info]")!;
  const creditEl = backdrop.querySelector<HTMLElement>("[data-credit]")!;
  const pathEl = backdrop.querySelector<HTMLElement>("[data-path]")!;
  const chooseBtn = backdrop.querySelector<HTMLButtonElement>("[data-choose]")!;
  const exportBtn = backdrop.querySelector<HTMLButtonElement>("[data-export]")!;

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
  backdrop.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));

  function selectedProvider(): ProviderId | null {
    const i = sel.value.indexOf("|");
    return i > 0 ? (sel.value.slice(0, i) as ProviderId) : null;
  }

  function updateInfo(): void {
    const qLabel = quality === "high" ? "High quality" : "Standard quality";
    const count = selected.length;
    if (count === 0) {
      infoEl.textContent =
        mode === "choose"
          ? "No chapters ticked — tick at least one to export"
          : "No chapters with text in that range";
      creditEl.hidden = true;
      return;
    }
    const countPart = `${count} ${count === 1 ? "chapter" : "chapters"}`;
    const provider = selectedProvider();
    if (!provider) {
      infoEl.textContent = `${countPart} · ${qLabel} — change in Settings`;
      creditEl.hidden = true;
      return;
    }
    let selectedChars = 0;
    for (const n of selected) selectedChars += charsByNumber.get(n) ?? 0;
    const words = selectionWordCount(item.wordCount, selectedChars, totalChars);
    const bytes = Math.round((words / SPEAKING_WPM) * 60 * audioBytesPerSecond(provider, quality));
    infoEl.textContent = `${countPart} · ${qLabel} — change in Settings · about ${formatBytes(bytes)}`;
    if (CREDIT_PROVIDERS.has(provider)) {
      creditEl.textContent = `Exporting a whole book spends your ${PROVIDER_LABELS[provider]} API credits.`;
      creditEl.hidden = false;
    } else {
      creditEl.hidden = true;
    }
  }

  // Another book's job never blocks this one — exports are queued, not refused.
  function updateExportEnabled(): void {
    const noVoice = voiceGroups.length === 0;
    exportBtn.disabled = !destDir || noVoice || selected.length === 0;
    exportBtn.title =
      selected.length === 0
        ? "Select at least one chapter to export"
        : !destDir
          ? "Choose a folder to save the files in"
          : "";
  }

  /** Re-resolve the selection, then refresh the summary and the Export button.
   *  Nothing else re-renders — the chapter rows are built once and stay put. */
  function refresh(): void {
    selected = resolveSelection({ mode, from, to, chosen }, available, total);
    updateInfo();
    updateExportEnabled();
  }

  /* ----- the chapter list (built once, on first use) ----- */

  interface Row {
    el: HTMLElement;
    box: HTMLInputElement;
    number: number;
    lower: string;
  }
  let rows: Row[] = [];

  /** A book can hold thousands of chapters, so the rows are created exactly
   *  once — the first time "Choose chapters" is picked — and then only ever
   *  shown or hidden. Nothing here re-renders on a keystroke or a tick. */
  function buildRows(): void {
    if (rows.length > 0) return;
    listEl.innerHTML = chapters
      .map(
        (c) =>
          `<label class="exp-row"><input class="exp-row__box" type="checkbox" data-n="${c.number}"><span class="exp-row__num">${c.number}</span><span class="exp-row__title">${escapeHtml(c.title)}</span></label>`,
      )
      .join("");
    const els = Array.from(listEl.children) as HTMLElement[];
    rows = chapters.map((c, i) => {
      const el = els[i]!;
      return {
        el,
        box: el.firstElementChild as HTMLInputElement,
        number: c.number,
        lower: c.title.toLowerCase(),
      };
    });
    applyFilter();
  }

  /** Show/hide rows for the current filter text. Touches only the rows whose
   *  visibility actually changes; the selection is never involved. */
  function applyFilter(): void {
    const q = filterEl.value;
    let shown = 0;
    for (const r of rows) {
      const show = chapterMatchesFilter(r.number, r.lower, q);
      if (show) shown += 1;
      if (r.el.hidden !== !show) r.el.hidden = !show;
    }
    noMatchEl.hidden = rows.length === 0 || shown > 0;
  }

  function setAllChecked(on: boolean): void {
    buildRows();
    chosen.clear();
    if (on) for (const c of chapters) chosen.add(c.number);
    for (const r of rows) r.box.checked = on;
    refresh();
  }

  scopeEl.addEventListener("change", () => {
    mode = scopeEl.value as ChapterMode;
    rangeEl.hidden = mode !== "range";
    pickEl.hidden = mode !== "choose";
    if (mode === "choose") buildRows();
    refresh();
  });

  const onRangeInput = (): void => {
    from = readBound(fromEl, 1);
    to = readBound(toEl, total);
    refresh();
  };
  // Committing (blur / Enter) writes the resolved bounds back, so the fields
  // always end up showing exactly what will be exported.
  const onRangeCommit = (): void => {
    const r = resolveRange(readBound(fromEl, 1), readBound(toEl, total), total);
    from = r.from;
    to = r.to;
    fromEl.value = String(r.from);
    toEl.value = String(r.to);
    refresh();
  };
  fromEl.addEventListener("input", onRangeInput);
  toEl.addEventListener("input", onRangeInput);
  fromEl.addEventListener("change", onRangeCommit);
  toEl.addEventListener("change", onRangeCommit);

  filterEl.addEventListener("input", applyFilter);
  // A search field's clear button fires "search" rather than "input" in some
  // engines; both land on the same display-only pass.
  filterEl.addEventListener("search", applyFilter);
  backdrop.querySelector<HTMLButtonElement>("[data-all]")!.addEventListener("click", () =>
    setAllChecked(true),
  );
  backdrop.querySelector<HTMLButtonElement>("[data-none]")!.addEventListener("click", () =>
    setAllChecked(false),
  );

  // One delegated listener for every checkbox: ticking a row updates the set and
  // the summary line, never the list.
  listEl.addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement | null;
    if (!box || box.type !== "checkbox") return;
    const n = Number(box.dataset.n);
    if (!Number.isFinite(n)) return;
    if (box.checked) chosen.add(n);
    else chosen.delete(n);
    refresh();
  });

  refresh();

  chooseBtn.addEventListener("click", () => {
    void (async () => {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const picked = await open({ directory: true });
        if (closed || typeof picked !== "string") return;
        destDir = picked;
        pathEl.textContent = truncateMiddle(picked, 52);
        pathEl.title = picked;
        updateExportEnabled();
      } catch (e) {
        toast.error(describeError(e));
      }
    })();
  });

  sel.addEventListener("change", updateInfo);

  exportBtn.addEventListener("click", () => {
    if (exportBtn.disabled) return;
    const provider = selectedProvider();
    const i = sel.value.indexOf("|");
    if (!provider || i < 0 || !destDir || selected.length === 0) return;
    const id = sel.value.slice(i + 1);
    const picked = selected;
    close();
    onExport({ voice: { provider, id }, destDir, chapters: picked });
  });

  // Load the available providers' voices, grouped, then default to the item's
  // remembered voice (else the global default). Providers that aren't ready
  // (no key / not installed / offline) never appear.
  void (async () => {
    const groups = (
      await Promise.all(
        allProviders().map(async (p): Promise<VoiceGroup | null> => {
          try {
            const av = await p.availability();
            if (!av.ok) return null;
            const voices = await p.voices();
            return voices.length ? { provider: p.id, label: p.label, voices } : null;
          } catch {
            return null;
          }
        }),
      )
    ).filter((g): g is VoiceGroup => g !== null);
    if (closed) return;

    voiceGroups = groups;
    if (groups.length === 0) {
      sel.innerHTML = `<option>No voices available</option>`;
      updateExportEnabled();
      return;
    }

    const def = item.voice ?? settingsStore.get().playback.voice;
    let defaultValue: string | null = null;
    sel.innerHTML = groups
      .map((g) => {
        const options = g.voices
          .map((v) => {
            const value = `${g.provider}|${v.id}`;
            if (def && def.provider === g.provider && def.id === v.id) defaultValue = value;
            return `<option value="${escapeHtml(value)}">${escapeHtml(v.name)}</option>`;
          })
          .join("");
        return `<optgroup label="${escapeHtml(g.label)}">${options}</optgroup>`;
      })
      .join("");
    sel.disabled = false;
    if (defaultValue) sel.value = defaultValue; // else the first option stands
    updateInfo();
    updateExportEnabled();
    requestAnimationFrame(() => {
      if (!closed) sel.focus();
    });
  })();
}
