// The audiobook player — a global singleton for imported audio files
// (mp3 / m4b / flac …). Deliberately SEPARATE from the reading engine: linear
// audio has no text, no synthesis, no sentence queue and no prefetch, so it
// shares nothing with `engine.ts` except two pure fade helpers and the rule
// that only one of them may be audible at a time.
//
// Shape mirrors engine.ts on purpose, so views work the same way:
//   audiobookState / sleepState stores → subscribe for UI
//   audiobook.load/play/pause/toggle/stop/unload
//   audiobook.seekTo/skip/nextTrack/prevTrack/goToTrack/setRate/setVolume
//   audiobook.startSleepTimer/cancelSleepTimer
//
// Nothing ticks at idle: position comes from the element's own `timeupdate`
// event (no polling), the sleep fade only runs inside its ten-second ramp,
// and every listener is removed when playback stops or rebinds.

import { convertFileSrc } from "@tauri-apps/api/core";
import { fileName, formatDuration } from "../core/format";
import { describeError, inTauri, ipc } from "../core/ipc";
import { updateItem } from "../core/library";
import { DEFAULT_AUDIO_SKIP, settingsStore, updatePlaybackPrefs } from "../core/session";
import { Store, subscribeSelect } from "../core/store";
import type { AudioState, AudioTrack, LibraryItem, PlaybackStatus } from "../core/types";
import { engine, fadedVolume, SLEEP_FADE_MS, sleepFadeGain } from "./engine";
import { claimPlayback, registerPlayer, releasePlayback } from "./audio-lock";

export interface AudiobookState {
  status: PlaybackStatus;
  /** Item currently bound (null = nothing loaded). */
  itemId: string | null;
  /** Index into the bound item's tracks. */
  trackIndex: number;
  /** Position inside the CURRENT track, seconds. */
  positionSec: number;
  /** Duration of the current track, seconds (element duration once known). */
  durationSec: number;
  rate: number;
  volume: number;
  /** Short user-readable reason when status === "error". */
  error: string | null;
}

export interface AudiobookSleepState {
  /** Epoch ms when playback will pause (null = no timer). */
  until: number | null;
}

export const audiobookState = new Store<AudiobookState>({
  status: "idle",
  itemId: null,
  trackIndex: 0,
  positionSec: 0,
  durationSec: 0,
  rate: settingsStore.get().playback.rate,
  volume: settingsStore.get().playback.volume,
  error: null,
});

export const sleepState = new Store<AudiobookSleepState>({ until: null });

/* ================= pure helpers ================= */

/** A duration we can do arithmetic with: unknown or nonsense reads as 0. */
export function safeDuration(sec: number | undefined): number {
  return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec : 0;
}

/** Cumulative start second of every track, with the book total appended:
 *  `offsets[i]` is where track i begins, `offsets[tracks.length]` is the whole
 *  book. Always one longer than the track list, so it is safe to index. */
export function trackOffsets(tracks: readonly AudioTrack[]): number[] {
  const out: number[] = [0];
  let acc = 0;
  for (const t of tracks) {
    acc += safeDuration(t.durationSec);
    out.push(acc);
  }
  return out;
}

/** Total playing time of the whole book, seconds. */
export function totalDuration(tracks: readonly AudioTrack[]): number {
  return trackOffsets(tracks)[tracks.length] ?? 0;
}

/** Seconds from the start of the BOOK for a position inside one track. */
export function toElapsed(
  tracks: readonly AudioTrack[],
  trackIndex: number,
  offsetSec: number,
): number {
  if (tracks.length === 0) return 0;
  const offsets = trackOffsets(tracks);
  const i = Math.max(0, Math.min(Math.trunc(trackIndex) || 0, tracks.length - 1));
  const dur = safeDuration(tracks[i]?.durationSec);
  const within = Number.isFinite(offsetSec) ? Math.max(0, Math.min(offsetSec, dur)) : 0;
  return (offsets[i] ?? 0) + within;
}

/** Where a book-elapsed second lands. A track boundary belongs to the START of
 *  the next track (so elapsed round-trips through a whole-book slider); past
 *  the end it pins to the very end of the last track. */
