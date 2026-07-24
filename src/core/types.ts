// Tarotalking domain model — the single source of truth for shapes shared
// across views, the playback engine, and (as opaque JSON) the Rust backend.
// The Rust side stores library/settings/doc JSON opaquely; only import and
// TTS payloads have mirrored Rust structs (see src-tauri/src/import, tts).

/* ================= content model ================= */

/** Every source (EPUB, txt, paste, URL) normalizes into a ContentDoc:
 *  chapters of typed blocks holding plain text. Raw HTML never reaches the
 *  reader DOM — this model IS the sanitizer. */
export type BlockType = "p" | "h1" | "h2" | "h3" | "blockquote" | "li" | "code" | "img" | "hr";

export interface Block {
  t: BlockType;
  /** Plain text content (absent for img/hr). */
  text?: string;
  /** Absolute path of an extracted image (img blocks only). */
  src?: string;
  /** Ordered-list item marker, e.g. "3." (li blocks only; absent = bullet). */
  marker?: string;
}

export interface Chapter {
  title: string;
  blocks: Block[];
}

export interface ContentDoc {
  version: 1;
  title: string;
  author?: string;
  chapters: Chapter[];
}

/* ================= library ================= */

export type SourceType = "epub" | "text" | "paste" | "url";

/** A location inside a ContentDoc. Sentence indices are per-block,
 *  lazily derived via Intl.Segmenter (never persisted per-book). */
export interface Position {
  chapter: number;
  block: number;
  sentence: number;
}

export const POSITION_ZERO: Position = { chapter: 0, block: 0, sentence: 0 };

export interface Bookmark {
  id: string;
  pos: Position;
  /** Snippet of the bookmarked text, for display. */
  label: string;
  createdAt: number;
}

export type AnnotationColor = "yellow" | "green" | "blue" | "pink";

/** A highlighted text range (with optional note), within ONE chapter.
 *  Char offsets index the BLOCK's plain text (same space as sentence spans). */
export interface Annotation {
  id: string;
  color: AnnotationColor;
  note?: string;
  chapter: number;
  /** Start block index + char offset within that block. */
  startBlock: number;
  startChar: number;
  /** End block index + char offset (exclusive) within that block. */
  endBlock: number;
  endChar: number;
  /** Short snippet of the highlighted text, for list display. */
  snippet: string;
  createdAt: number;
}

export interface LibraryItem {
  id: string;
  title: string;
  author?: string;
  sourceType: SourceType;
  /** Original URL for url items. */
  sourceUrl?: string;
  addedAt: number;
  lastOpenedAt?: number;
  favorite: boolean;
  /** Collection ids this item belongs to. */
  collections: string[];
  wordCount: number;
  chapterCount: number;
  /** Absolute path to the cover image (EPUBs); UI renders a gradient cover otherwise. */
  cover?: string;
  /** Title of the chapter the reading/listening position sits in — shown on
   *  library cards as "where you left off". */
  chapterLabel?: string;
  /** Reading position (what's on screen). */
  reading: Position;
  /** Listening position (what's being spoken). */
  playback: Position;
  /** 0..1 overall progress (by word offset of the reading position). */
  progressPct: number;
  finished?: boolean;
  bookmarks: Bookmark[];
  /** Highlights & notes. Absent on items from older versions. */
  annotations?: Annotation[];
  /** Per-book voice memory — overrides the global default when set. */
  voice?: VoiceRef;
  /** Per-book speed memory — overrides the global default when set. */
  rate?: number;
}

export interface Collection {
  id: string;
  name: string;
  createdAt: number;
}

export interface LibraryIndex {
  version: 1;
  items: LibraryItem[];
  collections: Collection[];
}

export const EMPTY_LIBRARY: LibraryIndex = { version: 1, items: [], collections: [] };

/** File extensions accepted for import. */
export const IMPORT_EXTENSIONS = new Set(["epub", "txt", "md"]);

/* ================= voices / TTS ================= */

export type ProviderId =
  | "system"
  | "edge"
  | "piper"
  | "kokoro"
  | "eleven"
  | "openai"
  | "speechify"
  | "deepgram"
  | "cartesia";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  system: "System voices",
  edge: "Microsoft Edge voices",
  piper: "Piper (local)",
  kokoro: "Kokoro (local)",
  eleven: "ElevenLabs",
  openai: "OpenAI",
  speechify: "Speechify",
  deepgram: "Deepgram",
  cartesia: "Cartesia",
};

