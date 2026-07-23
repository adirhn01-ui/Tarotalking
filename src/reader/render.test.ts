import { describe, expect, it } from "vitest";
import type { ContentDoc } from "../core/types";
import {
  blockTag,
  buildCharIndex,
  chapterWordCounts,
  pctForPosition,
  sentenceIndexForOffset,
  splitWordParts,
  topmostBlockIndex,
  widthBucketLabel,
} from "./render";

const doc: ContentDoc = {
  version: 1,
  title: "Test",
  chapters: [
    {
      title: "One",
      blocks: [
        { t: "h1", text: "Chapter One" }, // 11 + 1 = 12
        { t: "p", text: "Hello world." }, // 12 + 1 = 13
        { t: "img", src: "/x.png" }, // 0
        { t: "hr" }, // 0
        { t: "p", text: "   " }, // whitespace-only -> 0
      ],
    },
    {
      title: "Two",
      blocks: [
        { t: "p", text: "Second chapter here." }, // 20 + 1 = 21
      ],
    },
  ],
};

describe("buildCharIndex", () => {
  it("accumulates char offsets, skipping non-text blocks", () => {
    const idx = buildCharIndex(doc);
    expect(idx.chapterStart).toEqual([0, 25]); // 12 + 13 = 25
    expect(idx.blockStart[0]).toEqual([0, 12, 25, 25, 25]);
    expect(idx.blockStart[1]).toEqual([25]);
    expect(idx.total).toBe(46); // 25 + 21
  });

  it("never returns a zero total for an empty doc", () => {
    const idx = buildCharIndex({ version: 1, title: "", chapters: [] });
    expect(idx.total).toBe(1);
  });
});

describe("pctForPosition", () => {
  it("maps a position to overall document fraction", () => {
    const idx = buildCharIndex(doc);
    expect(pctForPosition(idx, { chapter: 0, block: 0, sentence: 0 })).toBe(0);
    expect(pctForPosition(idx, { chapter: 0, block: 1, sentence: 0 })).toBeCloseTo(12 / 46, 6);
    expect(pctForPosition(idx, { chapter: 1, block: 0, sentence: 0 })).toBeCloseTo(25 / 46, 6);
  });

  it("clamps out-of-range positions to 0..1", () => {
    const idx = buildCharIndex(doc);
    expect(pctForPosition(idx, { chapter: 99, block: 99, sentence: 0 })).toBe(0);
  });
});

describe("chapterWordCounts", () => {
  it("counts words per chapter", () => {
    expect(chapterWordCounts(doc)).toEqual([4, 3]); // "Chapter One"+"Hello world." ; "Second chapter here."
  });
});

describe("widthBucketLabel", () => {
  it("buckets by threshold", () => {
    expect(widthBucketLabel(480)).toBe("Narrow");
    expect(widthBucketLabel(560)).toBe("Narrow");
    expect(widthBucketLabel(561)).toBe("Medium");
    expect(widthBucketLabel(760)).toBe("Medium");
    expect(widthBucketLabel(800)).toBe("Wide");
    expect(widthBucketLabel(1040)).toBe("Wide");
  });
});

describe("topmostBlockIndex", () => {
  const offsets = [0, 100, 250, 480, 900];
  it("finds the last block at or above the scroll top", () => {
    expect(topmostBlockIndex(offsets, 0)).toBe(0);
    expect(topmostBlockIndex(offsets, 99)).toBe(0);
    expect(topmostBlockIndex(offsets, 100)).toBe(1);
    expect(topmostBlockIndex(offsets, 470)).toBe(2);
    expect(topmostBlockIndex(offsets, 480)).toBe(3);
    expect(topmostBlockIndex(offsets, 5000)).toBe(4);
  });
  it("handles the empty case", () => {
    expect(topmostBlockIndex([], 10)).toBe(-1);
  });
});

describe("splitWordParts", () => {
  it("splits around a word range", () => {
    expect(splitWordParts("Hello world.", 6, 5)).toEqual({
      before: "Hello ",
      word: "world",
      after: ".",
    });
  });
  it("clamps a range past the end", () => {
    expect(splitWordParts("Hi", 1, 40)).toEqual({ before: "H", word: "i", after: "" });
  });
  it("returns an empty word for a zero-length range", () => {
    expect(splitWordParts("Hi", 1, 0)).toEqual({ before: "H", word: "", after: "i" });
  });
});

describe("sentenceIndexForOffset", () => {
  // "Hello world. Second one." → span0 [0,12), span1 [13,24)
  const two = "Hello world. Second one.";

  it("resolves an offset inside a sentence to that sentence", () => {
    expect(sentenceIndexForOffset(two, 0)).toBe(0); // 'H'
    expect(sentenceIndexForOffset(two, 6)).toBe(0); // 'w'
    expect(sentenceIndexForOffset(two, 11)).toBe(0); // '.'
    expect(sentenceIndexForOffset(two, 13)).toBe(1); // 'S'
    expect(sentenceIndexForOffset(two, 23)).toBe(1); // final '.'
  });

  it("falls back to the nearest sentence when the offset lands in an inter-span gap", () => {
    // Multi-space gap: "One.   Two." → span0 [0,4), span1 [7,11)
    const gapped = "One.   Two.";
    expect(sentenceIndexForOffset(gapped, 4)).toBe(0); // closest to "One."
    expect(sentenceIndexForOffset(gapped, 6)).toBe(1); // closest to "Two."
    // Exact tie resolves to the earlier sentence.
    expect(sentenceIndexForOffset(gapped, 5)).toBe(0);
  });

  it("clamps out-of-range and leading-whitespace offsets to the nearest sentence", () => {
    expect(sentenceIndexForOffset(two, 999)).toBe(1); // past the end → last
    expect(sentenceIndexForOffset("  Hi there.", 0)).toBe(0); // leading gap → first
  });

  it("returns 0 for text with no sentences", () => {
    expect(sentenceIndexForOffset("", 0)).toBe(0);
    expect(sentenceIndexForOffset("   ", 1)).toBe(0);
  });
});

describe("blockTag", () => {
  it("maps block types to tags", () => {
    expect(blockTag("p")).toBe("p");
    expect(blockTag("h2")).toBe("h2");
    expect(blockTag("blockquote")).toBe("blockquote");
    expect(blockTag("li")).toBe("li");
    expect(blockTag("code")).toBe("pre");
  });
});