export function fromElapsed(
  tracks: readonly AudioTrack[],
  elapsedSec: number,
): { trackIndex: number; offsetSec: number } {
  const n = tracks.length;
  if (n === 0) return { trackIndex: 0, offsetSec: 0 };
  const offsets = trackOffsets(tracks);
  const total = offsets[n] ?? 0;
  const t = Number.isFinite(elapsedSec) ? Math.max(0, elapsedSec) : 0;
  if (t >= total) {
    return { trackIndex: n - 1, offsetSec: safeDuration(tracks[n - 1]?.durationSec) };
  }
  let i = 0;
  while (i + 1 < n && (offsets[i + 1] ?? 0) <= t) i++;
  return { trackIndex: i, offsetSec: t - (offsets[i] ?? 0) };
}

/** New offset after skipping `delta` seconds inside one track. Skipping past
 *  the end lands exactly ON the end — the `ended` event then rolls into the
 *  next track, so a forward skip near a boundary never stalls. Skipping back
 *  past the start stops at the start rather than falling into the track
 *  before it. */
export function clampSkip(offsetSec: number, delta: number, durationSec: number): number {
  const from = Number.isFinite(offsetSec) ? offsetSec : 0;
  const step = Number.isFinite(delta) ? delta : 0;
  const next = Math.max(0, from + step);
  const dur = safeDuration(durationSec);
  return dur > 0 ? Math.min(next, dur) : next;
}

/** Timeline clock: `m:ss` under an hour, `h:mm:ss` above it. Shares the app's
 *  duration formatting so every elapsed/remaining label reads the same. */
export function formatClock(sec: number): string {
  return formatDuration(sec);
}

/** Where `load` resumes: the stored point, clamped onto the tracks that
 *  actually exist (a book can be re-imported with different files). A book
 *  left sitting on the last frame of a track restarts that track instead of
 *  ending the moment it is played. */
export function resumePosition(
  tracks: readonly AudioTrack[],
  audio: AudioState | undefined,
): { trackIndex: number; offsetSec: number } {
  const n = tracks.length;
  if (n === 0) return { trackIndex: 0, offsetSec: 0 };
  const rawIndex =
    audio && Number.isFinite(audio.trackIndex) ? Math.trunc(audio.trackIndex) : 0;
  const trackIndex = Math.max(0, Math.min(rawIndex, n - 1));
  const dur = safeDuration(tracks[trackIndex]?.durationSec);
  const rawOffset = audio && Number.isFinite(audio.offsetSec) ? Math.max(0, audio.offsetSec) : 0;
  if (dur > 0 && rawOffset >= dur - 0.25) return { trackIndex, offsetSec: 0 };
  return { trackIndex, offsetSec: dur > 0 ? Math.min(rawOffset, dur) : rawOffset };
}

/** Skip size in seconds from a stored setting value. Settings are sanitized
 *  on load, but the player is the thing that acts on this number, so it
 *  refuses nonsense on its own rather than trusting the store. */
export function sanitizeSkipSeconds(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_AUDIO_SKIP;
  return Math.min(120, n);
}

/** What the skip buttons and the OS seek actions move by. */
export function skipSeconds(): number {
  return sanitizeSkipSeconds(settingsStore.get().audioSkipSeconds);
}

/** The message shown when a referenced file is no longer where it was. Files
 *  are played in place (audiobooks are gigabytes), so this is a normal state,
 *  not a crash. */
export function missingFileMessage(path: string | undefined): string {
  const name = path ? fileName(path) : "this audio file";
  return `Can't play ${name} — the file may have been moved, renamed, or deleted`;
}

/* ================= internals ================= */

/** How often the sleep fade re-applies its gain — only while actually fading. */
const FADE_TICK_MS = 200;
/** Ticks arrive about four times a second; re-arming a save on every one would
 *  rewrite the library index twice a second. A running position only re-arms
 *  once per this many seconds, and then the same 500ms debounce the reading
 *  engine uses collapses the burst. Pause, seek, track change, stop and
 *  rebinding all flush immediately, so the only way to lose a position is to
 *  kill the app mid-track — and then by at most a few seconds. */
const PERSIST_EVERY_SEC = 5;
const PERSIST_DEBOUNCE_MS = 500;

let tracks: AudioTrack[] = [];
let itemId: string | null = null;
let bookTitle = "";
let bookAuthor = "";
let coverPath: string | null = null;

let audio: HTMLAudioElement | null = null;
/** Listener removers for the live element — emptied by teardownAudio. */
let detachers: (() => void)[] = [];
/** Bumped whenever in-flight async work must become a no-op. */
let gen = 0;
/** Offset to apply once the current source reports its metadata. */
let pendingStart: number | null = null;

