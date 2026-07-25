// The library's now-playing bar reduces TWO independent players — the reading
// engine and the audiobook player — to one snapshot. That reduction is the part
// with rules worth pinning down: which player wins, what the second line says
// for each kind, and when the bar has no business being on screen at all.
// Importing ./mini-player pulls the view module (and its player graph) but
// exercises only the pure export — nothing here needs a DOM.

import { describe, expect, it } from "vitest";
import { nowPlaying, type AudiobookPlayback, type TtsPlayback } from "./mini-player";
import type { AudioTrack, LibraryItem, PlaybackStatus } from "../core/types";

function item(over: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: "book-1",
    title: "The Book",
    sourceType: "epub",
    addedAt: 0,
    favorite: false,
    collections: [],
    wordCount: 1000,
    chapterCount: 3,
    reading: { chapter: 0, block: 0, sentence: 0 },
    playback: { chapter: 0, block: 0, sentence: 0 },
    progressPct: 0,
    bookmarks: [],
    ...over,
  };
}

function tracks(...spec: [string, number][]): AudioTrack[] {
  return spec.map(([title, durationSec]) => ({ path: `C:/audio/${title}.mp3`, title, durationSec }));
}

function audiobookItem(over: Partial<LibraryItem> = {}): LibraryItem {
  const list = tracks(["Chapter one", 100], ["Chapter two", 300]);
  return item({
    id: "book-2",
    title: "The Audiobook",
    sourceType: "audiobook",
    audio: { tracks: list, trackIndex: 0, offsetSec: 0, totalSec: 400 },
    ...over,
  });
}

/** Nothing bound: the state both players sit in at rest. */
const IDLE_TTS: TtsPlayback = { status: "idle", itemId: null, pct: 0 };
const IDLE_BOOK: AudiobookPlayback = {
  status: "idle",
  itemId: null,
  trackIndex: 0,
  positionSec: 0,
  durationSec: 0,
};

function tts(over: Partial<TtsPlayback> = {}): TtsPlayback {
  return { status: "playing", itemId: "book-1", pct: 0.25, ...over };
}

function book(over: Partial<AudiobookPlayback> = {}): AudiobookPlayback {
  return { status: "playing", itemId: "book-2", trackIndex: 0, positionSec: 50, durationSec: 100, ...over };
}

/** Resolves only the two books the fixtures know about. */
function library(...items: LibraryItem[]): (id: string) => LibraryItem | undefined {
  return (id) => items.find((it) => it.id === id);
}

const lookupAll = library(item(), audiobookItem());

describe("nowPlaying — which player the bar shows", () => {
  it("shows the reading engine's book when only it is bound", () => {
    const np = nowPlaying(tts(), IDLE_BOOK, lookupAll);
    expect(np).toMatchObject({ kind: "tts", itemId: "book-1", title: "The Book", playing: true });
  });

  it("shows the audiobook when only it is bound", () => {
    const np = nowPlaying(IDLE_TTS, book(), lookupAll);
    expect(np).toMatchObject({ kind: "audiobook", itemId: "book-2", title: "The Audiobook" });
  });

  it("returns null when neither player holds a book", () => {
    expect(nowPlaying(IDLE_TTS, IDLE_BOOK, lookupAll)).toBeNull();
  });

  it("prefers the audiobook if both somehow report a bound book", () => {
    // The playback arbiter allows only one — the snapshot must still resolve.
    const np = nowPlaying(tts(), book(), lookupAll);
    expect(np?.kind).toBe("audiobook");
    expect(np?.itemId).toBe("book-2");
  });

  it("returns null when the bound item is gone from the library", () => {
    expect(nowPlaying(tts(), IDLE_BOOK, library(audiobookItem()))).toBeNull();
    expect(nowPlaying(IDLE_TTS, book(), library(item()))).toBeNull();
  });

  it("falls back to the reading engine when the audiobook's item is missing", () => {
    const np = nowPlaying(tts(), book(), library(item()));
    expect(np?.kind).toBe("tts");
  });

  it("hides for a player that is idle or errored, shows one that is paused", () => {
    const cases: [PlaybackStatus, boolean][] = [
      ["playing", true],
      ["loading", true],
      ["paused", true],
      ["idle", false],
      ["error", false],
    ];
    for (const [status, visible] of cases) {
      expect(nowPlaying(tts({ status }), IDLE_BOOK, lookupAll) !== null).toBe(visible);
      expect(nowPlaying(IDLE_TTS, book({ status }), lookupAll) !== null).toBe(visible);
    }
  });
});

