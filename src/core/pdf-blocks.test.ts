import { describe, expect, it } from "vitest";
import {
  chunkPageRanges,
  groupLines,
  medianItemHeight,
  medianLineGap,
  outlineRanges,
  pageToBlocks,
  paragraphsToBlocks,
  splitParagraphs,
  type PdfItem,
  type PdfLine,
  type PdfParagraph,
} from "./pdf-blocks";

describe("groupLines", () => {
  it("groups items within the y tolerance and orders them left→right", () => {
    const items: PdfItem[] = [
      { str: "World", x: 50, y: 100, height: 12 },
      { str: "Hello", x: 10, y: 100.5, height: 12 }, // same line (Δy 0.5), smaller x
      { str: "line two", x: 10, y: 80, height: 12 }, // Δy 20 → next line
    ];
    const lines = groupLines(items);
    expect(lines.map((l) => l.text)).toEqual(["Hello World", "line two"]);
  });

  it("orders lines top→bottom regardless of input order", () => {
    const items: PdfItem[] = [
      { str: "bottom", x: 0, y: 10, height: 12 },
      { str: "top", x: 0, y: 90, height: 12 },
      { str: "middle", x: 0, y: 50, height: 12 },
    ];
    expect(groupLines(items).map((l) => l.text)).toEqual(["top", "middle", "bottom"]);
  });

  it("collapses interior whitespace and drops blank items", () => {
    const items: PdfItem[] = [
      { str: "Hello", x: 0, y: 100, height: 12 },
      { str: "   ", x: 20, y: 100, height: 12 }, // blank → dropped
      { str: "there", x: 40, y: 100, height: 12 },
    ];
    const lines = groupLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("Hello there");
  });

  it("reports the tallest item height on the line", () => {
    const items: PdfItem[] = [
      { str: "small", x: 0, y: 100, height: 12 },
      { str: "BIG", x: 40, y: 100, height: 22 },
    ];
    expect(groupLines(items)[0]!.maxHeight).toBe(22);
  });
});

describe("medianItemHeight", () => {
  it("takes the median over visible items, ignoring blanks and zero-height", () => {
    const items: PdfItem[] = [
      { str: "a", x: 0, y: 0, height: 12 },
      { str: "b", x: 0, y: 0, height: 12 },
      { str: "c", x: 0, y: 0, height: 20 },
      { str: " ", x: 0, y: 0, height: 99 }, // blank → ignored
      { str: "d", x: 0, y: 0, height: 0 }, // zero → ignored
    ];
    expect(medianItemHeight(items)).toBe(12);
  });

  it("returns 0 for no usable items", () => {
    expect(medianItemHeight([])).toBe(0);
  });
});

describe("medianLineGap", () => {
  it("computes the median gap between consecutive lines", () => {
    const lines: PdfLine[] = [
      { text: "a", y: 100, maxHeight: 12 },
      { text: "b", y: 88, maxHeight: 12 },
      { text: "c", y: 76, maxHeight: 12 },
      { text: "d", y: 40, maxHeight: 12 }, // gaps 12,12,36 → median 12
    ];
    expect(medianLineGap(lines)).toBe(12);
  });
});

describe("splitParagraphs", () => {
  it("breaks a paragraph on a gap wider than 1.6× the median", () => {
    const lines: PdfLine[] = [
      { text: "a", y: 100, maxHeight: 12 },
      { text: "b", y: 88, maxHeight: 12 }, // gap 12 → append
      { text: "c", y: 76, maxHeight: 12 }, // gap 12 → append
      { text: "d", y: 40, maxHeight: 12 }, // gap 36 > 19.2 → new paragraph
    ];
    const paras = splitParagraphs(lines);
    expect(paras.map((p) => p.text)).toEqual(["a b c", "d"]);
    expect(paras[0]!.lineCount).toBe(3);
    expect(paras[1]!.lineCount).toBe(1);
  });

  it("repairs hyphenation when a continuation starts lowercase", () => {
    const lines: PdfLine[] = [
      { text: "exam-", y: 100, maxHeight: 12 },
      { text: "ple text", y: 88, maxHeight: 12 },
    ];
    expect(splitParagraphs(lines).map((p) => p.text)).toEqual(["example text"]);
  });

  it("keeps a trailing hyphen when the next line starts uppercase", () => {
    const lines: PdfLine[] = [
      { text: "well-", y: 100, maxHeight: 12 },
      { text: "Known name", y: 88, maxHeight: 12 },
    ];
    expect(splitParagraphs(lines).map((p) => p.text)).toEqual(["well- Known name"]);
  });

  it("keeps everything in one paragraph when gaps are uniform", () => {
    const lines: PdfLine[] = [
      { text: "one", y: 100, maxHeight: 12 },
      { text: "two", y: 88, maxHeight: 12 },
      { text: "three", y: 76, maxHeight: 12 },
    ];
    expect(splitParagraphs(lines)).toHaveLength(1);
  });

  it("returns nothing for no lines", () => {
    expect(splitParagraphs([])).toEqual([]);
  });
});