let persistTimer: number | undefined;
let persistBucket = -1;
let lastReportedPlaying: boolean | null = null;
let mediaClaimed = false;

let sleepTimeout: number | undefined;
/** Sleep-fade gain applied on top of the user's volume (1 = no fade). */
let fadeGain = 1;
let fadeStartTimer: number | undefined;
let fadeTick: number | undefined;

function patch(p: Partial<AudiobookState>): void {
  audiobookState.update((s) => ({ ...s, ...p }));
}

function trackAt(index: number): AudioTrack | undefined {
  return tracks[index];
}

function isActive(): boolean {
  const st = audiobookState.get().status;
  return st === "playing" || st === "loading";
}

/* ---- persistence ---- */

function flushPersist(): void {
  window.clearTimeout(persistTimer);
  persistTimer = undefined;
  const id = itemId;
  if (!id || tracks.length === 0) return;
  const st = audiobookState.get();
  const total = totalDuration(tracks);
  const elapsed = toElapsed(tracks, st.trackIndex, st.positionSec);
  // One patch → one index clone → one store notification for the whole save.
  updateItem(id, {
    audio: {
      tracks,
      trackIndex: st.trackIndex,
      offsetSec: st.positionSec,
      totalSec: total,
    },
    progressPct: total > 0 ? Math.max(0, Math.min(1, elapsed / total)) : 0,
  });
}

function schedulePersist(): void {
  if (!itemId) return;
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = undefined;
    flushPersist();
  }, PERSIST_DEBOUNCE_MS);
}

/* ---- OS surfaces: tray + media session ---- */

function hasMediaSession(): boolean {
  return typeof navigator !== "undefined" && "mediaSession" in navigator;
}

function reportPlaying(playing: boolean): void {
  if (playing === lastReportedPlaying) return;
  lastReportedPlaying = playing;
  if (inTauri) {
    void ipc.setPlaybackState(playing, playing ? bookTitle || null : null).catch(() => {});
  }
  if (hasMediaSession()) {
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }
}

function updateMediaSession(): void {
  if (!hasMediaSession()) return;
  const track = trackAt(audiobookState.get().trackIndex);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track?.title || bookTitle || "Tarotalking",
    artist: bookAuthor || track?.title || "",
    album: bookTitle || "Tarotalking",
    artwork: coverPath ? [{ src: convertFileSrc(coverPath) }] : [],
  });
}

/** Tell the OS transport where we are. Called on the events that MOVE the
 *  position, never on the tick stream — the shell extrapolates from the
 *  reported rate on its own. */
function updatePositionState(): void {
  if (!hasMediaSession()) return;
  const ms = navigator.mediaSession;
  if (typeof ms.setPositionState !== "function") return;
  const st = audiobookState.get();
  if (!(st.durationSec > 0)) return;
  try {
    ms.setPositionState({
      duration: st.durationSec,
      playbackRate: st.rate > 0 ? st.rate : 1,
      position: Math.max(0, Math.min(st.positionSec, st.durationSec)),
    });
  } catch {
    /* a position past a still-loading duration is not worth reporting */
  }
}

function claimMediaSession(): void {
  if (mediaClaimed || !hasMediaSession()) return;
  mediaClaimed = true;
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => void audiobook.play());
  ms.setActionHandler("pause", () => audiobook.pause());
  ms.setActionHandler("stop", () => audiobook.stop());
  ms.setActionHandler("previoustrack", () => audiobook.prevTrack());
  ms.setActionHandler("nexttrack", () => audiobook.nextTrack());
  ms.setActionHandler("seekbackward", () => audiobook.skip(-skipSeconds()));
  ms.setActionHandler("seekforward", () => audiobook.skip(skipSeconds()));
}

/** Hand the OS transport back to the reading engine. Its handlers are bound
 *  once when it is imported, so they are re-pointed here through its public
 *  API rather than by reaching into it. */
function releaseMediaSession(): void {
  if (!mediaClaimed || !hasMediaSession()) return;
  mediaClaimed = false;
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => void engine.play());
  ms.setActionHandler("pause", () => engine.pause());
  ms.setActionHandler("stop", () => engine.stop());
  ms.setActionHandler("previoustrack", () => engine.prevParagraph());
  ms.setActionHandler("nexttrack", () => engine.nextParagraph());
  ms.setActionHandler("seekbackward", () => engine.prevSentence());
  ms.setActionHandler("seekforward", () => engine.nextSentence());
}

/* ---- sleep fade (same rules and helpers as the reading engine) ---- */

