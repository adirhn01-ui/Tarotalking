// A compact now-playing bar for the library. It appears only while something is
// actually bound to a player (playing / loading / paused) AND the miniPlayer
// setting is on — leaving a book keeps playback alive, and this bar is how you
// get back to it.
//
// Two players can feed it: sentence-by-sentence TTS (engine.ts) and linear
// audiobook playback (audiobook.ts). Only one of them is ever audible — the
// arbiter in player/audio-lock.ts guarantees that — so the bar reduces both
// stores to ONE `NowPlaying` snapshot and renders from that. Everything the bar
// does afterwards (which screen the title links to, which player the transport
// buttons drive) follows from the snapshot's `kind`, so neither player is ever
// commanded while the other one holds the output.

import { convertFileSrc } from "@tauri-apps/api/core";
import { escapeHtml } from "../core/format";
import { getItem } from "../core/library";
import { playbackOwner, type PlaybackOwner } from "../player/audio-lock";
import { itemRoute, navigate } from "../core/nav";
import { settingsStore } from "../core/session";
import type { LibraryItem, PlaybackStatus, SourceType } from "../core/types";
import { icon } from "../ui/icons";
import { engine, engineState } from "../player/engine";
import { audiobook, audiobookState, toElapsed, totalDuration } from "../player/audiobook";

export interface MiniPlayer {
  dispose(): void;
}

/* ================= the snapshot ================= */

/** Which player produced the snapshot. */
export type NowPlayingKind = "tts" | "audiobook";

/** Everything the bar renders, reduced from whichever player is live. */
export interface NowPlaying {
  kind: NowPlayingKind;
  itemId: string;
  title: string;
  /** Second line: where you are, in the terms that fit this kind. */
  sub: string;
  /** True while sound is (or is about to be) coming out — the button shows a
   *  pause glyph for both, since "loading" ends in playing. */
  playing: boolean;
  /** 0..1 progress for the hairline bar. */
  pct: number;
}

/** The reading engine's state, narrowed to what the bar reads. */
export interface TtsPlayback {
  status: PlaybackStatus;
  itemId: string | null;
  pct: number;
}

/** The audiobook player's state, narrowed to what the bar reads. */
export interface AudiobookPlayback {
  status: PlaybackStatus;
  itemId: string | null;
  trackIndex: number;
  positionSec: number;
  durationSec: number;
}

/** A player holding a book is worth showing even while paused — pausing in the
 *  reader and walking back to the library must not make the bar vanish. */
function isBound(status: PlaybackStatus): boolean {
  return status === "playing" || status === "loading" || status === "paused";
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function statusWord(status: PlaybackStatus): string {
  if (status === "loading") return "Loading";
  if (status === "paused") return "Paused";
  return "Playing";
}

/** Where an audiobook is, in one short line: the track's own title when it says
 *  something the book title doesn't, else its place in the file list, else the
 *  bare status (a single untitled file has nothing else to offer). */
function audiobookSub(item: LibraryItem, trackIndex: number, status: PlaybackStatus): string {
  const tracks = item.audio?.tracks ?? [];
  const count = tracks.length;
  const i = Math.max(0, Math.min(Math.trunc(trackIndex) || 0, count - 1));
  const title = (tracks[i]?.title ?? "").trim();
  if (title && title !== item.title.trim()) return title;
  if (count > 1) return `Track ${i + 1} of ${count}`;
  return statusWord(status);
}

/** Progress through the WHOLE book, matching the library card — a track that
 *  never reported its length falls back to progress within that track. */
function audiobookPct(item: LibraryItem, s: AudiobookPlayback): number {
  const tracks = item.audio?.tracks ?? [];
  const total = totalDuration(tracks);
  if (total > 0) return clamp01(toElapsed(tracks, s.trackIndex, s.positionSec) / total);
  return s.durationSec > 0 ? clamp01(s.positionSec / s.durationSec) : 0;
}

/**
 * Reduce both players to the one thing that is playing, or null when the bar
 * should not be there at all. Pure: `lookup` is the only outside reach, and it
 * is only ever asked about the id the live player named.
 *
 * The arbiter allows exactly one active player, but the snapshot does not
 * depend on that holding: if both stores somehow report a bound book, the
 * audiobook wins (it is the one that keeps making noise on its own) rather than
 * the bar rendering two truths or throwing.
 */
export function nowPlaying(
  tts: TtsPlayback,
  book: AudiobookPlayback,
  lookup: (id: string) => LibraryItem | undefined,
  owner: PlaybackOwner | null = null,
): NowPlaying | null {
  const bookSnap =
    book.itemId && isBound(book.status)
      ? (() => {
          const item = lookup(book.itemId!);
          if (!item) return null;
          return {
            kind: "audiobook" as const,
            itemId: item.id,
            title: item.title,
            sub: audiobookSub(item, book.trackIndex, book.status),
            playing: book.status === "playing" || book.status === "loading",
            pct: audiobookPct(item, book),
          };
        })()
      : null;

  const ttsSnap =
    tts.itemId && isBound(tts.status)
      ? (() => {
          const item = lookup(tts.itemId!);
          if (!item) return null;
          return {
            kind: "tts" as const,
            itemId: item.id,
            title: item.title,
            sub: (item.chapterLabel && item.chapterLabel.trim()) || statusWord(tts.status),
            playing: tts.status === "playing" || tts.status === "loading",
            pct: clamp01(tts.pct),
          };
        })()
      : null;

  if (!bookSnap) return ttsSnap;
  if (!ttsSnap) return bookSnap;

  // Both are bound — one is almost always merely PAUSED, because starting
  // either player pauses the other. Showing the paused one is the bug this
  // ordering exists to prevent: the bar must follow the audio you can hear.
  if (bookSnap.playing !== ttsSnap.playing) return bookSnap.playing ? bookSnap : ttsSnap;

  // Neither is playing (both paused): follow whoever last held the output, so
  // the bar names the book you were last listening to rather than a fixed kind.
  if (owner === "tts") return ttsSnap;
  if (owner === "audiobook") return bookSnap;
  return bookSnap;
}

/* ================= the bar ================= */

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
  if (type === "text" || type === "pdf") return icon.fileText;
  if (type === "paste") return icon.clipboard;
  if (type === "audiobook") return icon.headphones;
  return icon.book;
}

