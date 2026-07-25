// The audiobook player's position arithmetic, tested as pure functions:
// no DOM, no audio element, no timers. These are the rules that decide where
// a book resumes and where a skip or a seek lands.

import { describe, expect, it } from "vitest";
import { DEFAULT_AUDIO_SKIP } from "../core/session";
import {
  clampSkip,
  formatClock,
  fromElapsed,
  missingFileMessage,
  resumePosition,
  safeDuration,
  sanitizeSkipSeconds,
  toElapsed,
  totalDuration,
  trackOffsets,
} from "./audiobook";
import type { AudioTrack } from "../core/types";

const track = (durationSec: number, title = "Track"): AudioTrack => ({
  path: `C:\\Books\\${title}.mp3`,
  title,
  durationSec,
});

/** Three tracks: 0-10, 10-30, 30-60 seconds of the book. */
const book: AudioTrack[] = [track(10, "One"), track(20, "Two"), track(30, "Three")];

describe("trackOffsets", () => {
  it("starts at zero and appends the book total", () => {
    expect(trackOffsets(book)).toEqual([0, 10, 30, 60]);
    expect(totalDuration(book)).toBe(60);
  });

  it("is always one longer than the track list", () => {
    expect(trackOffsets([])).toEqual([0]);
    expect(trackOffsets([track(5)])).toEqual([0, 5]);
    expect(totalDuration([])).toBe(0);
  });

  it("treats unknown or nonsense durations as zero", () => {
    expect(trackOffsets([track(10), track(NaN), track(-4), track(5)])).toEqual([0, 10, 10, 10, 15]);
    expect(safeDuration(undefined)).toBe(0);
    expect(safeDuration(Infinity)).toBe(0);
    expect(safeDuration(0)).toBe(0);
    expect(safeDuration(12.5)).toBe(12.5);
  });
});

describe("toElapsed", () => {
  it("adds the offset to everything before the track", () => {
    expect(toElapsed(book, 0, 0)).toBe(0);
    expect(toElapsed(book, 0, 4)).toBe(4);
    expect(toElapsed(book, 1, 0)).toBe(10);
    expect(toElapsed(book, 1, 15)).toBe(25);
    expect(toElapsed(book, 2, 30)).toBe(60);
  });

  it("clamps an offset that runs past its track", () => {
    expect(toElapsed(book, 1, 999)).toBe(30);
    expect(toElapsed(book, 1, -5)).toBe(10);
    expect(toElapsed(book, 1, NaN)).toBe(10);
  });

  it("clamps a track index that no longer exists", () => {
    expect(toElapsed(book, 9, 0)).toBe(30);
    expect(toElapsed(book, -2, 3)).toBe(3);
    expect(toElapsed([], 0, 5)).toBe(0);
  });
});

describe("fromElapsed", () => {
  it("finds the track an elapsed second falls in", () => {
    expect(fromElapsed(book, 0)).toEqual({ trackIndex: 0, offsetSec: 0 });
    expect(fromElapsed(book, 4)).toEqual({ trackIndex: 0, offsetSec: 4 });
    expect(fromElapsed(book, 25)).toEqual({ trackIndex: 1, offsetSec: 15 });
    expect(fromElapsed(book, 59)).toEqual({ trackIndex: 2, offsetSec: 29 });
  });

  it("puts an exact boundary at the START of the next track", () => {
    expect(fromElapsed(book, 10)).toEqual({ trackIndex: 1, offsetSec: 0 });
    expect(fromElapsed(book, 30)).toEqual({ trackIndex: 2, offsetSec: 0 });
  });

  it("pins the end of the book to the end of the last track", () => {
    expect(fromElapsed(book, 60)).toEqual({ trackIndex: 2, offsetSec: 30 });
    expect(fromElapsed(book, 5_000)).toEqual({ trackIndex: 2, offsetSec: 30 });
  });

  it("floors nonsense and negative input at the start", () => {
    expect(fromElapsed(book, -12)).toEqual({ trackIndex: 0, offsetSec: 0 });
    expect(fromElapsed(book, NaN)).toEqual({ trackIndex: 0, offsetSec: 0 });
    expect(fromElapsed([], 42)).toEqual({ trackIndex: 0, offsetSec: 0 });
  });

  it("skips over zero-length tracks", () => {
    const gappy = [track(10), track(0), track(20)];
    expect(fromElapsed(gappy, 10)).toEqual({ trackIndex: 2, offsetSec: 0 });
    expect(fromElapsed(gappy, 15)).toEqual({ trackIndex: 2, offsetSec: 5 });
  });

  it("round-trips every interior position through toElapsed", () => {
    for (const [i, offset] of [
      [0, 0],
      [0, 9.5],
      [1, 0],
      [1, 7],
      [2, 0],
      [2, 29.75],
    ] as const) {
      expect(fromElapsed(book, toElapsed(book, i, offset))).toEqual({
        trackIndex: i,
        offsetSec: offset,
      });
    }
  });

  it("round-trips a track's own end onto the next track's start", () => {
    // 10 seconds in is both "end of track 0" and "start of track 1"; the
    // start wins, which is what keeps a whole-book slider monotonic.
    expect(toElapsed(book, 0, 10)).toBe(10);
    expect(fromElapsed(book, 10)).toEqual({ trackIndex: 1, offsetSec: 0 });
    // …except at the very end of the book, where there is no next track.
    expect(fromElapsed(book, toElapsed(book, 2, 30))).toEqual({ trackIndex: 2, offsetSec: 30 });
  });
});

