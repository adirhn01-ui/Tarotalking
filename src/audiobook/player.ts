// The audiobook screen — a calm, focused full-screen player for imported
// audio books. Cover, timeline, transport, track list; nothing else.
//
// This view renders player state and never owns playback logic: every control
// calls into `audiobook`, and the only things drawn here come out of its
// stores. Rendering budget: one subscription each to the player, the sleep
// timer and settings, no timers of its own. Position ticks patch three text
// nodes and a slider value in place — everything structural is built once.

import "./player.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import { escapeHtml, formatPct } from "../core/format";
import { getItem } from "../core/library";
import { navigate } from "../core/nav";
import { subscribeSelect } from "../core/store";
import type { AudioTrack } from "../core/types";
import { PLAYBACK_RATES } from "../core/types";
import { settingsStore } from "../core/session";
import {
  audiobook,
  audiobookState,
  formatClock,
  skipSeconds,
  sleepState,
  toElapsed,
  totalDuration,
} from "../player/audiobook";
import { icon } from "../ui/icons";
import { showMenu, type MenuItem } from "../ui/menu";

export interface AudiobookPlayerView {
  dispose(): void;
}

/* ================= markup ================= */

/** First words of a title, for the placeholder cover. */
function firstWords(s: string, n: number): string {
  return s.split(/\s+/).filter(Boolean).slice(0, n).join(" ");
}

function coverHtml(title: string, cover: string | undefined): string {
  if (cover) {
    return `<img class="abp__art-img" src="${escapeHtml(convertFileSrc(cover))}" alt="" />`;
  }
  return `<div class="abp__art-blank"><span>${escapeHtml(firstWords(title, 4))}</span></div>`;
}

function trackRowsHtml(tracks: readonly AudioTrack[]): string {
  return tracks
    .map(
      (t, i) => `<button type="button" class="abp-track" data-index="${i}" role="listitem">
        <span class="abp-track__num">${i + 1}</span>
        <span class="abp-track__title">${escapeHtml(t.title || `Track ${i + 1}`)}</span>
        <span class="abp-track__dur">${formatClock(t.durationSec)}</span>
      </button>`,
    )
    .join("");
}

function shellHtml(title: string, author: string, cover: string | undefined, tracks: readonly AudioTrack[]): string {
  return `
    <header class="abp__topbar">
      <button type="button" class="btn btn--icon btn--ghost" id="abp-back" title="Back to library" aria-label="Back to library">${icon.back}</button>
      <div class="abp__topbar-title">${escapeHtml(title)}</div>
    </header>
    <div class="abp__body">
      <div class="abp__inner">
        <div class="abp__art">${coverHtml(title, cover)}</div>

        <div class="abp__meta">
          <h1 class="abp__title">${escapeHtml(title)}</h1>
          <div class="abp__author">${escapeHtml(author)}</div>
        </div>

        <div class="abp__fault card" id="abp-fault" hidden>
          ${icon.warning}
          <div class="abp__fault-text" id="abp-fault-text"></div>
          <div class="abp__fault-actions">
            <button type="button" class="btn btn--sm" data-act="playNext">Skip to next track</button>
            <button type="button" class="btn btn--sm" data-act="library">Back to library</button>
          </div>
        </div>

        <div class="abp__timeline">
          <input type="range" class="slider abp__seek" id="abp-seek" min="0" max="1" step="1" value="0"
                 aria-label="Position in this track">
          <div class="abp__times">
            <span class="abp__time" id="abp-elapsed">0:00</span>
            <span class="abp__time" id="abp-remaining">0:00</span>
          </div>
        </div>

        <div class="abp__transport">
          <button type="button" class="btn btn--ghost btn--icon" data-act="prevTrack" title="Previous track" aria-label="Previous track">${icon.prev}</button>
          <button type="button" class="btn btn--ghost abp__skip" data-act="skipBack" title="Skip back">${icon.skipBack}<span class="abp__skip-amount"></span></button>
          <button type="button" class="btn btn--primary btn--icon btn--lg abp__play" id="abp-play" title="Play" aria-label="Play">${icon.play}</button>
          <button type="button" class="btn btn--ghost abp__skip" data-act="skipFwd" title="Skip forward"><span class="abp__skip-amount"></span>${icon.skipFwd}</button>
          <button type="button" class="btn btn--ghost btn--icon" data-act="nextTrack" title="Next track" aria-label="Next track">${icon.next}</button>
        </div>

        <div class="abp__status">
          <div class="abp__now" id="abp-now"></div>
          <div class="abp__count faint" id="abp-count"></div>
          <div class="abp__book faint" id="abp-book"></div>
        </div>

        <div class="abp__tools">
          <button type="button" class="btn btn--ghost btn--sm abp__rate" id="abp-rate" title="Playback speed">1×</button>
          <button type="button" class="btn btn--ghost btn--sm abp__sleep" id="abp-sleep" title="Sleep timer">${icon.sleep}<span id="abp-sleep-label">Sleep timer</span></button>
        </div>

        <section class="abp__tracks card" aria-labelledby="abp-tracks-head">
          <h2 class="abp__tracks-head" id="abp-tracks-head">${tracks.length === 1 ? "1 track" : `${tracks.length} tracks`}</h2>
          <div class="abp__tracks-list" id="abp-tracks-list" role="list">${trackRowsHtml(tracks)}</div>
        </section>
      </div>
    </div>`;
}