function applyVolume(): void {
  if (audio) audio.volume = fadedVolume(audiobookState.get().volume, fadeGain);
}

function clearFadeTimers(): void {
  window.clearTimeout(fadeStartTimer);
  fadeStartTimer = undefined;
  window.clearInterval(fadeTick);
  fadeTick = undefined;
}

/** Stop any fade and put the user's configured volume back. Every path that
 *  leaves playback calls this — a faded-out volume must never survive. */
function endFade(): void {
  clearFadeTimers();
  if (fadeGain !== 1) {
    fadeGain = 1;
    applyVolume();
  }
}

function rampFade(): void {
  window.clearInterval(fadeTick);
  const step = (): void => {
    const until = sleepState.get().until;
    if (until === null || !isActive()) {
      endFade();
      return;
    }
    fadeGain = sleepFadeGain(until - Date.now(), SLEEP_FADE_MS);
    applyVolume();
  };
  fadeTick = window.setInterval(step, FADE_TICK_MS);
  step();
}

/** Schedule the fade for an armed sleep timer. Nothing is scheduled unless a
 *  deadline exists AND audio is running, so idle ticks nothing. */
function armFade(): void {
  clearFadeTimers();
  const until = sleepState.get().until;
  if (until === null || !isActive()) return;
  const lead = until - Date.now() - SLEEP_FADE_MS;
  if (lead > 0) fadeStartTimer = window.setTimeout(rampFade, lead);
  else rampFade();
}

/* ---- the element ---- */

function ensureAudio(): HTMLAudioElement {
  if (audio) return audio;
  const el = new Audio();
  el.preservesPitch = true;
  el.preload = "auto";

  const onTime = (): void => {
    pendingStart = null; // a tick means the element is positioned for real
    patch({ positionSec: el.currentTime });
    const bucket = Math.floor(el.currentTime / PERSIST_EVERY_SEC);
    if (bucket !== persistBucket) {
      persistBucket = bucket;
      schedulePersist();
    }
  };

  const onMeta = (): void => {
    const dur =
      Number.isFinite(el.duration) && el.duration > 0
        ? el.duration
        : safeDuration(trackAt(audiobookState.get().trackIndex)?.durationSec);
    patch({ durationSec: dur });
    // Seeking before metadata arrives only sets a "default start position";
    // re-apply it here when the element did not honour it. Guarded on still
    // being at the very start, because durationchange can also fire mid-track
    // when a VBR file refines its estimate — that must never rewind anyone.
    if (pendingStart !== null) {
      const want = Math.min(pendingStart, Math.max(0, dur - 0.25));
      pendingStart = null;
      if (want > 0 && el.currentTime < 0.5) el.currentTime = want;
    }
    updatePositionState();
  };

  const onEnded = (): void => {
    const st = audiobookState.get();
    patch({ positionSec: st.durationSec });
    if (st.trackIndex + 1 < tracks.length) {
      void startTrack(st.trackIndex + 1, 0, true);
    } else {
      finish();
    }
  };

  const onError = (): void => {
    fail(missingFileMessage(trackAt(audiobookState.get().trackIndex)?.path));
  };

  el.addEventListener("timeupdate", onTime);
  el.addEventListener("loadedmetadata", onMeta);
  el.addEventListener("durationchange", onMeta);
  el.addEventListener("ended", onEnded);
  el.addEventListener("error", onError);
  detachers = [
    () => el.removeEventListener("timeupdate", onTime),
    () => el.removeEventListener("loadedmetadata", onMeta),
    () => el.removeEventListener("durationchange", onMeta),
    () => el.removeEventListener("ended", onEnded),
    () => el.removeEventListener("error", onError),
  ];
  audio = el;
  return el;
}

/** Drop the element and every listener on it. Nothing of ours is left
 *  subscribed to anything once this returns. */
function teardownAudio(): void {
  const el = audio;
  audio = null;
  pendingStart = null;
  if (!el) return;
  for (const off of detachers) off();
  detachers = [];
  el.pause();
  el.removeAttribute("src");
  el.load(); // releases the decoder and any buffered data
}

