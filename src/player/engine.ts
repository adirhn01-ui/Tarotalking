// The playback engine — a global singleton that outlives views (background
// playback). Owns: sentence queue, synth prefetch, status, media session,
// sleep timer, playback-position persistence. Views only render its stores
// and call its methods.
//
// API is FROZEN:
//   engineState / activeWord / sleepState stores → subscribe for UI
//   engine.load/play/pause/toggle/stop/seekTo/next*/prev*/setRate/setVolume
//   engine.startSleepTimer/cancelSleepTimer, engine.seekToPct

import { convertFileSrc } from "@tauri-apps/api/core";
import { getItem, setPlaybackPosition, updateItem } from "../core/library";
import { describeError, inTauri, ipc } from "../core/ipc";
import { splitSentences, type SentenceSpan } from "../core/segment";
import { settingsStore, updatePlaybackPrefs } from "../core/session";
import { Store, subscribeSelect } from "../core/store";
import type {
  Block,
  ContentDoc,
  PlaybackStatus,
  Position,
  SynthResult,
  VoiceRef,
  WordBoundary,
} from "../core/types";
import { getProvider, type SpeakHandle } from "./providers/provider";

export interface EngineState {
  status: PlaybackStatus;
  /** Item currently bound for playback (null = nothing loaded). */
  itemId: string | null;
  /** The sentence being spoken (or queued to speak next). */
  pos: Position | null;
  /** 0..1 progress through the whole document (char-weighted). */
  pct: number;
  rate: number;
  volume: number;
  /** Short user-readable reason when status === "error". */
  error: string | null;
}

/** Word-level highlight within the current sentence (char offsets). */
export interface ActiveWord {
  charStart: number;
  charLen: number;
}

export interface SleepState {
  /** Epoch ms when playback will pause (null = no timer). */
  until: number | null;
  endOfChapter: boolean;
}

export const engineState = new Store<EngineState>({
  status: "idle",
  itemId: null,
  pos: null,
  pct: 0,
  rate: settingsStore.get().playback.rate,
  volume: settingsStore.get().playback.volume,
  error: null,
});

export const activeWord = new Store<ActiveWord | null>(null);

export const sleepState = new Store<SleepState>({ until: null, endOfChapter: false });

/* ================= internals ================= */

function speakable(b: Block | undefined): b is Block & { text: string } {
  return !!b && b.t !== "img" && b.t !== "hr" && typeof b.text === "string" && b.text.trim().length > 0;
}

let doc: ContentDoc | null = null;
let itemId: string | null = null;
let docTitle = "";
let pos: Position = { chapter: 0, block: 0, sentence: 0 };
/** Bumped whenever in-flight async work must become a no-op. */
let gen = 0;

const sentenceCache = new Map<string, SentenceSpan[]>();
/** Char-weighted cumulative sizes for progress/seek. */
let chapterCharStart: number[] = [];
let blockCharStart: number[][] = [];
let totalChars = 1;

let audio: HTMLAudioElement | null = null;
let utterHandle: SpeakHandle | null = null;
const prefetch = new Map<string, Promise<SynthResult>>();
let wordTimer: number | undefined;
let currentBounds: WordBoundary[] | null = null;
let boundIndex = 0;
/** One-shot: start the NEXT spoken sentence at this char offset (click-a-word).
 *  Consumed by speakCurrent; only effective when boundaries exist. */
let pendingWordSeek: number | null = null;
let sleepTimeout: number | undefined;
let lastReportedPlaying: boolean | null = null;

function key(p: Position): string {
  return `${p.chapter}.${p.block}.${p.sentence}`;
}

function sentencesAt(c: number, b: number): SentenceSpan[] {
  const k = `${c}.${b}`;
  let s = sentenceCache.get(k);
  if (!s) {
    const block = doc?.chapters[c]?.blocks[b];
    s = speakable(block) ? splitSentences(block.text) : [];
    sentenceCache.set(k, s);
    if (sentenceCache.size > 200) {
      // drop the oldest half — cheap bound, no bookkeeping
      const keys = [...sentenceCache.keys()].slice(0, 100);
      for (const old of keys) sentenceCache.delete(old);
    }
  }
  return s;
}

