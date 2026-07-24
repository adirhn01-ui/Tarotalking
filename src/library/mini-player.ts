// A compact now-playing bar for the library. It appears only while a book is
// bound to the playback engine (playing / loading / paused) AND the miniPlayer
// setting is on — leaving the reader keeps playback alive, and this bar is how
// you get back to it. Clicking the cover/title returns to the reader; the
// transport buttons drive the engine directly.

import { convertFileSrc } from "@tauri-apps/api/core";
import { escapeHtml } from "../core/format";
import { getItem } from "../core/library";
import { navigate } from "../core/nav";
import { settingsStore } from "../core/session";
import type { LibraryItem, PlaybackStatus, SourceType } from "../core/types";
import { icon } from "../ui/icons";
import { engine, engineState } from "../player/engine";

export interface MiniPlayer {
  dispose(): void;
}

const GRAD_COUNT = 8;

// The same FNV-1a hash the library cards use, so the mini-player thumb picks
// the SAME gradient as the item's card — visual continuity between the two.
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function sourceIcon(type: SourceType): string {
  if (type === "url") return icon.globe;
  if (type === "text") return icon.fileText;
  if (type === "paste") return icon.clipboard;
  return icon.book;
}

function coverThumb(item: LibraryItem): string {
  if (item.cover) {
    return `<img class="mini-player__cover-img" src="${escapeHtml(convertFileSrc(item.cover))}" alt="" />`;
  }
  const gi = hashStr(item.title) % GRAD_COUNT;
  return `<span class="mini-player__cover-grad cover-grad-${gi}">${sourceIcon(item.sourceType)}</span>`;
}

function statusWord(status: PlaybackStatus): string {
  if (status === "loading") return "Loading";
  if (status === "paused") return "Paused";
  return "Playing";
}

export function mountMiniPlayer(container: HTMLElement): MiniPlayer {
  const root = document.createElement("div");
  root.className = "mini-player no-select";
  root.innerHTML = `
    <div class="mini-player__progress"><span class="mini-player__progress-fill"></span></div>
    <button class="mini-player__info" type="button" title="Back to reader">
      <span class="mini-player__cover"></span>
      <span class="mini-player__meta">
        <span class="mini-player__title"></span>
        <span class="mini-player__sub"></span>
      </span>
    </button>
    <div class="mini-player__controls">
      <button class="btn btn--ghost btn--icon btn--sm" data-act="prev" type="button" title="Previous sentence">${icon.prev}</button>
      <button class="btn btn--primary btn--icon mini-player__play" type="button" title="Play / pause">${icon.play}</button>
      <button class="btn btn--ghost btn--icon btn--sm" data-act="next" type="button" title="Next sentence">${icon.next}</button>
      <button class="btn btn--ghost btn--icon btn--sm mini-player__close" data-act="close" type="button" title="Stop">${icon.x}</button>
    </div>`;

  const cover = root.querySelector<HTMLElement>(".mini-player__cover")!;
  const titleEl = root.querySelector<HTMLElement>(".mini-player__title")!;
  const subEl = root.querySelector<HTMLElement>(".mini-player__sub")!;
  const playBtn = root.querySelector<HTMLButtonElement>(".mini-player__play")!;
  const progressFill = root.querySelector<HTMLElement>(".mini-player__progress-fill")!;

  root.querySelector(".mini-player__info")!.addEventListener("click", () => {
    const id = engineState.get().itemId;
    if (id) navigate({ view: "reader", itemId: id });
  });
  root.querySelector('[data-act="prev"]')!.addEventListener("click", (e) => {
    e.stopPropagation();
    engine.prevSentence();
  });
  playBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    engine.toggle();
  });
  root.querySelector('[data-act="next"]')!.addEventListener("click", (e) => {
    e.stopPropagation();
    engine.nextSentence();
  });
  root.querySelector('[data-act="close"]')!.addEventListener("click", (e) => {
    e.stopPropagation();
    engine.stop();
  });

  let mounted = false;
  let renderedId: string | null = null;
  let lastGlyph = "";
  let lastSub = "";

  function show(): void {
    if (mounted) return;
    container.appendChild(root);
    container.classList.add("has-mini-player");
    mounted = true;
    renderedId = null; // force a content refresh on (re)appear
  }
  function hide(): void {
    if (!mounted) return;
    root.remove();
    container.classList.remove("has-mini-player");
    mounted = false;
  }

  function sync(): void {
    const s = engineState.get();
    const item = s.itemId ? getItem(s.itemId) : undefined;
    const active = s.status === "playing" || s.status === "loading" || s.status === "paused";
    if (!settingsStore.get().miniPlayer || !item || !active) {
      hide();
      return;
    }
    show();

    if (item.id !== renderedId) {
      renderedId = item.id;
      cover.innerHTML = coverThumb(item);
      titleEl.textContent = item.title;
      lastSub = ""; // force the sub line to refresh for the new item
    }

    const sub = (item.chapterLabel && item.chapterLabel.trim()) || statusWord(s.status);
    if (sub !== lastSub) {
      lastSub = sub;
      subEl.textContent = sub;
    }

    // Idempotent glyph swap (mirrors the player bar): rewrite only on a flip.
    const glyph = s.status === "playing" || s.status === "loading" ? "pause" : "play";
    const spin = s.status === "loading";
    const wanted = `${glyph}${spin ? "+spin" : ""}`;
    if (wanted !== lastGlyph) {
      lastGlyph = wanted;
      playBtn.innerHTML = spin ? `<span class="spin">${icon.refresh}</span>` : icon[glyph];
    }
    playBtn.title = glyph === "pause" ? "Pause" : "Play";

    progressFill.style.width = `${Math.round(Math.max(0, Math.min(1, s.pct)) * 100)}%`;
  }

  const unsubEngine = engineState.subscribe(() => sync());
  const unsubSettings = settingsStore.subscribe(() => sync());
  sync();

  return {
    dispose(): void {
      unsubEngine();
      unsubSettings();
      hide();
    },
  };
}