async function startTrack(index: number, offsetSec: number, autoplay: boolean): Promise<void> {
  const track = trackAt(index);
  if (!track) {
    finish();
    return;
  }
  const myGen = ++gen;
  const el = ensureAudio();
  const dur = safeDuration(track.durationSec);
  const start = Math.max(0, offsetSec);
  persistBucket = -1;
  patch({
    status: autoplay ? "loading" : "paused",
    trackIndex: index,
    positionSec: start,
    durationSec: dur,
    error: null,
  });
  el.src = convertFileSrc(track.path);
  el.playbackRate = audiobookState.get().rate;
  el.volume = fadedVolume(audiobookState.get().volume, fadeGain);
  pendingStart = start > 0 ? start : null;
  if (start > 0) el.currentTime = start;
  updateMediaSession();
  updatePositionState();
  flushPersist();
  if (!autoplay) return;

  try {
    await el.play();
  } catch (e) {
    if (myGen !== gen) return;
    fail(describeError(e));
    return;
  }
  if (myGen !== gen) return;
  patch({ status: "playing" });
  reportPlaying(true);
  armFade();
}

/** The last track played out: park at the end, mark the book finished. */
function finish(): void {
  gen++;
  endFade();
  teardownAudio();
  releaseMediaSession();
  patch({ status: "idle", positionSec: audiobookState.get().durationSec });
  reportPlaying(false);
  const id = itemId;
  if (!id || tracks.length === 0) return;
  const last = tracks.length - 1;
  window.clearTimeout(persistTimer);
  persistTimer = undefined;
  updateItem(id, {
    audio: {
      tracks,
      trackIndex: last,
      offsetSec: safeDuration(trackAt(last)?.durationSec),
      totalSec: totalDuration(tracks),
    },
    progressPct: 1,
    finished: true,
  });
}

function fail(message: string): void {
  gen++;
  endFade();
  if (audio && !audio.paused) audio.pause();
  patch({ status: "error", error: message });
  reportPlaying(false);
}

// Volume is one app-wide preference: a change made from the reading player's
// bar applies here too, without either side reaching into the other.
subscribeSelect(
  settingsStore,
  (s) => s.playback.volume,
  (volume) => {
    patch({ volume });
    applyVolume();
  },
);

/* ================= public API ================= */