function buildCharIndex(): void {
  chapterCharStart = [];
  blockCharStart = [];
  let acc = 0;
  for (const ch of doc?.chapters ?? []) {
    chapterCharStart.push(acc);
    const starts: number[] = [];
    for (const b of ch.blocks) {
      starts.push(acc);
      if (speakable(b)) acc += b.text.length + 1;
    }
    blockCharStart.push(starts);
  }
  totalChars = Math.max(1, acc);
}

function pctOf(p: Position): number {
  const base = blockCharStart[p.chapter]?.[p.block] ?? 0;
  const sentences = sentencesAt(p.chapter, p.block);
  const within = sentences[p.sentence]?.start ?? 0;
  return Math.min(1, (base + within) / totalChars);
}

/** First speakable position at or after (c, b, s=0 semantics per flags). */
function normalize(p: Position): Position | null {
  if (!doc) return null;
  let { chapter, block } = p;
  let sentence = p.sentence;
  while (chapter < doc.chapters.length) {
    const blocks = doc.chapters[chapter]!.blocks;
    while (block < blocks.length) {
      if (speakable(blocks[block])) {
        const sents = sentencesAt(chapter, block);
        if (sentence < sents.length) return { chapter, block, sentence };
      }
      block++;
      sentence = 0;
    }
    chapter++;
    block = 0;
    sentence = 0;
  }
  return null;
}

function nextPos(p: Position): Position | null {
  const sents = sentencesAt(p.chapter, p.block);
  if (p.sentence + 1 < sents.length) return { ...p, sentence: p.sentence + 1 };
  return normalize({ chapter: p.chapter, block: p.block + 1, sentence: 0 });
}

function prevPos(p: Position): Position | null {
  if (p.sentence > 0) return { ...p, sentence: p.sentence - 1 };
  if (!doc) return null;
  let { chapter, block } = p;
  for (;;) {
    block--;
    while (block < 0) {
      chapter--;
      if (chapter < 0) return null;
      block = doc.chapters[chapter]!.blocks.length - 1;
    }
    if (speakable(doc.chapters[chapter]!.blocks[block])) {
      const sents = sentencesAt(chapter, block);
      if (sents.length > 0) return { chapter, block, sentence: sents.length - 1 };
    }
  }
}

function nextParagraphPos(p: Position): Position | null {
  return normalize({ chapter: p.chapter, block: p.block + 1, sentence: 0 });
}

function prevParagraphPos(p: Position): Position | null {
  if (p.sentence > 0) return { ...p, sentence: 0 };
  if (!doc) return null;
  let { chapter, block } = p;
  for (;;) {
    block--;
    while (block < 0) {
      chapter--;
      if (chapter < 0) return null;
      block = doc.chapters[chapter]!.blocks.length - 1;
    }
    if (speakable(doc.chapters[chapter]!.blocks[block])) return { chapter, block, sentence: 0 };
  }
}

function chapterStart(chapter: number): Position | null {
  return normalize({ chapter, block: 0, sentence: 0 });
}

/* ---- state helpers ---- */

function patchState(patch: Partial<EngineState>): void {
  engineState.update((s) => ({ ...s, ...patch }));
}

function reportPlaying(playing: boolean): void {
  if (!inTauri || playing === lastReportedPlaying) return;
  lastReportedPlaying = playing;
  void ipc.setPlaybackState(playing, playing ? docTitle || null : null).catch(() => {});
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }
}

let persistTimer: number | undefined;
function persistPosition(): void {
  if (!itemId) return;
  const id = itemId;
  const p = pos;
  const pct = pctOf(p);
  const label = doc?.chapters[p.chapter]?.title;
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    setPlaybackPosition(id, p, label);
    updateItem(id, { progressPct: pct });
  }, 500);
}

/* ---- voice resolution ---- */

/** Per-book voice memory — set at load, updated when the user picks a voice
 *  while this book is bound. Falls back to the global default. */
