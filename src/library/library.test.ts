// Pure-helper coverage for the Library screen: the "prepare audio" (whole-book
// pre-synthesis) size estimate, and the export payload — which chapters the
// dialog can offer, and the numbering a partial export is written under.
// Importing ./library pulls the view module (and its transitive engine/provider
// graph) but exercises only the pure exports.

import { describe, expect, it } from "vitest";
import { buildChapterSummaries, buildExportChapters, prepareAudioBytes } from "./library";
import { resolveExportNumbering } from "../core/ipc";
import type { ContentDoc } from "../core/types";

describe("prepareAudioBytes", () => {
  // 1550 words at 155 wpm = 10 min = 600 s of speech.
  it("scales word count by the provider's bytes-per-second", () => {
    expect(prepareAudioBytes(1550, "edge", "high")).toBe(600 * 12_000);
    expect(prepareAudioBytes(1550, "edge", "standard")).toBe(600 * 6_000);
    expect(prepareAudioBytes(1550, "eleven", "high")).toBe(600 * 16_000);
  });

  it("returns 0 for empty or negative word counts", () => {
    expect(prepareAudioBytes(0, "edge", "high")).toBe(0);
    expect(prepareAudioBytes(-500, "edge", "high")).toBe(0);
  });

  it("rounds to whole bytes", () => {
    const n = prepareAudioBytes(1, "edge", "high");
    expect(Number.isInteger(n)).toBe(true);
  });
});

/** Five chapters, of which 1 (cover art) and 4 (whitespace) hold no text — the
 *  shape that makes "position in the book" differ from "position in the list". */
const doc: ContentDoc = {
  version: 1,
  title: "The Book",
  chapters: [
    { title: "Cover", blocks: [{ t: "img", src: "cover.png" }] },
    { title: "The Gate", blocks: [{ t: "p", text: "Alpha beta." }] },
    { title: "  ", blocks: [{ t: "p", text: "Gamma delta epsilon." }] },
    { title: "Blank", blocks: [{ t: "p", text: "   " }, { t: "hr" }] },
    { title: "The End", blocks: [{ t: "h2", text: "Zeta." }, { t: "p", text: "Eta theta." }] },
  ],
};

describe("buildChapterSummaries", () => {
  it("lists only chapters that hold text, keeping their place in the book", () => {
    expect(buildChapterSummaries(doc).map((c) => c.number)).toEqual([2, 3, 5]);
  });

  it("names an untitled chapter by its book number", () => {
    expect(buildChapterSummaries(doc).map((c) => c.title)).toEqual([
      "The Gate",
      "Chapter 3",
      "The End",
    ]);
  });

  it("weighs each chapter by its speakable text length", () => {
    const [gate, third, end] = buildChapterSummaries(doc);
    expect(gate!.chars).toBe("Alpha beta.".length);
    expect(third!.chars).toBe("Gamma delta epsilon.".length);
    expect(end!.chars).toBe("Zeta.".length + "Eta theta.".length);
  });

  it("returns nothing for a book with no readable text", () => {
    expect(buildChapterSummaries({ version: 1, title: "x", chapters: [] })).toEqual([]);
    expect(
      buildChapterSummaries({
        version: 1,
        title: "x",
        chapters: [{ title: "Only art", blocks: [{ t: "img", src: "a.png" }] }],
      }),
    ).toEqual([]);
  });
});

describe("buildExportChapters", () => {
  it("numbers each chapter by its position in the book, not in the export", () => {
    const out = buildExportChapters(doc, new Set([3, 5]));
    expect(out.map((c) => c.number)).toEqual([3, 5]);
    expect(out.map((c) => c.title)).toEqual(["Chapter 3", "The End"]);
    expect(out.every((c) => c.totalChapters === 5)).toBe(true);
  });

  it("exports one chapter under its own number", () => {
    const out = buildExportChapters(doc, new Set([5]));
    expect(out).toHaveLength(1);
    expect(out[0]!.number).toBe(5);
    expect(out[0]!.texts).toEqual(["Zeta.", "Eta theta."]);
  });

  it("drops selected chapters that have nothing to say", () => {
    expect(buildExportChapters(doc, new Set([1, 4]))).toEqual([]);
    expect(buildExportChapters(doc, new Set([1, 2, 4])).map((c) => c.number)).toEqual([2]);
  });

  it("exports nothing for an empty selection", () => {
    expect(buildExportChapters(doc, new Set())).toEqual([]);
  });
});

describe("resolveExportNumbering", () => {
  it("keeps the book's numbers and chapter count for a partial export", () => {
    const slice = [450, 451, 600].map((number) => ({
      title: `Chapter ${number}`,
      texts: ["Text."],
      number,
      totalChapters: 2200,
    }));
    const out = resolveExportNumbering(slice);
    expect(out.chapters.map((c) => c.number)).toEqual([450, 451, 600]);
    expect(out.totalChapters).toBe(2200);
  });

  it("prefers an explicit request total", () => {
    const chapters = [{ title: "a", texts: ["x"], number: 3 }];
    expect(resolveExportNumbering(chapters, 2200).totalChapters).toBe(2200);
  });

  it("falls back to array positions when the payload states no numbers", () => {
    const chapters = [
      { title: "a", texts: ["x"] },
      { title: "b", texts: ["y"] },
    ];
    const out = resolveExportNumbering(chapters);
    expect(out.chapters.map((c) => c.number)).toEqual([1, 2]);
    expect(out.totalChapters).toBe(2);
  });

  it("never reports a total below the chapters it is numbering", () => {
    const chapters = [{ title: "a", texts: ["x"], number: 900 }];
    expect(resolveExportNumbering(chapters, 12).totalChapters).toBe(900);
    expect(resolveExportNumbering([], 0).totalChapters).toBe(1);
  });
});