export const audiobook = {
  /** Bind an audiobook item (does not start playing). Re-binding the same
   *  item leaves a live session alone; a different item saves the outgoing
   *  position first. */
  load(item: LibraryItem): void {
    if (itemId === item.id && tracks.length > 0) {
      if (!isActive()) {
        // Refresh from the index in case the position moved elsewhere.
        const at = resumePosition(tracks, item.audio);
        patch({
          trackIndex: at.trackIndex,
          positionSec: at.offsetSec,
          durationSec: safeDuration(trackAt(at.trackIndex)?.durationSec),
        });
      }
      return;
    }
    gen++;
    endFade();
    flushPersist(); // save the OUTGOING book before letting go of it
    teardownAudio();
    releaseMediaSession();
    reportPlaying(false);

    itemId = item.id;
    tracks = item.audio?.tracks ?? [];
    bookTitle = item.title;
    bookAuthor = item.author ?? "";
    coverPath = item.cover ?? null;
    persistBucket = -1;

    const at = resumePosition(tracks, item.audio);
    const empty = tracks.length === 0;
    patch({
      status: empty ? "error" : "idle",
      itemId: item.id,
      trackIndex: at.trackIndex,
      positionSec: at.offsetSec,
      durationSec: safeDuration(trackAt(at.trackIndex)?.durationSec),
      rate: item.rate ?? settingsStore.get().playback.rate,
      volume: settingsStore.get().playback.volume,
      error: empty ? "This audiobook has no audio files" : null,
    });
  },

  /** Stop and release everything (does NOT clear the saved position). */
  unload(): void {
    audiobook.stop();
    itemId = null;
    tracks = [];
    bookTitle = "";
    bookAuthor = "";
    coverPath = null;
    patch({ status: "idle", itemId: null, trackIndex: 0, positionSec: 0, durationSec: 0, error: null });
  },

  async play(): Promise<void> {
    if (tracks.length === 0) return;
    const st = audiobookState.get();
    if (st.status === "playing" || st.status === "loading") return;
    // One thing is ever audible — the arbiter silences whatever else holds
    // the output, whichever player that happens to be.
    claimPlayback("audiobook");
    claimMediaSession();

    // Mid-track resume: the element still holds this track's decoded stream.
    const el = audio;
    if (el && el.getAttribute("src") && !el.ended && Math.abs(el.currentTime - st.positionSec) < 1) {
      const myGen = gen;
      patch({ status: "loading", error: null });
      try {
        await el.play();
        if (myGen !== gen) return;
        patch({ status: "playing" });
        reportPlaying(true);
        updatePositionState();
        armFade();
        return;
      } catch {
        if (myGen !== gen) return;
        /* fall through to a fresh start */
      }
    }
    await startTrack(st.trackIndex, st.positionSec, true);
  },

  pause(): void {
    const st = audiobookState.get();
    if (st.status !== "playing" && st.status !== "loading") return;
    gen++; // cancel an in-flight start
    if (audio && !audio.paused) audio.pause();
    patch({ status: "paused", positionSec: audio?.currentTime ?? st.positionSec });
    endFade(); // a manual pause mid-fade must hand the volume back
    reportPlaying(false);
    updatePositionState();
    flushPersist();
  },

  toggle(): void {
    if (isActive()) audiobook.pause();
    else void audiobook.play();
  },

  /** Stop, drop the element and hand the OS transport back. */
  stop(): void {
    gen++;
    endFade();
    flushPersist();
    teardownAudio();
    releaseMediaSession();
    releasePlayback("audiobook");
    patch({ status: "idle" });
    reportPlaying(false);
  },

  /** Seek within the CURRENT track (the timeline is per track). */
  seekTo(sec: number): void {
    const st = audiobookState.get();
    const target = clampSkip(0, sec, st.durationSec); // clamp into the track
    patch({ positionSec: target });
    persistBucket = Math.floor(target / PERSIST_EVERY_SEC);
    if (audio && audio.getAttribute("src")) {
      pendingStart = target > 0 ? target : null;
      audio.currentTime = target;
    }
    updatePositionState();
    flushPersist();
  },

  /** Jump `delta` seconds, clamped to this track's start and end. */
  skip(delta: number): void {
    const st = audiobookState.get();
    const from = audio?.currentTime ?? st.positionSec;
    audiobook.seekTo(clampSkip(from, delta, st.durationSec));
  },

  nextTrack(): void {
    const st = audiobookState.get();
    if (st.trackIndex + 1 >= tracks.length) {
      finish();
      return;
    }
    audiobook.goToTrack(st.trackIndex + 1);
  },

  prevTrack(): void {
    audiobook.goToTrack(Math.max(0, audiobookState.get().trackIndex - 1));
  },

  /** Jump to a track. Keeps playing if playback was running; otherwise just
   *  moves the position, so a paused reader can browse the track list. */
  goToTrack(index: number, offsetSec = 0): void {
    if (index < 0 || index >= tracks.length) return;
    const wasActive = isActive();
    flushPersist();
    if (wasActive) {
      void startTrack(index, offsetSec, true);
      return;
    }
    gen++;
    teardownAudio();
    persistBucket = -1;
    patch({
      trackIndex: index,
      positionSec: Math.max(0, offsetSec),
      durationSec: safeDuration(trackAt(index)?.durationSec),
      error: null,
    });
    updateMediaSession();
    updatePositionState();
    flushPersist();
  },

  /** Per-book speed memory — the reading engine's global default is left
   *  alone, so an audiobook's speed never retunes synthesized voices. */
  setRate(rate: number): void {
    const r = Math.max(0.5, Math.min(3, Number.isFinite(rate) ? rate : 1));
    patch({ rate: r });
    if (audio) audio.playbackRate = r;
    if (itemId) updateItem(itemId, { rate: r });
    updatePositionState();
  },

  setVolume(volume: number): void {
    const v = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1));
    updatePlaybackPrefs({ volume: v }); // volume is one app-wide preference
    patch({ volume: v });
    applyVolume(); // respects a fade in progress; becomes the restored level
  },

  startSleepTimer(minutes: number): void {
    window.clearTimeout(sleepTimeout);
    endFade(); // re-arming replaces any ramp already in flight
    const ms = Math.max(0, minutes) * 60_000;
    sleepState.set({ until: Date.now() + ms });
    sleepTimeout = window.setTimeout(() => {
      sleepState.set({ until: null });
      audiobook.pause(); // pause() ends the fade and restores the volume
      endFade(); // …and again for the case where playback already stopped
    }, ms);
    armFade();
  },

  cancelSleepTimer(): void {
    window.clearTimeout(sleepTimeout);
    sleepState.set({ until: null });
    endFade(); // cancelling mid-fade brings the volume straight back up
  },
};

// Let the arbiter silence this player when something else starts.
registerPlayer("audiobook", () => {
  const st = audiobookState.get();
  if (st.status === "playing" || st.status === "loading") audiobook.pause();
});