let itemVoiceOverride: VoiceRef | null = null;

async function resolveVoice(): Promise<VoiceRef> {
  if (itemVoiceOverride) return itemVoiceOverride;
  const set = settingsStore.get().playback.voice;
  if (set) return set;
  // First run: prefer Edge (best free quality) when reachable, else system,
  // else an installed local voice. Persist the pick so the UI shows it.
  const tryOrder: VoiceRef[] = [];
  try {
    const edge = await getProvider("edge").voices();
    const aria = edge.find((v) => v.id === "en-US-AriaNeural") ?? edge[0];
    if (aria) tryOrder.push({ provider: "edge", id: aria.id });
  } catch {
    /* offline */
  }
  if (tryOrder.length === 0) {
    try {
      const sys = await getProvider("system").voices();
      if (sys[0]) tryOrder.push({ provider: "system", id: sys[0].id });
    } catch {
      /* none */
    }
  }
  if (tryOrder.length === 0) {
    try {
      const local = await getProvider("piper").voices();
      if (local[0]) tryOrder.push({ provider: "piper", id: local[0].id });
    } catch {
      /* none */
    }
  }
  const pick = tryOrder[0];
  if (!pick) throw new Error("No voices are available — check Settings → Voices");
  updatePlaybackPrefs({ voice: pick });
  return pick;
}

/* ---- synthesis / playback ---- */

function ensureAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.preservesPitch = true;
    audio.addEventListener("ended", () => {
      if (engineState.get().status === "playing") advance();
    });
  }
  return audio;
}

function synthKey(v: VoiceRef, p: Position): string {
  return `${v.provider}|${v.id}|${key(p)}`;
}

function ensureSynth(v: VoiceRef, p: Position): Promise<SynthResult> {
  const k = synthKey(v, p);
  let promise = prefetch.get(k);
  if (!promise) {
    const sentence = sentencesAt(p.chapter, p.block)[p.sentence];
    if (!sentence) return Promise.reject(new Error("Nothing to speak here"));
    const provider = getProvider(v.provider);
    if (!provider.synth) return Promise.reject(new Error("Voice provider mismatch"));
    promise = provider.synth(v.id, sentence.text);
    prefetch.set(k, promise);
    // Failed prefetches must not poison later retries.
    promise.catch(() => prefetch.delete(k));
    if (prefetch.size > 8) {
      const first = prefetch.keys().next().value;
      if (first) prefetch.delete(first);
    }
  }
  return promise;
}

function prefetchAhead(v: VoiceRef, from: Position): void {
  let p: Position | null = from;
  for (let i = 0; i < 2; i++) {
    p = nextPos(p);
    if (!p) return;
    void ensureSynth(v, p).catch(() => {});
  }
}

function clearWordTimer(): void {
  window.clearTimeout(wordTimer);
  wordTimer = undefined;
}

function scheduleWordHighlight(): void {
  clearWordTimer();
  const bounds = currentBounds;
  const el = audio;
  if (!bounds || !el || settingsStore.get().playback.highlight !== "word") return;
  const t = el.currentTime * 1000;
  // find the boundary we're inside/before
  let i = 0;
  while (i < bounds.length && bounds[i]!.offsetMs <= t) i++;
  if (i > 0) {
    const b = bounds[i - 1]!;
    if (b.charLen > 0) activeWord.set({ charStart: b.charStart, charLen: b.charLen });
  }
  boundIndex = i;
  armNextBoundary();
}

function armNextBoundary(): void {
  const bounds = currentBounds;
  const el = audio;
  if (!bounds || !el || boundIndex >= bounds.length) return;
  const next = bounds[boundIndex]!;
  const delayMs = Math.max(0, (next.offsetMs - el.currentTime * 1000) / (el.playbackRate || 1));
  wordTimer = window.setTimeout(() => {
    if (engineState.get().status !== "playing") return;
    if (next.charLen > 0) activeWord.set({ charStart: next.charStart, charLen: next.charLen });
    boundIndex++;
    armNextBoundary();
  }, delayMs);
}