function emptyHtml(message: string): string {
  return `
    <header class="abp__topbar">
      <button type="button" class="btn btn--icon btn--ghost" id="abp-back" title="Back to library" aria-label="Back to library">${icon.back}</button>
      <div class="abp__topbar-title">Audiobook</div>
    </header>
    <div class="abp__body">
      <div class="empty-state abp__empty">
        ${icon.headphones}
        <div class="abp__empty-title">Nothing to play</div>
        <div class="abp__empty-sub">${escapeHtml(message)}</div>
        <button type="button" class="btn" data-act="library">Back to library</button>
      </div>
    </div>`;
}

/* ================= view ================= */

export function mountAudiobookPlayer(el: HTMLElement, itemId: string): AudiobookPlayerView {
  const root = document.createElement("div");
  root.className = "abp no-select";
  el.appendChild(root);

  const item = getItem(itemId);
  const tracks: AudioTrack[] = item?.audio?.tracks ?? [];

  if (!item || tracks.length === 0) {
    root.innerHTML = emptyHtml(
      item
        ? "This audiobook has no audio files. Import it again to pick up its tracks."
        : "That book is no longer in your library.",
    );
    const leave = (): void => navigate({ view: "library" });
    root.querySelector<HTMLButtonElement>("#abp-back")!.addEventListener("click", leave);
    root.querySelector<HTMLButtonElement>('[data-act="library"]')!.addEventListener("click", leave);
    return {
      dispose() {
        root.remove();
      },
    };
  }

  root.innerHTML = shellHtml(item.title, item.author ?? "", item.cover, tracks);
  audiobook.load(item);

  const bookTotal = totalDuration(tracks);
  const playBtn = root.querySelector<HTMLButtonElement>("#abp-play")!;
  const seek = root.querySelector<HTMLInputElement>("#abp-seek")!;
  const elapsedEl = root.querySelector<HTMLElement>("#abp-elapsed")!;
  const remainingEl = root.querySelector<HTMLElement>("#abp-remaining")!;
  const nowEl = root.querySelector<HTMLElement>("#abp-now")!;
  const countEl = root.querySelector<HTMLElement>("#abp-count")!;
  const bookEl = root.querySelector<HTMLElement>("#abp-book")!;
  const rateBtn = root.querySelector<HTMLButtonElement>("#abp-rate")!;
  const sleepBtn = root.querySelector<HTMLButtonElement>("#abp-sleep")!;
  const sleepLabel = root.querySelector<HTMLElement>("#abp-sleep-label")!;
  const faultEl = root.querySelector<HTMLElement>("#abp-fault")!;
  const faultText = root.querySelector<HTMLElement>("#abp-fault-text")!;
  const listEl = root.querySelector<HTMLElement>("#abp-tracks-list")!;
  const rows = [...listEl.querySelectorAll<HTMLElement>(".abp-track")];

  /* ---- transport ---- */

  const onClick = (e: MouseEvent): void => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-act]");
    if (!btn || !root.contains(btn)) return;
    switch (btn.dataset.act) {
      case "prevTrack":
        audiobook.prevTrack();
        break;
      case "nextTrack":
        audiobook.nextTrack();
        break;
      case "playNext":
        // Recovering from an unplayable file: move on AND keep listening.
        audiobook.nextTrack();
        void audiobook.play();
        break;
      case "skipBack":
        audiobook.skip(-skip);
        break;
      case "skipFwd":
        audiobook.skip(skip);
        break;
      case "library":
        navigate({ view: "library" });
        break;
      default:
        break;
    }
  };
  root.addEventListener("click", onClick);
  playBtn.addEventListener("click", () => audiobook.toggle());
  root
    .querySelector<HTMLButtonElement>("#abp-back")!
    .addEventListener("click", () => navigate({ view: "library" }));

  /* ---- track list ---- */

  const onListClick = (e: MouseEvent): void => {
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(".abp-track");
    if (!row) return;
    const index = Number(row.dataset.index);
    if (!Number.isInteger(index)) return;
    audiobook.goToTrack(index);
    void audiobook.play();
  };
  listEl.addEventListener("click", onListClick);

  /* ---- scrubbing ----
     A drag must not fight the timeupdate stream: while the user holds the
     thumb (or steps it with the keyboard) incoming positions are ignored and
     the labels follow the slider instead. The move is committed once, on
     release. */

  let dragging = false;

  function sliderSeconds(): number {
    return Number(seek.value);
  }

  function commitSeek(): void {
    if (!dragging) return;
    dragging = false;
    audiobook.seekTo(sliderSeconds());
  }

  seek.addEventListener("pointerdown", () => {
    dragging = true;
  });
  seek.addEventListener("input", () => {
    dragging = true;
    renderTimes(sliderSeconds(), audiobookState.get().durationSec);
  });
  seek.addEventListener("change", commitSeek);
  // Safety net: a pointer released outside the slider never fires `change`.
  window.addEventListener("pointerup", commitSeek);
  window.addEventListener("pointercancel", commitSeek);

  /* ---- speed and sleep menus ---- */

  rateBtn.addEventListener("click", () => {
    const r = rateBtn.getBoundingClientRect();
    const current = audiobookState.get().rate;
    showMenu(
      r.left,
      r.bottom + 6,
      PLAYBACK_RATES.map((rate) => ({
        label: `${rate}×${rate === current ? "  ✓" : ""}`,
        onSelect: () => audiobook.setRate(rate),
      })),
    );
  });

  sleepBtn.addEventListener("click", () => {
    const r = sleepBtn.getBoundingClientRect();
    const items: MenuItem[] = [
      { label: "In 15 minutes", onSelect: () => audiobook.startSleepTimer(15) },
      { label: "In 30 minutes", onSelect: () => audiobook.startSleepTimer(30) },
      { label: "In 60 minutes", onSelect: () => audiobook.startSleepTimer(60) },
    ];
    if (sleepState.get().until !== null) {
      items.push({
        label: "Turn off sleep timer",
        danger: true,
        onSelect: () => audiobook.cancelSleepTimer(),
      });
    }
    showMenu(r.left, r.bottom + 6, items);
  });

  /* ---- rendering ---- */

  let skip = skipSeconds();
  let lastGlyph = "";
  let lastTrack = -1;
  let lastMax = -1;
  let lastElapsed = "";
  let lastRemaining = "";
  let lastCount = "";
  let lastBook = "";
  // null, not "": no fault is also "", and starting equal to it would skip the
  // very first pass and leave the transport in whatever state the markup had.
  let lastFault: string | null = null;
  let lastRate = -1;

  function renderSkip(): void {
    const label = `${skip}s`;
    for (const s of root.querySelectorAll<HTMLElement>(".abp__skip-amount")) s.textContent = label;
    root.querySelector<HTMLElement>('[data-act="skipBack"]')!.title = `Skip back ${skip} seconds`;
    root.querySelector<HTMLElement>('[data-act="skipFwd"]')!.title = `Skip forward ${skip} seconds`;
  }

  function renderTimes(positionSec: number, durationSec: number): void {
    const elapsed = formatClock(positionSec);
    if (elapsed !== lastElapsed) {
      lastElapsed = elapsed;
      elapsedEl.textContent = elapsed;
    }
    const left = `-${formatClock(Math.max(0, durationSec - positionSec))}`;
    if (left !== lastRemaining) {
      lastRemaining = left;
      remainingEl.textContent = left;
    }
  }

  function renderTrack(index: number): void {
    if (index === lastTrack) return;
    const prev = rows[lastTrack];
    if (prev) {
      prev.classList.remove("abp-track--current");
      prev.removeAttribute("aria-current");
    }
    const next = rows[index];
    if (next) {
      next.classList.add("abp-track--current");
      next.setAttribute("aria-current", "true");
    }
    lastTrack = index;
    nowEl.textContent = tracks[index]?.title ?? "";
  }

  function render(): void {
    const s = audiobookState.get();

    const glyph = s.status === "playing" || s.status === "loading" ? "pause" : "play";
    const spin = s.status === "loading";
    const wanted = `${glyph}${spin ? "+spin" : ""}`;
    if (wanted !== lastGlyph) {
      lastGlyph = wanted;
      playBtn.innerHTML = spin ? `<span class="spin">${icon.refresh}</span>` : icon[glyph];
      const label = glyph === "pause" ? "Pause" : "Play";
      playBtn.title = label;
      playBtn.setAttribute("aria-label", label);
    }

    const max = Math.max(1, Math.round(s.durationSec));
    if (max !== lastMax) {
      lastMax = max;
      seek.max = String(max);
    }
    if (!dragging) {
      seek.value = String(Math.min(max, Math.round(s.positionSec)));
      renderTimes(s.positionSec, s.durationSec);
    }

    renderTrack(s.trackIndex);

    const count = `Track ${s.trackIndex + 1} of ${tracks.length}`;
    if (count !== lastCount) {
      lastCount = count;
      countEl.textContent = count;
    }

    const elapsed = toElapsed(tracks, s.trackIndex, s.positionSec);
    const book =
      bookTotal > 0
        ? `${formatPct(elapsed / bookTotal)} of the book · ${formatClock(bookTotal - elapsed)} left`
        : "";
    if (book !== lastBook) {
      lastBook = book;
      bookEl.textContent = book;
    }

    const fault = s.status === "error" ? (s.error ?? "This track could not be played") : "";
    if (fault !== lastFault) {
      lastFault = fault;
      faultEl.hidden = fault === "";
      faultText.textContent = fault;
      playBtn.disabled = fault !== "";
      root.querySelector<HTMLButtonElement>('#abp-fault [data-act="playNext"]')!.hidden =
        s.trackIndex + 1 >= tracks.length;
    }

    if (s.rate !== lastRate) {
      lastRate = s.rate;
      rateBtn.textContent = `${s.rate}×`;
    }
  }

  function renderSleep(): void {
    const until = sleepState.get().until;
    sleepBtn.classList.toggle("btn--on", until !== null);
    sleepLabel.textContent =
      until === null
        ? "Sleep timer"
        : `Sleep at ${new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    sleepBtn.title = until === null ? "Sleep timer" : "Sleep timer is on";
  }

  renderSkip();
  render();
  renderSleep();

  const unsubState = audiobookState.subscribe(render);
  const unsubSleep = sleepState.subscribe(renderSleep);
  // The skip size is read defensively off settings; follow it if it changes.
  const unsubSkip = subscribeSelect(
    settingsStore,
    () => skipSeconds(),
    (seconds) => {
      skip = seconds;
      renderSkip();
    },
  );

  return {
    dispose() {
      // Playback deliberately outlives the view — leaving the screen does not
      // stop the book, exactly as it does not stop a read-aloud. The one
      // exception is the documented miniPlayer contract: with the bar turned
      // off there is nowhere to control a book you have walked away from, so
      // leaving pauses it, matching the reader.
      if (!settingsStore.get().miniPlayer) audiobook.pause();
      unsubState();
      unsubSleep();
      unsubSkip();
      root.removeEventListener("click", onClick);
      listEl.removeEventListener("click", onListClick);
      window.removeEventListener("pointerup", commitSeek);
      window.removeEventListener("pointercancel", commitSeek);
      root.remove();
    },
  };
}