export const ALL_PROVIDER_IDS: readonly ProviderId[] = [
  "system",
  "edge",
  "piper",
  "kokoro",
  "eleven",
  "openai",
  "speechify",
  "deepgram",
  "cartesia",
];

/** Rough synthesized-audio size per second of speech, by provider (bytes).
 *  Used for "how much cache will this need" estimates before pre-synthesis. */
export function audioBytesPerSecond(provider: ProviderId, quality: AudioQuality): number {
  switch (provider) {
    case "edge":
      return quality === "high" ? 12_000 : 6_000; // 96 / 48 kbps mp3
    case "eleven":
      return quality === "high" ? 16_000 : 12_000; // 128 / 96 kbps mp3
    case "openai":
    case "speechify":
    case "deepgram":
    case "cartesia":
      return 16_000; // ~128 kbps mp3
    case "system":
      return 44_100; // 22.05 kHz 16-bit mono wav
    case "piper":
      return 44_100;
    case "kokoro":
      return 48_000; // 24 kHz 16-bit mono wav
  }
}

/** What settings persist to pick a voice. */
export interface VoiceRef {
  provider: ProviderId;
  id: string;
}

export interface VoiceInfo {
  provider: ProviderId;
  id: string;
  name: string;
  locale?: string;
  gender?: string;
  /** For piper: whether the model is downloaded. */
  installed?: boolean;
}

export interface WordBoundary {
  /** Offset from audio start, ms. */
  offsetMs: number;
  /** Char offset/length into the synthesized sentence text. */
  charStart: number;
  charLen: number;
  text: string;
}

/** Result of synthesizing one sentence (audio providers). */
export interface SynthResult {
  /** Absolute path of the audio file in the cache (mp3/wav). */
  path: string;
  boundaries?: WordBoundary[];
}

export interface PiperModel {
  id: string;
  name: string;
  quality: string;
  locale: string;
  sizeMB: number;
  installed: boolean;
}

export interface PiperStatus {
  binaryInstalled: boolean;
  binarySizeMB: number;
  models: PiperModel[];
}

/* ================= playback ================= */

export type PlaybackStatus = "idle" | "loading" | "playing" | "paused" | "error";

export const PLAYBACK_RATES = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/* ================= settings ================= */

export type AppTheme = "dark" | "light" | "system";
export type ReaderTheme = "default" | "paper" | "sepia" | "slate" | "black";
export type HighlightMode = "sentence" | "word" | "off";

/** Curated reader fonts — Windows-safe stacks, no webfonts (CSP + weight). */
export const READER_FONTS: { id: string; label: string; stack: string; kind: "serif" | "sans" }[] = [
  { id: "serif", label: "Georgia", stack: "Georgia, 'Times New Roman', serif", kind: "serif" },
  { id: "constantia", label: "Constantia", stack: "Constantia, Georgia, serif", kind: "serif" },
  { id: "palatino", label: "Palatino", stack: "'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif", kind: "serif" },
  { id: "cambria", label: "Cambria", stack: "Cambria, Georgia, serif", kind: "serif" },
  { id: "times", label: "Times New Roman", stack: "'Times New Roman', Times, serif", kind: "serif" },
  { id: "sans", label: "Segoe UI", stack: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif", kind: "sans" },
  { id: "calibri", label: "Calibri", stack: "Calibri, 'Segoe UI', sans-serif", kind: "sans" },
  { id: "verdana", label: "Verdana", stack: "Verdana, Geneva, sans-serif", kind: "sans" },
];

/** CSS stack for a stored font id ("serif"/"sans" stay valid as defaults). */
export function readerFontStack(id: string): string {
  return (READER_FONTS.find((f) => f.id === id) ?? READER_FONTS[0]!).stack;
}

export interface ReaderPrefs {
  /** Font id from READER_FONTS ("serif" and "sans" are the legacy defaults). */
  font: string;
  fontSize: number; // px, 14..28
  lineHeight: number; // 1.3..2.2
  /** Max text column width in px, 520..980. */
  width: number;
  theme: ReaderTheme;
  justify: boolean;
}

export interface PlaybackPrefs {
  voice: VoiceRef | null;
  rate: number;
  volume: number; // 0..1
  autoScroll: boolean;
  highlight: HighlightMode;
}

export type AudioQuality = "standard" | "high";

export interface Settings {
  theme: AppTheme;
  reader: ReaderPrefs;
  playback: PlaybackPrefs;
  /** Synthesis quality for providers with tunable formats (Edge, ElevenLabs).
   *  Part of the audio cache key — switching re-synthesizes. */
  audioQuality: AudioQuality;
  /** Compact now-playing bar on the library while a book plays elsewhere.
   *  When off, leaving the reader pauses playback instead. */
  miniPlayer: boolean;
  shortcuts: Record<string, string>;
  cacheLimitMB: number;
  closeToTray: boolean;
  resumeLastItem: boolean;
  notifications: boolean;
  elevenModel: string;
  launchAtStartup: boolean;
}

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  font: "serif",
  fontSize: 19,
  lineHeight: 1.7,
  width: 680,
  theme: "default",
  justify: false,
};

