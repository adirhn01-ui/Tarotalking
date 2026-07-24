// Pure-helper coverage for the export dialog's chapter selection: range
// clamping, the three selection modes, the display-only list filter, and the
// word share behind the size estimate. The dialog renders from these — nothing
// here needs a DOM.

import { describe, expect, it } from "vitest";
import {
  chapterMatchesFilter,
  resolveRange,
  resolveSelection,
  selectionWordCount,
  type ChapterSelection,
} from "./export-dialog";

/** A big book, the case the UI is designed around. */
const BOOK = 2200;
const everyChapter = Array.from({ length: BOOK }, (_, i) => i + 1);

function selection(over: Partial<ChapterSelection>): ChapterSelection {
  return { mode: "all", from: 1, to: BOOK, chosen: new Set<number>(), ...over };
}

describe("resolveRange", () => {
  it("clamps both bounds into 1..total", () => {
    expect(resolveRange(0, 99_999, BOOK)).toEqual({ from: 1, to: BOOK });
    expect(resolveRange(-40, 600, BOOK)).toEqual({ from: 1, to: 600 });
    expect(resolveRange(450, 5_000, BOOK)).toEqual({ from: 450, to: BOOK });
  });

  it("swaps reversed bounds instead of erroring", () => {
    expect(resolveRange(600, 450, BOOK)).toEqual({ from: 450, to: 600 });
    expect(resolveRange(BOOK, 1, BOOK)).toEqual({ from: 1, to: BOOK });
  });

  it("falls back to each end of the book for unusable input", () => {
    expect(resolveRange(NaN, NaN, BOOK)).toEqual({ from: 1, to: BOOK });
    expect(resolveRange(NaN, 12, BOOK)).toEqual({ from: 1, to: 12 });
    expect(resolveRange(12, NaN, BOOK)).toEqual({ from: 12, to: BOOK });
  });

  it("rounds fractional input and survives a one-chapter book", () => {
    expect(resolveRange(2.4, 5.6, BOOK)).toEqual({ from: 2, to: 6 });
    expect(resolveRange(9, 9, 1)).toEqual({ from: 1, to: 1 });
  });
});

describe("resolveSelection", () => {
  it("returns every exportable chapter in 'all' mode", () => {
    const out = resolveSelection(selection({ mode: "all" }), everyChapter, BOOK);
    expect(out).toHaveLength(BOOK);
    expect(out[0]).toBe(1);
    expect(out[out.length - 1]).toBe(BOOK);
  });

  it("returns an inclusive range with the book's own numbers", () => {
    const out = resolveSelection(
      selection({ mode: "range", from: 450, to: 600 }),
      everyChapter,
      BOOK,
    );
    expect(out).toHaveLength(151);
    expect(out[0]).toBe(450);
    expect(out[150]).toBe(600);
  });

  it("handles a single-chapter range and a reversed one", () => {
    expect(resolveSelection(selection({ mode: "range", from: 7, to: 7 }), everyChapter, BOOK)).toEqual([7]);
    expect(
      resolveSelection(selection({ mode: "range", from: 12, to: 9 }), everyChapter, BOOK),
    ).toEqual([9, 10, 11, 12]);
  });

  it("never offers a chapter that holds no text", () => {
    // Chapters 2 and 4 have nothing to export, so they are not available.
    const available = [1, 3, 5];
    expect(resolveSelection(selection({ mode: "all" }), available, 5)).toEqual([1, 3, 5]);
    expect(resolveSelection(selection({ mode: "range", from: 2, to: 4 }), available, 5)).toEqual([3]);
    expect(
      resolveSelection(selection({ mode: "choose", chosen: new Set([2, 4]) }), available, 5),
    ).toEqual([]);
  });

  it("sorts a chosen set into reading order and drops unknown numbers", () => {
    const chosen = new Set([600, 3, 451, 450, 3]);
    const out = resolveSelection(selection({ mode: "choose", chosen }), everyChapter, BOOK);
    expect(out).toEqual([3, 450, 451, 600]);

    const stray = new Set([0, 1, BOOK + 5]);
    expect(resolveSelection(selection({ mode: "choose", chosen: stray }), everyChapter, BOOK)).toEqual([1]);
  });

  it("resolves an empty selection to nothing (the Export button's cue)", () => {
    expect(resolveSelection(selection({ mode: "choose" }), everyChapter, BOOK)).toEqual([]);
    expect(resolveSelection(selection({ mode: "all" }), [], BOOK)).toEqual([]);
  });
});

describe("chapterMatchesFilter", () => {
  it("shows everything for an empty or blank query", () => {
    expect(chapterMatchesFilter(450, "the gate", "")).toBe(true);
    expect(chapterMatchesFilter(450, "the gate", "   ")).toBe(true);
  });

  it("matches the chapter number or anywhere in the title", () => {
    expect(chapterMatchesFilter(450, "the gate", "45")).toBe(true);
    expect(chapterMatchesFilter(450, "the gate", "gate")).toBe(true);
    expect(chapterMatchesFilter(450, "the gate", "GATE")).toBe(true);
    expect(chapterMatchesFilter(450, "the gate", "  gate  ")).toBe(true);
    expect(chapterMatchesFilter(450, "the gate", "road")).toBe(false);
    expect(chapterMatchesFilter(450, "the gate", "451")).toBe(false);
  });

  it("only decides what is displayed — it never changes the selection", () => {
    const chosen = new Set([3, 450, 451]);
    const sel = selection({ mode: "choose", chosen });
    const before = resolveSelection(sel, everyChapter, BOOK);

    // Narrow the list right down, exactly as typing in the filter would.
    const shown = everyChapter.filter((n) => chapterMatchesFilter(n, `chapter ${n}`, "1999"));
    expect(shown).toEqual([1999]);

    expect([...chosen]).toEqual([3, 450, 451]);
    expect(resolveSelection(sel, everyChapter, BOOK)).toEqual(before);
    expect(before).toEqual([3, 450, 451]);
  });
});

describe("selectionWordCount", () => {
  it("splits the book's words by the selected chapters' share of its text", () => {
    expect(selectionWordCount(10_000, 5_000, 10_000)).toBe(5_000);
    expect(selectionWordCount(10_000, 2_500, 10_000)).toBe(2_500);
    expect(selectionWordCount(10_000, 10_000, 10_000)).toBe(10_000);
  });

  it("never reports more than the whole book", () => {
    expect(selectionWordCount(10_000, 12_000, 10_000)).toBe(10_000);
  });

  it("returns 0 when there is nothing to weigh", () => {
    expect(selectionWordCount(0, 500, 10_000)).toBe(0);
    expect(selectionWordCount(10_000, 0, 10_000)).toBe(0);
    expect(selectionWordCount(10_000, 500, 0)).toBe(0);
  });

  it("rounds to whole words", () => {
    expect(Number.isInteger(selectionWordCount(1_001, 333, 1_000))).toBe(true);
  });
});