describe("nowPlaying — the play/pause flag", () => {
  it("reads as playing while a player is still loading its audio", () => {
    expect(nowPlaying(tts({ status: "loading" }), IDLE_BOOK, lookupAll)?.playing).toBe(true);
    expect(nowPlaying(IDLE_TTS, book({ status: "loading" }), lookupAll)?.playing).toBe(true);
  });

  it("reads as not playing when paused", () => {
    expect(nowPlaying(tts({ status: "paused" }), IDLE_BOOK, lookupAll)?.playing).toBe(false);
    expect(nowPlaying(IDLE_TTS, book({ status: "paused" }), lookupAll)?.playing).toBe(false);
  });
});

describe("nowPlaying — the second line", () => {
  it("names the chapter being read aloud", () => {
    const lookup = library(item({ chapterLabel: "The Gate" }));
    expect(nowPlaying(tts(), IDLE_BOOK, lookup)?.sub).toBe("The Gate");
  });

  it("falls back to the status when a book has no chapter label", () => {
    const lookup = library(item({ chapterLabel: "   " }));
    expect(nowPlaying(tts({ status: "paused" }), IDLE_BOOK, lookup)?.sub).toBe("Paused");
    expect(nowPlaying(tts({ status: "loading" }), IDLE_BOOK, lookup)?.sub).toBe("Loading");
  });

  it("names the audiobook track being played", () => {
    expect(nowPlaying(IDLE_TTS, book({ trackIndex: 1 }), lookupAll)?.sub).toBe("Chapter two");
  });

  it("counts the tracks when they carry no titles of their own", () => {
    const list = tracks(["", 100], ["", 300], ["", 200]);
    const lookup = library(
      audiobookItem({ audio: { tracks: list, trackIndex: 0, offsetSec: 0, totalSec: 600 } }),
    );
    expect(nowPlaying(IDLE_TTS, book({ trackIndex: 2 }), lookup)?.sub).toBe("Track 3 of 3");
  });

  it("does not echo the book title back as a track title", () => {
    const list = tracks(["The Audiobook", 400]);
    const lookup = library(
      audiobookItem({ audio: { tracks: list, trackIndex: 0, offsetSec: 0, totalSec: 400 } }),
    );
    expect(nowPlaying(IDLE_TTS, book({ status: "paused" }), lookup)?.sub).toBe("Paused");
  });

  it("survives a track index that points past the files that exist", () => {
    const np = nowPlaying(IDLE_TTS, book({ trackIndex: 99 }), lookupAll);
    expect(np?.sub).toBe("Chapter two");
  });
});

describe("nowPlaying — the progress hairline", () => {
  it("passes the engine's whole-document progress through, clamped", () => {
    expect(nowPlaying(tts({ pct: 0.4 }), IDLE_BOOK, lookupAll)?.pct).toBe(0.4);
    expect(nowPlaying(tts({ pct: 2 }), IDLE_BOOK, lookupAll)?.pct).toBe(1);
    expect(nowPlaying(tts({ pct: Number.NaN }), IDLE_BOOK, lookupAll)?.pct).toBe(0);
  });

  it("measures an audiobook against the WHOLE book, not the current track", () => {
    // 50 s into a 100 s first track of a 400 s book.
    expect(nowPlaying(IDLE_TTS, book(), lookupAll)?.pct).toBeCloseTo(50 / 400, 6);
    // 150 s into the 300 s second track = 100 + 150 of 400.
    const np = nowPlaying(IDLE_TTS, book({ trackIndex: 1, positionSec: 150, durationSec: 300 }), lookupAll);
    expect(np?.pct).toBeCloseTo(250 / 400, 6);
  });

  it("falls back to progress within the track when no durations are known", () => {
    const list = tracks(["One", 0], ["Two", 0]);
    const lookup = library(
      audiobookItem({ audio: { tracks: list, trackIndex: 0, offsetSec: 0, totalSec: 0 } }),
    );
    const np = nowPlaying(IDLE_TTS, book({ positionSec: 30, durationSec: 120 }), lookup);
    expect(np?.pct).toBeCloseTo(0.25, 6);
  });

  it("reports zero rather than NaN for a book with nothing measurable", () => {
    const lookup = library(
      audiobookItem({ audio: { tracks: [], trackIndex: 0, offsetSec: 0, totalSec: 0 } }),
    );
    expect(nowPlaying(IDLE_TTS, book({ positionSec: 10, durationSec: 0 }), lookup)?.pct).toBe(0);
  });
});