export const DEFAULT_PLAYBACK_PREFS: PlaybackPrefs = {
  voice: null,
  rate: 1,
  volume: 1,
  autoScroll: true,
  highlight: "sentence",
};

/* ================= shortcuts ================= */

export type ActionId =
  | "playPause"
  | "stop"
  | "prevSentence"
  | "nextSentence"
  | "prevParagraph"
  | "nextParagraph"
  | "prevChapter"
  | "nextChapter"
  | "pageUp"
  | "pageDown"
  | "speedUp"
  | "speedDown"
  | "addBookmark"
  | "toggleToc"
  | "toggleFocus"
  | "toggleFullscreen"
  | "fontBigger"
  | "fontSmaller"
  | "back"
  | "openSettings"
  | "showShortcuts";

export const DEFAULT_SHORTCUTS: Record<ActionId, string> = {
  playPause: "Space",
  stop: "Ctrl+.",
  prevSentence: "ArrowLeft",
  nextSentence: "ArrowRight",
  prevParagraph: "Ctrl+ArrowLeft",
  nextParagraph: "Ctrl+ArrowRight",
  prevChapter: "[",
  nextChapter: "]",
  pageUp: "PageUp",
  pageDown: "PageDown",
  speedUp: ".",
  speedDown: ",",
  addBookmark: "B",
  toggleToc: "T",
  toggleFocus: "F",
  toggleFullscreen: "F11",
  fontBigger: "Ctrl+=",
  fontSmaller: "Ctrl+-",
  back: "Escape",
  openSettings: "Ctrl+,",
  showShortcuts: "Shift+/",
};

export const ACTION_LABELS: Record<ActionId, string> = {
  playPause: "Play / pause",
  stop: "Stop",
  prevSentence: "Previous sentence",
  nextSentence: "Next sentence",
  prevParagraph: "Previous paragraph",
  nextParagraph: "Next paragraph",
  prevChapter: "Previous chapter",
  nextChapter: "Next chapter",
  pageUp: "Page up",
  pageDown: "Page down",
  speedUp: "Faster",
  speedDown: "Slower",
  addBookmark: "Add bookmark",
  toggleToc: "Contents panel",
  toggleFocus: "Focus mode",
  toggleFullscreen: "Fullscreen",
  fontBigger: "Larger text",
  fontSmaller: "Smaller text",
  back: "Back / close",
  openSettings: "Settings",
  showShortcuts: "Keyboard shortcuts",
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  reader: DEFAULT_READER_PREFS,
  playback: DEFAULT_PLAYBACK_PREFS,
  audioQuality: "high",
  miniPlayer: true,
  shortcuts: { ...DEFAULT_SHORTCUTS },
  cacheLimitMB: 200,
  closeToTray: true,
  resumeLastItem: false,
  notifications: true,
  elevenModel: "eleven_flash_v2_5",
  launchAtStartup: false,
};

/* ================= words / estimates ================= */

/** Silent-reading speed used for time-left estimates. */
export const READING_WPM = 230;
/** Approximate spoken words-per-minute at 1x. */
export const SPEAKING_WPM = 155;