function cancelCurrentAudio(): void {
  clearWordTimer();
  currentBounds = null;
  pendingWordSeek = null;
  activeWord.set(null);
  if (utterHandle) {
    utterHandle.cancel();
    utterHandle = null;
  }
  if (audio && !audio.paused) audio.pause();
}

async function speakCurrent(): Promise<void> {
  if (!doc || !itemId) return;
  const myGen = gen;
  const sentence = sentencesAt(pos.chapter, pos.block)[pos.sentence];
  if (!sentence) {
    finish();
    return;
  }
  patchState({ status: "loading", pos, pct: pctOf(pos), error: null });
  persistPosition();
  updateMediaSession();

  let voice: VoiceRef;
  try {
    voice = await resolveVoice();
  } catch (e) {
    if (myGen !== gen) return;
    fail(describeError(e));
    return;
  }
  if (myGen !== gen) return;

  const provider = getProvider(voice.provider);
  const prefs = settingsStore.get().playback;

  if (provider.kind === "audio") {
    let result: SynthResult;
    try {
      result = await ensureSynth(voice, pos);
    } catch (e) {
      if (myGen !== gen) return;
      fail(describeError(e));
      return;
    }
    if (myGen !== gen) return;
    const el = ensureAudio();
    el.src = convertFileSrc(result.path);
    el.playbackRate = engineState.get().rate; // per-book memory, not the global default
    el.volume = prefs.volume;
    currentBounds = result.boundaries?.length ? result.boundaries : null;
    boundIndex = 0;
    // Click-a-word: jump into the sentence at the clicked word's audio offset
    // (word boundaries required — providers without them start at the top).
    if (pendingWordSeek !== null) {
      const target = pendingWordSeek;
      pendingWordSeek = null;
      const hit = currentBounds?.find((b) => b.charLen > 0 && b.charStart + b.charLen > target);
      if (hit && hit.offsetMs > 0) el.currentTime = hit.offsetMs / 1000;
    }
    try {
      await el.play();
    } catch (e) {
      if (myGen !== gen) return;
      fail(describeError(e));
      return;
    }
    if (myGen !== gen) return;
    patchState({ status: "playing" });
    reportPlaying(true);
    scheduleWordHighlight();
    prefetchAhead(voice, pos);
  } else {
    // utterance provider (system speech)
    if (!provider.speak) {
      fail("Voice provider mismatch");
      return;
    }
    utterHandle = provider.speak(voice.id, sentence.text, {
      rate: engineState.get().rate,
      volume: prefs.volume,
      onBoundary: (charStart, charLen) => {
        if (myGen !== gen) return;
        if (settingsStore.get().playback.highlight === "word" && charLen > 0) {
          activeWord.set({ charStart, charLen });
        }
      },
      onEnd: () => {
        if (myGen !== gen) return;
        utterHandle = null;
        advance();
      },
      onError: (message) => {
        if (myGen !== gen) return;
        utterHandle = null;
        fail(message);
      },
    });
    patchState({ status: "playing" });
    reportPlaying(true);
  }
}

function advance(): void {
  activeWord.set(null);
  const sleep = sleepState.get();
  const next = nextPos(pos);
  if (!next) {
    finish();
    return;
  }
  if (sleep.endOfChapter && next.chapter !== pos.chapter) {
    sleepState.set({ until: null, endOfChapter: false });
    pos = next;
    patchState({ status: "paused", pos, pct: pctOf(pos) });
    persistPosition();
    reportPlaying(false);
    return;
  }
  pos = next;
  void speakCurrent();
}

function finish(): void {
  cancelCurrentAudio();
  gen++;
  patchState({ status: "idle", pct: 1 });
  reportPlaying(false);
  if (itemId) updateItem(itemId, { finished: true, progressPct: 1 });
}

function fail(message: string): void {
  cancelCurrentAudio();
  gen++;
  patchState({ status: "error", error: message });
  reportPlaying(false);
}

