// The decision rules behind rewind-on-resume and the sleep-timer fade, tested
// as pure functions (no DOM, no audio element, no timers).

import { describe, expect, it } from "vitest";
import {
  fadedVolume,
  REWIND_ONE_MS,
  REWIND_TWO_MS,
  rewindStepsForPause,
  rewindTarget,
  SLEEP_FADE_MS,
  sleepFadeGain,
} from "./engine";
import type { Position } from "../core/types";

describe("rewindStepsForPause", () => {
  it("resumes exactly where it stopped after a short pause", () => {
    expect(rewindStepsForPause(0)).toBe(0);
    expect(rewindStepsForPause(1_000)).toBe(0);
    expect(rewindStepsForPause(REWIND_ONE_MS - 1)).toBe(0);
  });

  it("steps back one sentence from 30 seconds", () => {
    expect(rewindStepsForPause(REWIND_ONE_MS)).toBe(1);
    expect(rewindStepsForPause(60_000)).toBe(1);
    expect(rewindStepsForPause(REWIND_TWO_MS - 1)).toBe(1);
  });

  it("steps back two sentences from ten minutes", () => {
    expect(rewindStepsForPause(REWIND_TWO_MS)).toBe(2);
    expect(rewindStepsForPause(8 * 60 * 60_000)).toBe(2);
  });

  it("never rewinds on a nonsense duration", () => {
    expect(rewindStepsForPause(-5_000)).toBe(0);
    expect(rewindStepsForPause(NaN)).toBe(0);
    expect(rewindStepsForPause(Infinity)).toBe(0);
  });

  it("uses the documented thresholds", () => {
    expect(REWIND_ONE_MS).toBe(30_000);
    expect(REWIND_TWO_MS).toBe(10 * 60_000);
  });
});

describe("rewindTarget", () => {
  /** Sentence-by-sentence walk back through one chapter of 5 sentences,
   *  with chapter 0 sitting before it. */
  function prev(p: Position): Position | null {
    if (p.sentence > 0) return { ...p, sentence: p.sentence - 1 };
    if (p.chapter === 0) return null; // start of the document
    return { chapter: p.chapter - 1, block: 0, sentence: 4 };
  }

  const at = (chapter: number, sentence: number): Position => ({ chapter, block: 0, sentence });

  it("stays put when no step is due", () => {
    expect(rewindTarget(at(1, 3), 0, prev)).toEqual(at(1, 3));
  });

  it("steps back one and two sentences", () => {
    expect(rewindTarget(at(1, 3), 1, prev)).toEqual(at(1, 2));
    expect(rewindTarget(at(1, 3), 2, prev)).toEqual(at(1, 1));
  });

  it("clamps at the chapter's first sentence rather than crossing back", () => {
    expect(rewindTarget(at(1, 0), 1, prev)).toEqual(at(1, 0));
    expect(rewindTarget(at(1, 0), 2, prev)).toEqual(at(1, 0));
    // One step available inside the chapter, the second would cross.
    expect(rewindTarget(at(1, 1), 2, prev)).toEqual(at(1, 0));
  });

  it("clamps at the start of the document", () => {
    expect(rewindTarget(at(0, 0), 2, prev)).toEqual(at(0, 0));
    expect(rewindTarget(at(0, 1), 2, prev)).toEqual(at(0, 0));
  });

  it("keeps the block a step lands in", () => {
    const acrossBlocks = (p: Position): Position | null =>
      p.sentence > 0
        ? { ...p, sentence: p.sentence - 1 }
        : p.block > 0
          ? { chapter: p.chapter, block: p.block - 1, sentence: 2 }
          : null;
    expect(rewindTarget({ chapter: 2, block: 7, sentence: 0 }, 1, acrossBlocks)).toEqual({
      chapter: 2,
      block: 6,
      sentence: 2,
    });
  });
});

describe("sleepFadeGain", () => {
  it("is full volume when the ramp starts", () => {
    expect(sleepFadeGain(SLEEP_FADE_MS, SLEEP_FADE_MS)).toBe(1);
    expect(sleepFadeGain(60_000, SLEEP_FADE_MS)).toBe(1); // never above 1
  });

  it("ramps down linearly across the fade window", () => {
    expect(sleepFadeGain(7_500, 10_000)).toBeCloseTo(0.75, 6);
    expect(sleepFadeGain(5_000, 10_000)).toBeCloseTo(0.5, 6);
    expect(sleepFadeGain(1_000, 10_000)).toBeCloseTo(0.1, 6);
  });

  it("is silent at (and past) the deadline", () => {
    expect(sleepFadeGain(0, SLEEP_FADE_MS)).toBe(0);
    expect(sleepFadeGain(-250, SLEEP_FADE_MS)).toBe(0);
  });

  it("degrades to no fade on a nonsense window", () => {
    expect(sleepFadeGain(NaN, SLEEP_FADE_MS)).toBe(1);
    expect(sleepFadeGain(5_000, 0)).toBe(1);
    expect(sleepFadeGain(5_000, -1)).toBe(1);
  });

  it("fades over the documented ten seconds", () => {
    expect(SLEEP_FADE_MS).toBe(10_000);
  });
});

describe("fadedVolume", () => {
  it("restores the user's volume exactly at gain 1", () => {
    for (const v of [0, 0.05, 0.4, 0.85, 1]) {
      expect(fadedVolume(v, 1)).toBe(v);
    }
  });

  it("scales the user's volume by the gain", () => {
    expect(fadedVolume(0.8, 0.5)).toBeCloseTo(0.4, 6);
    expect(fadedVolume(1, 0.25)).toBeCloseTo(0.25, 6);
    expect(fadedVolume(0.6, 0)).toBe(0);
  });

  it("stays inside the element's 0..1 range", () => {
    expect(fadedVolume(1, 2)).toBe(1);
    expect(fadedVolume(0.5, -1)).toBe(0);
    expect(fadedVolume(NaN, 1)).toBe(0);
  });
});