describe("clampSkip", () => {
  it("moves by the delta inside the track", () => {
    expect(clampSkip(30, 15, 100)).toBe(45);
    expect(clampSkip(30, -15, 100)).toBe(15);
  });

  it("stops at the start of the track", () => {
    expect(clampSkip(3, -5, 100)).toBe(0);
    expect(clampSkip(0, -30, 100)).toBe(0);
    expect(clampSkip(0, -0.1, 100)).toBe(0);
  });

  it("stops exactly on the end of the track", () => {
    expect(clampSkip(97, 5, 100)).toBe(100);
    expect(clampSkip(100, 30, 100)).toBe(100);
    expect(clampSkip(100, 0, 100)).toBe(100);
  });

  it("clamps only the low end while the duration is unknown", () => {
    expect(clampSkip(30, 15, 0)).toBe(45);
    expect(clampSkip(30, 15, NaN)).toBe(45);
    expect(clampSkip(3, -10, NaN)).toBe(0);
  });

  it("survives nonsense input", () => {
    expect(clampSkip(NaN, 10, 100)).toBe(10);
    expect(clampSkip(20, NaN, 100)).toBe(20);
    expect(clampSkip(NaN, NaN, 100)).toBe(0);
  });
});

describe("formatClock", () => {
  it("is m:ss under a minute", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7)).toBe("0:07");
    expect(formatClock(59)).toBe("0:59");
  });

  it("is m:ss under an hour", () => {
    expect(formatClock(60)).toBe("1:00");
    expect(formatClock(187)).toBe("3:07");
    expect(formatClock(3599)).toBe("59:59");
  });

  it("grows to h:mm:ss past an hour", () => {
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(3723)).toBe("1:02:03");
    expect(formatClock(36_000)).toBe("10:00:00");
  });

  it("reads a nonsense or negative duration as zero", () => {
    expect(formatClock(NaN)).toBe("0:00");
    expect(formatClock(Infinity)).toBe("0:00");
    expect(formatClock(-30)).toBe("0:00");
  });
});

describe("resumePosition", () => {
  it("resumes exactly where the book was left", () => {
    expect(resumePosition(book, { tracks: book, trackIndex: 1, offsetSec: 12, totalSec: 60 })).toEqual(
      { trackIndex: 1, offsetSec: 12 },
    );
  });

  it("starts at the beginning with nothing stored", () => {
    expect(resumePosition(book, undefined)).toEqual({ trackIndex: 0, offsetSec: 0 });
    expect(resumePosition([], { tracks: [], trackIndex: 4, offsetSec: 9, totalSec: 0 })).toEqual({
      trackIndex: 0,
      offsetSec: 0,
    });
  });

  it("clamps a stored point onto the tracks that still exist", () => {
    expect(resumePosition(book, { tracks: book, trackIndex: 9, offsetSec: 5, totalSec: 60 })).toEqual(
      { trackIndex: 2, offsetSec: 5 },
    );
    // An offset past the end of its track means that track was played out.
    expect(resumePosition(book, { tracks: book, trackIndex: 1, offsetSec: 500, totalSec: 60 })).toEqual(
      { trackIndex: 1, offsetSec: 0 },
    );
    expect(
      resumePosition(book, { tracks: book, trackIndex: NaN, offsetSec: NaN, totalSec: 60 }),
    ).toEqual({ trackIndex: 0, offsetSec: 0 });
  });

  it("restarts a track that was left sitting on its last frame", () => {
    expect(resumePosition(book, { tracks: book, trackIndex: 1, offsetSec: 20, totalSec: 60 })).toEqual(
      { trackIndex: 1, offsetSec: 0 },
    );
  });
});

describe("sanitizeSkipSeconds", () => {
  it("falls back to the configured default when nothing usable is stored", () => {
    expect(DEFAULT_AUDIO_SKIP).toBe(5);
    for (const raw of [undefined, null, "10", NaN, 0, -30, {}]) {
      expect(sanitizeSkipSeconds(raw)).toBe(DEFAULT_AUDIO_SKIP);
    }
  });

  it("takes a whole number of seconds inside a sane range", () => {
    expect(sanitizeSkipSeconds(15)).toBe(15);
    expect(sanitizeSkipSeconds(30.4)).toBe(30);
    expect(sanitizeSkipSeconds(9_000)).toBe(120);
  });
});

describe("missingFileMessage", () => {
  it("names the file that could not be played", () => {
    expect(missingFileMessage("C:\\Books\\Dune\\03 - Chapter.mp3")).toBe(
      "Can't play 03 - Chapter.mp3 — the file may have been moved, renamed, or deleted",
    );
  });

  it("stays readable when the path is gone too", () => {
    expect(missingFileMessage(undefined)).toContain("this audio file");
  });
});