function updateMediaSession(): void {
  if (!("mediaSession" in navigator) || !doc) return;
  const chapter = doc.chapters[pos.chapter];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: docTitle || "Tarotalking",
    artist: chapter?.title || doc.author || "",
    album: "Tarotalking",
  });
}

function initMediaSession(): void {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => void engine.play());
  ms.setActionHandler("pause", () => engine.pause());
  ms.setActionHandler("stop", () => engine.stop());
  ms.setActionHandler("previoustrack", () => engine.prevParagraph());
  ms.setActionHandler("nexttrack", () => engine.nextParagraph());
  ms.setActionHandler("seekbackward", () => engine.prevSentence());
  ms.setActionHandler("seekforward", () => engine.nextSentence());
}
initMediaSession();

// Voice changed (bar/settings) → the bound book remembers it, and a playing
// sentence restarts with the new voice.
subscribeSelect(
  settingsStore,
  (s) => s.playback.voice,
  (voice) => {
    prefetch.clear();
    itemVoiceOverride = voice;
    if (itemId && voice) updateItem(itemId, { voice });
    if (engineState.get().status === "playing" || engineState.get().status === "loading") {
      gen++;
      cancelCurrentAudio();
      void speakCurrent();
    }
  },
);

// Highlight mode switched away from word → clear any active word.
subscribeSelect(
  settingsStore,
  (s) => s.playback.highlight,
  (mode) => {
    if (mode !== "word") activeWord.set(null);
    else if (engineState.get().status === "playing") scheduleWordHighlight();
  },
);

function seekInternal(next: Position | null): void {
  if (!next) return;
  const wasActive =
    engineState.get().status === "playing" || engineState.get().status === "loading";
  gen++;
  cancelCurrentAudio();
  pos = next;
  patchState({ pos, pct: pctOf(pos) });
  persistPosition();
  if (wasActive) {
    void speakCurrent();
  } else if (engineState.get().status !== "idle") {
    patchState({ status: "paused" });
  }
}

/* ================= public API ================= */

