// Compact, dependency-free article extraction — a Readability-lite. Given an
// inertly-parsed HTML Document (from a fetched web page), find the element that
// holds the article body, then hand it to domToBlocks. Web images are dropped
// for v1 (the strict CSP blocks remote origins), so the resolver always returns
// null. Scoring + title helpers are pure and exported for unit tests.

import type { Block } from "./types";
import { domToBlocks } from "./epub-blocks";
import { normalizeWhitespace } from "./segment";

export interface ExtractedArticle {
  title: string;
  byline?: string;
  blocks: Block[];
}

// Chrome/boilerplate that never belongs to the article body.
const STRIP_SELECTOR =
  "script,style,noscript,template,iframe,form,nav,footer,header,aside," +
  "[hidden],[role=banner],[role=navigation],[role=complementary]";

const NEGATIVE =
  /(comment|share|social|sidebar|footer|promo|related|ad-|advert|sponsor|newsletter|subscribe|cookie|banner)/i;
const POSITIVE = /(article|content|main|post|entry|body|story|text)/i;

/** Content-density score for a leaf text node (p/pre/blockquote/li). */
export function scoreText(text: string): number {
  const t = text.trim();
  if (t.length < 25) return 0;
  const commas = (t.match(/,/g)?.length ?? 0) + 1;
  return 1 + commas + Math.min(Math.floor(t.length / 100), 3);
}

/** Class/id heuristic weight for a candidate container. */
export function classWeight(className: string, id: string): number {
  const s = `${className} ${id}`;
  let w = 0;
  if (NEGATIVE.test(s)) w -= 25;
  if (POSITIVE.test(s)) w += 25;
  return w;
}

/** Strip a trailing " | Site" / " - Site" / " — Site" suffix from a <title>,
 *  but only when the remaining headline is still substantial (≥ 15 chars). */
export function cleanTitle(raw: string): string {
  const t = normalizeWhitespace(raw);
  const sep = /\s[|–—-]\s/g;
  let lastIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = sep.exec(t)) !== null) lastIdx = m.index;
  if (lastIdx >= 0) {
    const head = t.slice(0, lastIdx).trim();
    if (head.length >= 15) return head;
  }
  return t;
}

function tagOf(el: Element): string {
  return el.tagName.toLowerCase();
}

function textLen(blocks: Block[]): number {
  let n = 0;
  for (const b of blocks) if (b.text) n += b.text.length;
  return n;
}

function extractTitle(dom: Document): string {
  const og = dom.querySelector('meta[property="og:title"]')?.getAttribute("content");
  if (og && og.trim()) return normalizeWhitespace(og);
  const titleEl = dom.querySelector("title");
  if (titleEl && (titleEl.textContent ?? "").trim()) return cleanTitle(titleEl.textContent!);
  const h1 = dom.querySelector("h1");
  if (h1 && (h1.textContent ?? "").trim()) return normalizeWhitespace(h1.textContent!);
  return "Untitled";
}

function extractByline(dom: Document): string | undefined {
  const meta = dom.querySelector('meta[name="author"]')?.getAttribute("content");
  if (meta && meta.trim()) return normalizeWhitespace(meta).slice(0, 100);
  const rel = dom.querySelector('[rel="author"]');
  if (rel && (rel.textContent ?? "").trim()) {
    const t = normalizeWhitespace(rel.textContent!);
    if (t.length <= 100) return t;
  }
  const byClass = dom.querySelector(
    '[class*="byline" i],[class*="author" i],[id*="byline" i],[id*="author" i]',
  );
  if (byClass && (byClass.textContent ?? "").trim()) {
    const t = normalizeWhitespace(byClass.textContent!);
    if (t.length <= 100) return t;
  }
  return undefined;
}

export function extractArticle(dom: Document): ExtractedArticle | null {
  dom.querySelectorAll(STRIP_SELECTOR).forEach((el) => el.remove());

  const body: Element = dom.body ?? dom.documentElement;
  if (!body) return null;

  const scores = new Map<Element, number>();
  const ensure = (el: Element): void => {
    if (!scores.has(el)) {
      scores.set(el, classWeight(el.className || "", el.id || "") + (tagOf(el) === "article" ? 30 : 0));
    }
  };

  for (const node of Array.from(body.querySelectorAll("p,pre,blockquote,li"))) {
    const pts = scoreText(node.textContent ?? "");
    if (pts === 0) continue;
    const parent = node.parentElement;
    if (parent) {
      ensure(parent);
      scores.set(parent, scores.get(parent)! + pts);
    }
    const grand = parent?.parentElement ?? null;
    if (grand) {
      ensure(grand);
      scores.set(grand, scores.get(grand)! + pts / 2);
    }
  }

  let winner: Element | null = null;
  let best = -Infinity;
  for (const [el, sc] of scores) {
    if (sc > best) {
      best = sc;
      winner = el;
    }
  }
  if (!winner) return null;

  // Climb while the parent retains most of the winner's score (split content).
  let top = winner;
  while (top.parentElement) {
    const ps = scores.get(top.parentElement);
    if (ps !== undefined && ps >= 0.75 * best) top = top.parentElement;
    else break;
  }

  const blocks = domToBlocks(top, () => null);
  if (textLen(blocks) < 250) return null;

  const byline = extractByline(dom);
  return byline
    ? { title: extractTitle(dom), byline, blocks }
    : { title: extractTitle(dom), blocks };
}
