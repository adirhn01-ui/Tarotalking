import { describe, expect, it } from "vitest";
import { domToBlocks, orderedMarker, postProcessBlocks, trimBlankLines } from "./epub-blocks";
import type { Block } from "./types";

/* ---- a minimal DOM stand-in (tests run in the node env, no DOMParser) ---- */

interface Fake {
  tagName: string;
  children: Fake[];
  parentElement: Fake | null;
  _own: string;
  attrs: Record<string, string>;
  getAttribute(n: string): string | null;
  readonly textContent: string;
}

function mk(
  tag: string,
  opts: { text?: string; attrs?: Record<string, string>; children?: Fake[] } = {},
): Fake {
  const children = opts.children ?? [];
  const node: Fake = {
    tagName: tag.toUpperCase(),
    children,
    parentElement: null,
    _own: opts.text ?? "",
    attrs: opts.attrs ?? {},
    getAttribute(n: string): string | null {
      return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n]! : null;
    },
    get textContent(): string {
      let s = this._own;
      for (const c of this.children) s += c.textContent;
      return s;
    },
  };
  for (const c of children) c.parentElement = node;
  return node;
}

function asEl(f: Fake): Element {
  return f as unknown as Element;
}

describe("trimBlankLines", () => {
  it("strips leading and trailing blank lines but keeps interior ones", () => {
    expect(trimBlankLines("\n\n  code\n\n  more\n\n")).toBe("  code\n\n  more");
  });
  it("returns empty for all-blank input", () => {
    expect(trimBlankLines("\n  \n\t\n")).toBe("");
  });
});

describe("orderedMarker", () => {
  it("is 1-based by default", () => {
    expect(orderedMarker(0)).toBe("1.");
    expect(orderedMarker(2)).toBe("3.");
  });
  it("honors a list start offset", () => {
    expect(orderedMarker(0, 5)).toBe("5.");
    expect(orderedMarker(1, 5)).toBe("6.");
  });
});

describe("postProcessBlocks", () => {
  it("drops empty text blocks and images without a src", () => {
    const input: Block[] = [
      { t: "p", text: "  " },
      { t: "p", text: "keep" },
      { t: "img" },
      { t: "img", src: "a.png" },
    ];
    expect(postProcessBlocks(input)).toEqual([
      { t: "p", text: "keep" },
      { t: "img", src: "a.png" },
    ]);
  });
  it("trims leading/trailing rules and collapses consecutive ones", () => {
    const input: Block[] = [
      { t: "hr" },
      { t: "p", text: "a" },
      { t: "hr" },
      { t: "hr" },
      { t: "p", text: "b" },
      { t: "hr" },
    ];
    expect(postProcessBlocks(input)).toEqual([
      { t: "p", text: "a" },
      { t: "hr" },
      { t: "p", text: "b" },
    ]);
  });
});

describe("domToBlocks", () => {
  const resolve = (src: string): string | null =>
    src.startsWith("bad") ? null : `asset://${src}`;

  it("maps a representative document body to clean blocks", () => {
    const body = mk("body", {
      children: [
        mk("h1", { text: "Chapter One" }),
        mk("h4", { text: "A deep heading" }),
        mk("p", { text: "Hello world." }),
        mk("ul", { children: [mk("li", { text: "First" }), mk("li", { text: "Second" })] }),
        mk("ol", {
          attrs: { start: "3" },
          children: [mk("li", { text: "Third" }), mk("li", { text: "Fourth" })],
        }),
        mk("blockquote", { children: [mk("p", { text: "Quote line." })] }),
        mk("pre", { text: "\ncode line\n" }),
        mk("hr"),
        mk("img", { attrs: { src: "pic.png" } }),
        mk("figure", {
          children: [
            mk("img", { attrs: { src: "fig.png" } }),
            mk("figcaption", { text: "A caption" }),
          ],
        }),
        mk("table", {
          children: [
            mk("tbody", {
              children: [mk("tr", { children: [mk("td", { text: "A" }), mk("td", { text: "B" })] })],
            }),
          ],
        }),
        mk("div", { children: [mk("p", { text: "Nested para" })] }),
      ],
    });

    expect(domToBlocks(asEl(body), resolve)).toEqual([
      { t: "h1", text: "Chapter One" },
      { t: "h3", text: "A deep heading" },
      { t: "p", text: "Hello world." },
      { t: "li", text: "First" },
      { t: "li", text: "Second" },
      { t: "li", text: "Third", marker: "3." },
      { t: "li", text: "Fourth", marker: "4." },
      { t: "blockquote", text: "Quote line." },
      { t: "code", text: "code line" },
      { t: "hr" },
      { t: "img", src: "asset://pic.png" },
      { t: "img", src: "asset://fig.png" },
      { t: "p", text: "A caption" },
      { t: "p", text: "A — B" },
      { t: "p", text: "Nested para" },
    ]);
  });

  it("emits an image inside a paragraph as its own block after the paragraph", () => {
    const body = mk("body", {
      children: [mk("p", { text: "See this.", children: [mk("img", { attrs: { src: "in.png" } })] })],
    });
    expect(domToBlocks(asEl(body), resolve)).toEqual([
      { t: "p", text: "See this." },
      { t: "img", src: "asset://in.png" },
    ]);
  });

  it("drops images the resolver rejects", () => {
    const body = mk("body", { children: [mk("img", { attrs: { src: "bad.png" } })] });
    expect(domToBlocks(asEl(body), resolve)).toEqual([]);
  });
});
