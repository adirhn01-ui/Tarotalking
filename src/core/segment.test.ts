import { describe, expect, it } from "vitest";
import { countWords, normalizeWhitespace, splitSentences } from "./segment";

describe("splitSentences", () => {
  it("splits simple sentences with exact offsets", () => {
    const text = "Hello world. How are you? Fine!";
    const s = splitSentences(text);
    expect(s.map((x) => x.text)).toEqual(["Hello world.", "How are you?", "Fine!"]);
    for (const span of s) {
      expect(text.slice(span.start, span.end)).toBe(span.text);
    }
  });

  it("keeps common abbreviations inside one sentence", () => {
    const s = splitSentences("Mr. Smith went to Washington. He came back.");
    expect(s.length).toBe(2);
    expect(s[0]!.text).toContain("Mr. Smith");
  });

  it("handles empty and whitespace-only input", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   \n\t ")).toEqual([]);
  });

  it("trims whitespace but maps offsets to the original string", () => {
    const text = "  First.   Second.  ";
    const s = splitSentences(text);
    expect(s.map((x) => x.text)).toEqual(["First.", "Second."]);
    expect(text.slice(s[0]!.start, s[0]!.end)).toBe("First.");
    expect(text.slice(s[1]!.start, s[1]!.end)).toBe("Second.");
  });

  it("treats a quote-heavy passage sanely", () => {
    const s = splitSentences('"Stop," she said. "Please stay."');
    expect(s.length).toBeGreaterThanOrEqual(1);
    expect(s.map((x) => x.text).join(" ")).toContain("she said");
  });
});

describe("countWords", () => {
  it("counts words, ignoring punctuation", () => {
    expect(countWords("Hello, world — again!")).toBe(3);
  });
  it("returns 0 for empty text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("…")).toBe(0);
  });
  it("counts numbers as words", () => {
    expect(countWords("Chapter 12 begins")).toBe(3);
  });
});

describe("normalizeWhitespace", () => {
  it("collapses runs and trims", () => {
    expect(normalizeWhitespace("  a\n\n b\tc  ")).toBe("a b c");
  });
});
