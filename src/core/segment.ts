// Sentence segmentation + word counting on top of Intl.Segmenter.
// Sentences are derived lazily per block — never pre-split a whole book.

export interface SentenceSpan {
  text: string;
  /** Char offsets into the block text (end exclusive). */
  start: number;
  end: number;
}

// Segmenters are stateless — one shared instance each.
const sentenceSeg =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("en", { granularity: "sentence" })
    : null;
const wordSeg =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("en", { granularity: "word" })
    : null;

// V8's Intl.Segmenter does not apply CLDR sentence-break suppressions, so
// "Mr. Smith" splits after "Mr." — audibly wrong for TTS. We merge a segment
// back into the next one when it ends in a known abbreviation (or a single
// initial like "J."), and also when the next segment starts lowercase (a
// strong false-split signal, e.g. after "e.g.").
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "rev", "hon", "st", "jr", "sr",
  "capt", "lt", "col", "gen", "sgt", "maj", "cmdr", "gov", "sen", "rep",
  "mt", "ft", "vs", "no", "vol", "fig", "dept", "est", "approx", "inc",
  "ltd", "co", "corp", "univ", "assn", "bros", "ph.d", "b.a", "m.a", "u.s", "u.k",
]);

function endsInAbbreviation(sentence: string): boolean {
  if (!sentence.endsWith(".")) return false;
  const m = /(?:^|[\s("'‘“])([A-Za-z][A-Za-z.]{0,6})\.$/.exec(sentence);
  if (!m) return false;
  const word = m[1]!.toLowerCase().replace(/\.+$/, "");
  if (word.length === 1) return true; // single initial: "J."
  return ABBREVIATIONS.has(word);
}

/** Split block text into trimmed, non-empty sentence spans. Offsets refer to
 *  the ORIGINAL string (so highlight ranges map back exactly). */
export function splitSentences(text: string): SentenceSpan[] {
  const out: SentenceSpan[] = [];
  if (!text) return out;
  if (!sentenceSeg) {
    const t = text.trim();
    if (t) out.push({ text: t, start: text.indexOf(t[0]!), end: text.length });
    return out;
  }
  for (const seg of sentenceSeg.segment(text)) {
    const raw = seg.segment;
    // trim while tracking offsets
    let s = 0;
    let e = raw.length;
    while (s < e && isSpace(raw.charCodeAt(s))) s++;
    while (e > s && isSpace(raw.charCodeAt(e - 1))) e--;
    if (e <= s) continue;
    const span: SentenceSpan = { text: raw.slice(s, e), start: seg.index + s, end: seg.index + e };
    const prev = out[out.length - 1];
    const startsLower = /^[a-z]/.test(span.text);
    if (prev && (endsInAbbreviation(prev.text) || startsLower)) {
      prev.text = text.slice(prev.start, span.end);
      prev.end = span.end;
    } else {
      out.push(span);
    }
  }
  return out;
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 0xa0;
}

/** Word count of a text (Intl word segments that contain letters/digits). */
export function countWords(text: string): number {
  if (!text) return 0;
  if (!wordSeg) return text.split(/\s+/).filter(Boolean).length;
  let n = 0;
  for (const seg of wordSeg.segment(text)) {
    if ((seg as Intl.SegmentData & { isWordLike?: boolean }).isWordLike) n++;
  }
  return n;
}

/** Collapse runs of whitespace to single spaces and trim. Used when
 *  normalizing imported text so segmentation and display are stable. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
