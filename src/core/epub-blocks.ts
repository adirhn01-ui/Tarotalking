// XHTML/HTML Document → Block[] conversion, shared by the EPUB import path and
// the web-article extractor (readability.ts). The DOM is parsed inertly with
// DOMParser upstream (scripts never run); here we walk it and map each element
// to a typed Block per the ContentDoc model. Raw HTML never reaches the reader.
//
// Image `src` is resolved through a caller-supplied callback so this module
// stays free of Tauri/zip concerns: it returns the string to store on the img
// block, or null to drop the image.

import type { Block, BlockType } from "./types";
import { normalizeWhitespace } from "./segment";

/** Resolve an <img>/<image> source to a storable value, or null to drop it. */
export type ImgResolver = (src: string) => string | null;

const HEADING: Record<string, BlockType> = {
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h3",
  h5: "h3",
  h6: "h3",
};

// Elements that carry no readable content — never recurse into these.
const SKIP = new Set(["script", "style", "noscript", "template", "head", "title", "meta", "link"]);

function tagOf(el: Element): string {
  return el.tagName.toLowerCase();
}

/** Collect descendant elements (any depth) whose tag matches one of `tags`. */
function descendantsByTag(root: Element, ...tags: string[]): Element[] {
  const want = new Set(tags);
  const out: Element[] = [];
  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      if (want.has(tagOf(child))) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function imgSrc(img: Element): string | null {
  return img.getAttribute("src");
}

/** SVG <image> href (SVG2 `href` or legacy `xlink:href`). */
function svgImageHref(image: Element): string | null {
  return image.getAttribute("href") ?? image.getAttribute("xlink:href");
}

function pushImg(rawSrc: string | null, resolve: ImgResolver, out: Block[]): void {
  if (!rawSrc) return;
  const resolved = resolve(rawSrc);
  if (resolved) out.push({ t: "img", src: resolved });
}

/** Ordered-list marker for the item at `index` (0-based) given the list `start`. */
export function orderedMarker(index: number, start = 1): string {
  return `${start + index}.`;
}

/** Strip leading and trailing blank lines from a <pre> block while preserving
 *  interior indentation and line breaks. */
export function trimBlankLines(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end).join("\n");
}

/** Final tidy pass: drop empty blocks, collapse consecutive rules, and strip
 *  leading/trailing horizontal rules. Pure — safe to unit-test. */
export function postProcessBlocks(blocks: Block[]): Block[] {
  const kept = blocks.filter((b) => {
    if (b.t === "img") return !!b.src;
    if (b.t === "hr") return true;
    return !!(b.text && b.text.trim());
  });
  const out: Block[] = [];
  for (const b of kept) {
    if (b.t === "hr") {
      if (out.length === 0) continue; // no leading rule
      if (out[out.length - 1]!.t === "hr") continue; // no doubled rule
    }
    out.push(b);
  }
  while (out.length && out[out.length - 1]!.t === "hr") out.pop();
  return out;
}

function process(el: Element, resolve: ImgResolver, out: Block[]): void {
  const t = tagOf(el);
  if (SKIP.has(t)) return;

  switch (t) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = normalizeWhitespace(el.textContent ?? "");
      if (text) out.push({ t: HEADING[t]!, text });
      return;
    }
    case "p": {
      const text = normalizeWhitespace(el.textContent ?? "");
      if (text) out.push({ t: "p", text });
      // An image inside a paragraph becomes its own block AFTER the paragraph.
      for (const img of descendantsByTag(el, "img")) pushImg(imgSrc(img), resolve, out);
      for (const image of descendantsByTag(el, "image")) pushImg(svgImageHref(image), resolve, out);
      return;
    }
    case "blockquote": {
      const paras = descendantsByTag(el, "p");
      if (paras.length) {
        for (const p of paras) {
          const text = normalizeWhitespace(p.textContent ?? "");
          if (text) out.push({ t: "blockquote", text });
        }
      } else {
        const text = normalizeWhitespace(el.textContent ?? "");
        if (text) out.push({ t: "blockquote", text });
      }
      return;
    }
    case "li": {
      const text = normalizeWhitespace(el.textContent ?? "");
      if (!text) return;
      const parent = el.parentElement;
      let marker: string | undefined;
      if (parent && tagOf(parent) === "ol") {
        const lis = Array.from(parent.children).filter((c) => tagOf(c) === "li");
        const idx = lis.indexOf(el);
        const startAttr = Number.parseInt(parent.getAttribute("start") ?? "1", 10);
        const start = Number.isFinite(startAttr) ? startAttr : 1;
        marker = orderedMarker(idx < 0 ? 0 : idx, start);
      }
      out.push(marker ? { t: "li", text, marker } : { t: "li", text });
      return;
    }
    case "pre": {
      const text = trimBlankLines(el.textContent ?? "");
      if (text.trim()) out.push({ t: "code", text });
      return;
    }
    case "hr": {
      out.push({ t: "hr" });
      return;
    }
    case "img": {
      pushImg(imgSrc(el), resolve, out);
      return;
    }
    case "svg": {
      const image = descendantsByTag(el, "image")[0];
      if (image) pushImg(svgImageHref(image), resolve, out);
      return;
    }
    case "figure": {
      const img = descendantsByTag(el, "img")[0];
      if (img) {
        pushImg(imgSrc(img), resolve, out);
      } else {
        const image = descendantsByTag(el, "image")[0];
        if (image) pushImg(svgImageHref(image), resolve, out);
      }
      const cap = descendantsByTag(el, "figcaption")[0];
      if (cap) {
        const text = normalizeWhitespace(cap.textContent ?? "");
        if (text) out.push({ t: "p", text });
      }
      return;
    }
    case "table": {
      for (const row of descendantsByTag(el, "tr")) {
        const cells = Array.from(row.children).filter((c) => {
          const ct = tagOf(c);
          return ct === "td" || ct === "th";
        });
        const text = cells
          .map((c) => normalizeWhitespace(c.textContent ?? ""))
          .filter(Boolean)
          .join(" — ");
        if (text) out.push({ t: "p", text });
      }
      return;
    }
    default: {
      // div / section / article / main / span / ul / ol / etc. — recurse.
      for (const child of Array.from(el.children)) process(child, resolve, out);
      return;
    }
  }
}

/** Convert a parsed element subtree (typically a document body, or a
 *  readability "winner" element) into a clean Block[]. */
export function domToBlocks(root: Element, resolveImg: ImgResolver): Block[] {
  const out: Block[] = [];
  process(root, resolveImg, out);
  return postProcessBlocks(out);
}
