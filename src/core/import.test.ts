import { describe, expect, it } from "vitest";
import {
  chunkTextToBlocks,
  countDocWords,
  normalizeUrl,
  pasteTitle,
  resolveZipImagePath,
  stripMarkdownInline,
} from "./import";
import type { Chapter } from "./types";

describe("stripMarkdownInline", () => {
  it("removes emphasis, code, and link syntax", () => {
    expect(stripMarkdownInline("A **bold** and *italic* and `code` and [link](http://x)")).toBe(
      "A bold and italic and code and link",
    );
  });
  it("leaves snake_case identifiers untouched", () => {
    expect(stripMarkdownInline("call foo_bar_baz now")).toBe("call foo_bar_baz now");
  });
});

describe("chunkTextToBlocks", () => {
  it("splits paragraphs on blank lines and collapses interior newlines", () => {
    expect(chunkTextToBlocks("Para one.\n\nline a\nline b", false)).toEqual([
      { t: "p", text: "Para one." },
      { t: "p", text: "line a line b" },
    ]);
  });
  it("recognizes headings and blockquotes in both modes", () => {
    expect(chunkTextToBlocks("# Title\n\n## Sub\n\n### Small\n\n> quoted\n> more\n\nBody", false)).toEqual([
      { t: "h1", text: "Title" },
      { t: "h2", text: "Sub" },
      { t: "h3", text: "Small" },
      { t: "blockquote", text: "quoted more" },
      { t: "p", text: "Body" },
    ]);
  });
  it("only strips inline markdown when markdown is true", () => {
    expect(chunkTextToBlocks("**bold** text", false)).toEqual([{ t: "p", text: "**bold** text" }]);
    expect(chunkTextToBlocks("**bold** text", true)).toEqual([{ t: "p", text: "bold text" }]);
  });
  it("collapses runs of blank lines", () => {
    expect(chunkTextToBlocks("a\n\n\n\nb", false)).toEqual([
      { t: "p", text: "a" },
      { t: "p", text: "b" },
    ]);
  });
});

describe("resolveZipImagePath", () => {
  it("resolves a chapter-relative path", () => {
    expect(resolveZipImagePath("OEBPS/text/ch1.xhtml", "img/a.png")).toBe("oebps/text/img/a.png");
  });
  it("normalizes parent segments", () => {
    expect(resolveZipImagePath("OEBPS/text/ch1.xhtml", "../images/pic.png")).toBe(
      "oebps/images/pic.png",
    );
  });
  it("treats a leading slash as zip-root relative", () => {
    expect(resolveZipImagePath("OEBPS/text/ch1.xhtml", "/cover.jpg")).toBe("cover.jpg");
  });
  it("decodes percent-encoding", () => {
    expect(resolveZipImagePath("OEBPS/ch.xhtml", "images/a%20b.png")).toBe("oebps/images/a b.png");
  });
  it("drops external and data URIs", () => {
    expect(resolveZipImagePath("ch.xhtml", "https://example.com/a.png")).toBeNull();
    expect(resolveZipImagePath("ch.xhtml", "data:image/png;base64,AAAA")).toBeNull();
  });
});

describe("normalizeUrl", () => {
  it("prepends https when no scheme is present", () => {
    expect(normalizeUrl("example.com/x")).toBe("https://example.com/x");
  });
  it("keeps an explicit scheme", () => {
    expect(normalizeUrl("http://a.test")).toBe("http://a.test");
    expect(normalizeUrl("  HTTPS://B.test  ")).toBe("HTTPS://B.test");
  });
});

describe("pasteTitle", () => {
  it("prefers an explicit title", () => {
    expect(pasteTitle("My Title", "body")).toBe("My Title");
  });
  it("falls back to the first non-empty line, capped at 60 chars", () => {
    expect(pasteTitle(null, "\n  First line \nSecond")).toBe("First line");
    expect(pasteTitle("  ", "x".repeat(80))).toBe("x".repeat(60));
  });
  it("uses a generic fallback for blank text", () => {
    expect(pasteTitle(null, "   \n\t ")).toBe("Pasted text");
  });
});

describe("countDocWords", () => {
  it("sums words across text-bearing blocks only", () => {
    const chapters: Chapter[] = [
      {
        title: "t",
        blocks: [
          { t: "p", text: "one two three" },
          { t: "h1", text: "heading" },
          { t: "hr" },
          { t: "img", src: "x" },
        ],
      },
    ];
    expect(countDocWords(chapters)).toBe(4);
  });
});