export const engine = {
  /** Bind an item's document for playback (does not start playing).
   *  If the same item is already loaded, only refreshes the start position
   *  when idle — a playing engine is left alone. */
  load(id: string, document: ContentDoc, startPos: Position): void {
    if (itemId === id && doc) {
      if (engineState.get().status === "idle") {
        pos = normalize(startPos) ?? pos;
        patchState({ itemId: id, pos, pct: pctOf(pos) });
      }
      return;
    }
    gen++;
    cancelCurrentAudio();
    reportPlaying(false); // rebinding away from a playing item: tray must not stay "playing"
    prefetch.clear();
    sentenceCache.clear();
    doc = document;
    itemId = id;
    docTitle = document.title;
    buildCharIndex();
    pos = normalize(startPos) ?? { chapter: 0, block: 0, sentence: 0 };
    // Per-book memory: this book's remembered voice/speed take effect now
    // (global defaults are untouched — new books still use them).
    const item = getItem(id);
    itemVoiceOverride = item?.voice ?? null;
    const rate = item?.rate ?? settingsStore.get().playback.rate;
    patchState({
      status: "idle",
      itemId: id,
      pos,
      pct: pctOf(pos),
      rate,
      error: null,
    });
  },

  /** Stop and release everything (does NOT clear saved positions). */
  unload(): void {
    gen++;
    cancelCurrentAudio();
    prefetch.clear();
    sentenceCache.clear();
    doc = null;
    itemId = null;
    itemVoiceOverride = null;
    docTitle = "";
    reportPlaying(false);
    patchState({ status: "idle", itemId: null, pos: null, pct: 0, error: null });
  },

  async play(): Promise<void> {
    if (!doc) return;
    const st = engineState.get().status;
    if (st === "playing" || st === "loading") return;
    // Mid-sentence resume for audio playback.
    if (st === "paused" && audio && audio.src && audio.currentTime > 0 && !audio.ended && !utterHandle) {
      try {
        await audio.play();
        patchState({ status: "playing", error: null });
        reportPlaying(true);
        scheduleWordHighlight();
        return;
      } catch {
        /* fall through to a fresh speak */
      }
    }
    gen++;
    await speakCurrent();
  },

  pause(): void {
    const st = engineState.get().status;
    if (st !== "playing" && st !== "loading") return;
    gen++; // cancel in-flight loading
    clearWordTimer();
    if (utterHandle) {
      utterHandle.cancel();
      utterHandle = null;
    }
    if (audio && !audio.paused) audio.pause();
    patchState({ status: "paused" });
    reportPlaying(false);
  },

  toggle(): void {
    const st = engineState.get().status;
    if (st === "playing" || st === "loading") engine.pause();
    else void engine.play();
  },

  stop(): void {
    gen++;
    cancelCurrentAudio();
    if (audio) audio.removeAttribute("src");
    patchState({ status: "idle" });
    reportPlaying(false);
  },

  seekTo(p: Position): void {
    seekInternal(normalize(p));
  },

  /** Jump to a position and speak from it (click-a-word-to-read). If already
   *  playing, speech moves immediately; otherwise playback starts.
   *  `charOffset` (chars into the sentence) starts at that exact word when
   *  the provider reports word boundaries. */
  playFrom(p: Position, charOffset?: number): void {
    const next = normalize(p);
    if (!next) return;
    seekInternal(next); // cancels current audio (which resets any pending seek)
    pendingWordSeek = typeof charOffset === "number" && charOffset > 0 ? charOffset : null;
    const st = engineState.get().status;
    if (st !== "playing" && st !== "loading") void engine.play();
  },

  /** Seek by overall document fraction (the seek slider). */
  seekToPct(fraction: number): void {
    if (!doc) return;
    const target = Math.max(0, Math.min(1, fraction)) * totalChars;
    let chapter = 0;
    while (chapter + 1 < chapterCharStart.length && chapterCharStart[chapter + 1]! <= target) {
      chapter++;
    }
    const starts = blockCharStart[chapter] ?? [];
    let block = 0;
    while (block + 1 < starts.length && starts[block + 1]! <= target) block++;
    seekInternal(normalize({ chapter, block, sentence: 0 }));
  },

  nextSentence(): void {
    seekInternal(nextPos(pos));
  },
  prevSentence(): void {
    seekInternal(prevPos(pos) ?? normalize(pos));
  },
  nextParagraph(): void {
    seekInternal(nextParagraphPos(pos));
  },
  prevParagraph(): void {
    seekInternal(prevParagraphPos(pos) ?? normalize(pos));
  },
  nextChapter(): void {
    seekInternal(chapterStart(pos.chapter + 1));
  },
  prevChapter(): void {
    seekInternal(chapterStart(Math.max(0, pos.chapter - 1)));
  },

  setRate(rate: number): void {
    updatePlaybackPrefs({ rate }); // global default for new books
    if (itemId) updateItem(itemId, { rate }); // this book remembers its own
    patchState({ rate });
    if (audio) audio.playbackRate = rate;
    if (utterHandle && engineState.get().status === "playing") {
      // utterance rate is fixed per utterance — restart the sentence
      gen++;
      cancelCurrentAudio();
      void speakCurrent();
    } else if (currentBounds) {
      scheduleWordHighlight();
    }
  },

  setVolume(volume: number): void {
    updatePlaybackPrefs({ volume });
    patchState({ volume });
    if (audio) audio.volume = volume;
  },

  startSleepTimer(minutesOrChapter: number | "chapter"): void {
    window.clearTimeout(sleepTimeout);
    if (minutesOrChapter === "chapter") {
      sleepState.set({ until: null, endOfChapter: true });
      return;
    }
    const until = Date.now() + minutesOrChapter * 60_000;
    sleepState.set({ until, endOfChapter: false });
    sleepTimeout = window.setTimeout(() => {
      sleepState.set({ until: null, endOfChapter: false });
      engine.pause();
    }, minutesOrChapter * 60_000);
  },

  cancelSleepTimer(): void {
    window.clearTimeout(sleepTimeout);
    sleepState.set({ until: null, endOfChapter: false });
  },
};
