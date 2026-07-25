import { describe, expect, it } from "vitest";
import {
  audiobookFallbackTitle,
  buildAudiobookItem,
  chunkTextToBlocks,
  countDocWords,
  groupImportPaths,
  normalizeUrl,
  pasteTitle,
  resolveZipImagePath,
  stripMarkdownInline,
} from "./import";
import type { AudiobookImportResult } from "./ipc";
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

describe("groupImportPaths", () => {
  it("groups audio files that share a parent folder into one audiobook", () => {
    const units = groupImportPaths([
      "D:\\Books\\Dune\\02.mp3",
      "D:\\Books\\Dune\\10.mp3",
      "D:\\Books\\Dune\\01.mp3",
    ]);
    expect(units).toEqual([
      {
        kind: "audiobook",
        paths: ["D:\\Books\\Dune\\01.mp3", "D:\\Books\\Dune\\02.mp3", "D:\\Books\\Dune\\10.mp3"],
      },
    ]);
  });

  it("keeps audio from different folders apart", () => {
    const units = groupImportPaths(["D:\\A\\1.mp3", "D:\\B\\1.mp3", "D:\\A\\2.mp3"]);
    expect(units).toEqual([
      { kind: "audiobook", paths: ["D:\\A\\1.mp3", "D:\\A\\2.mp3"] },
      { kind: "audiobook", paths: ["D:\\B\\1.mp3"] },
    ]);
  });

  it("treats each .m4b as its own book even inside one folder", () => {
    expect(groupImportPaths(["D:\\A\\one.m4b", "D:\\A\\two.m4b"])).toEqual([
      { kind: "audiobook", paths: ["D:\\A\\one.m4b"] },
      { kind: "audiobook", paths: ["D:\\A\\two.m4b"] },
    ]);
  });

  it("imports a single audio file as a one-track audiobook", () => {
    expect(groupImportPaths(["D:\\A\\solo.mp3"])).toEqual([
      { kind: "audiobook", paths: ["D:\\A\\solo.mp3"] },
    ]);
  });

  it("passes non-audio files through individually, in the order given", () => {
    expect(groupImportPaths(["a.epub", "b.pdf", "c.txt", "d.md"])).toEqual([
      { kind: "file", path: "a.epub" },
      { kind: "file", path: "b.pdf" },
      { kind: "file", path: "c.txt" },
      { kind: "file", path: "d.md" },
    ]);
  });

  it("handles a mixed drop: audio grouped, the rest untouched", () => {
    const units = groupImportPaths([
      "D:\\A\\1.mp3",
      "D:\\A\\book.epub",
      "D:\\A\\2.mp3",
      "D:\\A\\notes.txt",
    ]);
    expect(units).toEqual([
      { kind: "audiobook", paths: ["D:\\A\\1.mp3", "D:\\A\\2.mp3"] },
      { kind: "file", path: "D:\\A\\book.epub" },
      { kind: "file", path: "D:\\A\\notes.txt" },
    ]);
  });

  it("is case-insensitive about folders and extensions", () => {
    expect(groupImportPaths(["D:\\A\\1.MP3", "d:\\a\\2.Mp3"])).toEqual([
      { kind: "audiobook", paths: ["D:\\A\\1.MP3", "d:\\a\\2.Mp3"] },
    ]);
  });

  it("returns nothing for an empty selection", () => {
    expect(groupImportPaths([])).toEqual([]);
  });
});

describe("audiobookFallbackTitle", () => {
  it("uses the file name for a single file", () => {
    expect(audiobookFallbackTitle(["D:\\Books\\Dune\\Dune.m4b"])).toBe("Dune");
  });
  it("uses the folder name for a multi-file book", () => {
    expect(audiobookFallbackTitle(["D:\\Books\\Dune\\01.mp3", "D:\\Books\\Dune\\02.mp3"])).toBe(
      "Dune",
    );
  });
  it("survives a path with no folder and an empty selection", () => {
    expect(audiobookFallbackTitle(["solo.mp3", "other.mp3"])).toBe("solo");
    expect(audiobookFallbackTitle([])).toBe("Audiobook");
  });
});

describe("buildAudiobookItem", () => {
  const res: AudiobookImportResult = {
    title: "  Dune  ",
    author: " Frank Herbert ",
    coverPath: "C:\\data\\items\\x\\cover.jpg",
    tracks: [
      { path: "D:\\A\\01.mp3", title: "Chapter one", durationSec: 600, trackNo: 1 },
      { path: "D:\\A\\02.mp3", title: "  ", durationSec: 900.5, trackNo: 2 },
    ],
  };

  it("builds a text-free item with an AudioState", () => {
    const item = buildAudiobookItem("id-1", ["D:\\A\\01.mp3", "D:\\A\\02.mp3"], res);
    expect(item.id).toBe("id-1");
    expect(item.sourceType).toBe("audiobook");
    expect(item.title).toBe("Dune");
    expect(item.author).toBe("Frank Herbert");
    expect(item.cover).toBe("C:\\data\\items\\x\\cover.jpg");
    expect(item.wordCount).toBe(0);
    expect(item.chapterCount).toBe(2);
    expect(item.progressPct).toBe(0);
    expect(item.audio).toEqual({
      tracks: [
        { path: "D:\\A\\01.mp3", title: "Chapter one", durationSec: 600 },
        // A blank tag falls back to the file name.
        { path: "D:\\A\\02.mp3", title: "02", durationSec: 900.5 },
      ],
      trackIndex: 0,
      offsetSec: 0,
      totalSec: 1500.5,
    });
  });

  it("falls back to the folder name and omits a missing author and cover", () => {
    const item = buildAudiobookItem("id-2", ["D:\\Books\\Dune\\01.mp3", "D:\\Books\\Dune\\02.mp3"], {
      ...res,
      title: "   ",
      author: null,
      coverPath: null,
    });
    expect(item.title).toBe("Dune");
    expect("author" in item).toBe(false);
    expect("cover" in item).toBe(false);
  });

  it("treats unusable durations as zero", () => {
    const item = buildAudiobookItem("id-3", ["D:\\A\\1.mp3"], {
      title: "T",
      author: null,
      coverPath: null,
      tracks: [
        { path: "D:\\A\\1.mp3", title: "a", durationSec: Number.NaN, trackNo: null },
        { path: "D:\\A\\2.mp3", title: "b", durationSec: -5, trackNo: null },
        { path: "D:\\A\\3.mp3", title: "c", durationSec: 30, trackNo: null },
      ],
    });
    expect(item.audio?.totalSec).toBe(30);
    expect(item.audio?.tracks.map((t) => t.durationSec)).toEqual([0, 0, 30]);
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