function coverThumb(item: LibraryItem): string {
  if (item.cover) {
    return `<img class="mini-player__cover-img" src="${escapeHtml(convertFileSrc(item.cover))}" alt="" />`;
  }
  const gi = hashStr(item.title) % GRAD_COUNT;
  return `<span class="mini-player__cover-grad cover-grad-${gi}">${sourceIcon(item.sourceType)}</span>`;
}

export function mountMiniPlayer(container: HTMLElement): MiniPlayer {
  const root = document.createElement("div");
  root.className = "mini-player no-select";
  root.innerHTML = `
    <div class="mini-player__progress"><span class="mini-player__progress-fill"></span></div>
    <button class="mini-player__info" type="button" title="Back to the book">
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

  const infoBtn = root.querySelector<HTMLButtonElement>(".mini-player__info")!;
  const cover = root.querySelector<HTMLElement>(".mini-player__cover")!;
  const titleEl = root.querySelector<HTMLElement>(".mini-player__title")!;
  const subEl = root.querySelector<HTMLElement>(".mini-player__sub")!;
  const prevBtn = root.querySelector<HTMLButtonElement>('[data-act="prev"]')!;
  const playBtn = root.querySelector<HTMLButtonElement>(".mini-player__play")!;
  const nextBtn = root.querySelector<HTMLButtonElement>('[data-act="next"]')!;
  const progressFill = root.querySelector<HTMLElement>(".mini-player__progress-fill")!;

  /** The snapshot the bar is currently showing — also what every button
   *  dispatches on, so a control can never reach the silent player. */
  let current: NowPlaying | null = null;
  let currentItem: LibraryItem | null = null;

  infoBtn.addEventListener("click", () => {
    if (currentItem) navigate(itemRoute(currentItem));
  });
  prevBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!current) return;
    if (current.kind === "audiobook") audiobook.prevTrack();
    else engine.prevSentence();
  });
  playBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!current) return;
    if (current.kind === "audiobook") audiobook.toggle();
    else engine.toggle();
  });
  nextBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!current) return;
    if (current.kind === "audiobook") audiobook.nextTrack();
    else engine.nextSentence();
  });
  root.querySelector('[data-act="close"]')!.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!current) return;
    if (current.kind === "audiobook") audiobook.stop();
    else engine.stop();
  });

  let mounted = false;
  let renderedId: string | null = null;
  let renderedKind: NowPlayingKind | null = null;
  let lastGlyph = "";
  let lastSub = "";
  let lastWidth = "";

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
    const np = nowPlaying(engineState.get(), audiobookState.get(), getItem, playbackOwner());
    if (!np || !settingsStore.get().miniPlayer) {
      current = null;
      currentItem = null;
      hide();
      return;
    }
    current = np;
    show();

    if (np.itemId !== renderedId) {
      const item = getItem(np.itemId);
      if (!item) {
        current = null;
        currentItem = null;
        hide();
        return;
      }
      renderedId = item.id;
      currentItem = item;
      cover.innerHTML = coverThumb(item);
      titleEl.textContent = item.title;
      lastSub = ""; // force the sub line to refresh for the new item
    }

    // Track vs sentence stepping — the glyphs are the same, what they mean
    // is not, so the labels follow the live player.
    if (np.kind !== renderedKind) {
      renderedKind = np.kind;
      const isBook = np.kind === "audiobook";
      prevBtn.title = isBook ? "Previous track" : "Previous sentence";
      nextBtn.title = isBook ? "Next track" : "Next sentence";
      infoBtn.title = isBook ? "Back to the audiobook" : "Back to the reader";
    }

    if (np.sub !== lastSub) {
      lastSub = np.sub;
      subEl.textContent = np.sub;
    }

    // Idempotent glyph swap (mirrors the player bar): rewrite only on a flip.
    const glyph = np.playing ? "pause" : "play";
    const spin =
      (np.kind === "audiobook" ? audiobookState.get().status : engineState.get().status) ===
      "loading";
    const wanted = `${glyph}${spin ? "+spin" : ""}`;
    if (wanted !== lastGlyph) {
      lastGlyph = wanted;
      playBtn.innerHTML = spin ? `<span class="spin">${icon.refresh}</span>` : icon[glyph];
      playBtn.title = glyph === "pause" ? "Pause" : "Play";
    }

    // An audiobook ticks about four times a second; only a percentage point
    // that actually moved is worth a style write.
    const width = `${Math.round(np.pct * 100)}%`;
    if (width !== lastWidth) {
      lastWidth = width;
      progressFill.style.width = width;
    }
  }

  const unsubEngine = engineState.subscribe(() => sync());
  const unsubAudiobook = audiobookState.subscribe(() => sync());
  const unsubSettings = settingsStore.subscribe(() => sync());
  sync();

  return {
    dispose(): void {
      unsubEngine();
      unsubAudiobook();
      unsubSettings();
      hide();
    },
  };
}