describe("paragraphsToBlocks", () => {
  it("marks a short, tall, single-line paragraph as an h2", () => {
    const paras: PdfParagraph[] = [
      { text: "Chapter One", maxHeight: 20, lineCount: 1 }, // 20 ≥ 12×1.35 → h2
      { text: "Body paragraph here", maxHeight: 12, lineCount: 1 }, // normal → p
    ];
    expect(paragraphsToBlocks(paras, 12)).toEqual([
      { t: "h2", text: "Chapter One" },
      { t: "p", text: "Body paragraph here" },
    ]);
  });

  it("does not treat a tall multi-line paragraph as a heading", () => {
    const paras: PdfParagraph[] = [{ text: "Tall but wrapped", maxHeight: 20, lineCount: 2 }];
    expect(paragraphsToBlocks(paras, 12)).toEqual([{ t: "p", text: "Tall but wrapped" }]);
  });

  it("does not treat a long single line as a heading", () => {
    const long = "x".repeat(90);
    const paras: PdfParagraph[] = [{ text: long, maxHeight: 20, lineCount: 1 }];
    expect(paragraphsToBlocks(paras, 12)).toEqual([{ t: "p", text: long }]);
  });
});

describe("pageToBlocks", () => {
  it("reconstructs a heading followed by a wrapped paragraph", () => {
    const items: PdfItem[] = [
      { str: "Title", x: 10, y: 200, height: 20 },
      { str: "body one", x: 10, y: 170, height: 12 }, // gap 30 > 19.2 → break from heading
      { str: "body two", x: 10, y: 158, height: 12 }, // gap 12 → append
      { str: "body three", x: 10, y: 146, height: 12 }, // gap 12 → append
    ];
    expect(pageToBlocks(items)).toEqual([
      { t: "h2", text: "Title" },
      { t: "p", text: "body one body two body three" },
    ]);
  });

  it("returns nothing for an empty page", () => {
    expect(pageToBlocks([])).toEqual([]);
  });
});

describe("outlineRanges", () => {
  it("builds ranges and a Front matter chapter before the first entry", () => {
    const targets = [
      { title: "Intro", pageIndex: 2 },
      { title: "Chapter 1", pageIndex: 5 },
    ];
    expect(outlineRanges(targets, 10)).toEqual([
      { title: "Front matter", start: 0, end: 1 },
      { title: "Intro", start: 2, end: 4 },
      { title: "Chapter 1", start: 5, end: 9 },
    ]);
  });

  it("omits Front matter when the first entry is page 0", () => {
    const targets = [
      { title: "A", pageIndex: 0 },
      { title: "B", pageIndex: 3 },
    ];
    expect(outlineRanges(targets, 6)).toEqual([
      { title: "A", start: 0, end: 2 },
      { title: "B", start: 3, end: 5 },
    ]);
  });

  it("de-duplicates entries on the same page, keeping the first title", () => {
    const targets = [
      { title: "A", pageIndex: 0 },
      { title: "B", pageIndex: 0 },
      { title: "C", pageIndex: 3 },
    ];
    expect(outlineRanges(targets, 6)).toEqual([
      { title: "A", start: 0, end: 2 },
      { title: "C", start: 3, end: 5 },
    ]);
  });

  it("sorts unsorted targets by page before building ranges", () => {
    const targets = [
      { title: "Two", pageIndex: 4 },
      { title: "One", pageIndex: 1 },
    ];
    expect(outlineRanges(targets, 8)).toEqual([
      { title: "Front matter", start: 0, end: 0 },
      { title: "One", start: 1, end: 3 },
      { title: "Two", start: 4, end: 7 },
    ]);
  });

  it("drops out-of-range and blank-title targets", () => {
    const targets = [
      { title: "", pageIndex: 1 },
      { title: "Way out", pageIndex: 20 },
    ];
    expect(outlineRanges(targets, 10)).toEqual([]);
  });

  it("normalizes whitespace in titles", () => {
    expect(outlineRanges([{ title: "  My   Chapter ", pageIndex: 0 }], 4)).toEqual([
      { title: "My Chapter", start: 0, end: 3 },
    ]);
  });
});

describe("chunkPageRanges", () => {
  it("chunks pages into 20-page ranges with a partial final range", () => {
    expect(chunkPageRanges(45)).toEqual([
      { title: "Pages 1–20", start: 0, end: 19 },
      { title: "Pages 21–40", start: 20, end: 39 },
      { title: "Pages 41–45", start: 40, end: 44 },
    ]);
  });

  it("produces one range for a short document", () => {
    expect(chunkPageRanges(10)).toEqual([{ title: "Pages 1–10", start: 0, end: 9 }]);
  });

  it("returns nothing for zero pages", () => {
    expect(chunkPageRanges(0)).toEqual([]);
  });
});
