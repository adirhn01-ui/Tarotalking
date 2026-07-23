// The playback engine — a global singleton that outlives views (background
// playback). Owns: sentence queue, synth prefetch, status, media session,
// sleep timer, playback-position persistence. Views only render its stores
// and call its methods.
//
// API is FROZEN:
//   engineState / activeWord stores → subscribe for highlight + controls
//   engine.load/play/pause/toggle/stop/seekTo/next*/prev*/setRate/setVolume
//   engine.startSleepTimer/cancelSleepTimer + sleepState

import { Store } from "../core/store";
import type { ContentDoc, PlaybackStatus, Position } from "../core/types";

export interface EngineState {
  status: PlaybackStatus;
  /** Item currently bound for playback (null = nothing loaded). */
  itemId: string | null;
  /** The sentence being spoken (or queued to speak next). */
  pos: Position | null;
  rate: number;
  volume: number;
  /** Short user-readable reason when status === "error". */
  error: string | null;
}

/** Word-level highlight within the current sentence (Edge boundaries). */
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
  rate: 1,
  volume: 1,
  error: null,
});

export const activeWord = new Store<ActiveWord | null>(null);

export const sleepState = new Store<SleepState>({ until: null, endOfChapter: false });

/* Implementation lands with the provider layer. */

export const engine = {
  /** Bind an item's document for playback (does not start playing). */
  load(_itemId: string, _doc: ContentDoc, _startPos: Position): void {},
  /** Stop and release everything (does NOT clear saved positions). */
  unload(): void {},
  play(): Promise<void> {
    return Promise.resolve();
  },
  pause(): void {},
  toggle(): void {},
  stop(): void {},
  seekTo(_pos: Position): void {},
  nextSentence(): void {},
  prevSentence(): void {},
  nextParagraph(): void {},
  prevParagraph(): void {},
  nextChapter(): void {},
  prevChapter(): void {},
  setRate(_rate: number): void {},
  setVolume(_volume: number): void {},
  startSleepTimer(_minutesOrChapter: number | "chapter"): void {},
  cancelSleepTimer(): void {},
};
