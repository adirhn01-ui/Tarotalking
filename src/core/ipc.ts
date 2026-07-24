// Typed IPC layer — the ONLY place that names Rust commands. Every command
// the backend exposes is wrapped here; views never call invoke() directly.
// This file is the frozen contract between frontend and src-tauri.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  LibraryIndex,
  PiperStatus,
  ProviderId,
  SynthResult,
  VoiceInfo,
} from "./types";

/** True when running inside the Tauri desktop shell (vs a plain browser or
 *  the Node test environment). */
export const inTauri: boolean =
  typeof window !== "undefined" &&
  typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
    "undefined";

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri) return Promise.reject(new Error("desktop backend unavailable"));
  return invoke<T>(cmd, args);
}

/** Turn any thrown IPC error into a short, user-readable message. */
export function describeError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "Something went wrong";
}

/* ================= payload shapes mirrored from Rust ================= */

export interface EpubChapterRaw {
  /** Spine href (zip-relative path of the XHTML file). */
  href: string;
  /** TOC title for this file, when the TOC names it. */
  title: string | null;
  /** Raw XHTML — parse with DOMParser (inert), convert to blocks, discard. */
  html: string;
}

export interface EpubImportResult {
  itemDir: string;
  title: string | null;
  author: string | null;
  /** Absolute path of the extracted cover image, if the EPUB declares one. */
  coverPath: string | null;
  chapters: EpubChapterRaw[];
  /** zip-relative image path (lowercased) → absolute extracted path. */
  images: Record<string, string>;
}

export interface FetchedPage {
  finalUrl: string;
  contentType: string;
  body: string;
}

export interface DownloadProgress {
  taskId: string;
  label: string;
  received: number;
  total: number | null;
  done: boolean;
  error: string | null;
}

export interface CacheStats {
  bytes: number;
  files: number;
}

export interface KokoroStatus {
  engineInstalled: boolean;
  engineSizeMB: number;
  modelInstalled: boolean;
  modelSizeMB: number;
  voices: { id: string; name: string; gender: string; locale: string }[];
}

export interface DebugInfo {
  autotest: boolean;
  autotestKeep: boolean;
  fixturesDir: string;
}

/* ================= commands ================= */

export const ipc = {
  /* ----- settings (opaque JSON; frontend owns the schema) ----- */
  loadSettings: (): Promise<unknown> => call("settings_load"),
  saveSettings: (settings: unknown): Promise<void> => call("settings_save", { settings }),

  /* ----- library index (opaque JSON; frontend owns the schema) ----- */
  loadLibrary: (): Promise<unknown> => call("library_load"),
  saveLibrary: (index: LibraryIndex): Promise<void> => call("library_save", { index }),

  /* ----- library item content ----- */
  /** Unzip + parse an EPUB into raw chapters and extracted images under the
   *  item's dir. Frontend converts XHTML → blocks and stores via writeDoc. */
  importEpub: (id: string, path: string): Promise<EpubImportResult> =>
    call("import_epub", { id, path }),
  /** Read a text-ish file (txt/md), size-capped, lossy UTF-8. */
  readTextFile: (path: string): Promise<string> => call("read_text_file", { path }),
  /** Fetch a web page over HTTP(S) in Rust (frontend has no network). */
  fetchUrl: (url: string): Promise<FetchedPage> => call("fetch_url", { url }),
  /** Persist the parsed ContentDoc JSON for an item. */
  writeDoc: (id: string, doc: unknown): Promise<void> => call("item_write_doc", { id, doc }),
  /** Load the parsed ContentDoc JSON for an item. */
  readDoc: (id: string): Promise<unknown> => call("item_read_doc", { id }),
  /** Delete an item's content dir (index removal is the frontend's job). */
  deleteItem: (id: string): Promise<void> => call("item_delete", { id }),

  /* ----- TTS ----- */
  /** Synthesize one sentence. Returns a cache-file path (+ word boundaries
   *  when the provider reports them). Cached: same text+voice never
   *  re-synthesizes. */
  synth: (provider: ProviderId, voiceId: string, text: string): Promise<SynthResult> =>
    call("tts_synth", { provider, voiceId, text }),
  systemVoices: (): Promise<VoiceInfo[]> => call("system_voices"),
  edgeVoices: (): Promise<VoiceInfo[]> => call("edge_voices"),
  elevenVoices: (): Promise<VoiceInfo[]> => call("eleven_voices"),
  speechifyVoices: (): Promise<VoiceInfo[]> => call("speechify_voices"),
  cartesiaVoices: (): Promise<VoiceInfo[]> => call("cartesia_voices"),

  /** Pre-synthesize sentences into the cache (skips cached ones). Progress
   *  arrives via download-progress events under `taskId` (sentence counts).
   *  One job at a time; returns how many sentences were synthesized. */
  precache: (
    provider: ProviderId,
    voiceId: string,
    texts: string[],
    taskId: string,
    label: string,
  ): Promise<number> => call("tts_precache", { provider, voiceId, texts, taskId, label }),
  precacheCancel: (): Promise<void> => call("tts_precache_cancel"),

  /* ----- kokoro local voices ----- */
  kokoroStatus: (): Promise<KokoroStatus> => call("kokoro_status"),
  kokoroInstallEngine: (): Promise<void> => call("kokoro_install_engine"),
  kokoroInstallModel: (): Promise<void> => call("kokoro_install_model"),
  kokoroRemove: (): Promise<void> => call("kokoro_remove"),

  /* ----- piper local voices ----- */
  piperStatus: (): Promise<PiperStatus> => call("piper_status"),
  /** Download the piper binary (idempotent). Progress via download events. */
  piperInstallBinary: (): Promise<void> => call("piper_install_binary"),
  piperInstallModel: (modelId: string): Promise<void> =>
    call("piper_install_model", { modelId }),
  piperRemoveModel: (modelId: string): Promise<void> =>
    call("piper_remove_model", { modelId }),
  /** Remove the binary and every model. */
  piperRemoveAll: (): Promise<void> => call("piper_remove_all"),
  /** Where local voices live on disk (for the settings UI). */
  piperDir: (): Promise<string> => call("piper_dir"),

  /* ----- API keys (Windows Credential Manager; never returned) ----- */
  setKey: (provider: string, key: string): Promise<void> => call("key_set", { provider, key }),
  hasKey: (provider: string): Promise<boolean> => call("key_present", { provider }),
  deleteKey: (provider: string): Promise<void> => call("key_delete", { provider }),

  /* ----- audio cache ----- */
  cacheStats: (): Promise<CacheStats> => call("cache_stats"),
  cacheClear: (): Promise<void> => call("cache_clear"),
  /** Enforce the size cap (called after settings change). */
  cachePrune: (maxBytes: number): Promise<void> => call("cache_prune", { maxBytes }),

  /* ----- OS / shell ----- */
  /** Reveal a file or folder in Explorer. */
  showInFolder: (path: string): Promise<void> => call("show_in_folder", { path }),
  /** Playback state → tray tooltip / close-to-tray behavior. */
  setPlaybackState: (playing: boolean, title: string | null): Promise<void> =>
    call("set_playback_state", { playing, title }),
  /** Drain the queued open-with paths (single-instance + startup). */
  takePendingOpenPaths: (): Promise<string[]> => call("take_pending_open_paths"),
  /** Graceful quit (tray) — call after flushing state. */
  quitApp: (): Promise<void> => call("quit_app"),
  debugInfo: (): Promise<DebugInfo> => call("debug_info"),
  /** Dev E2E only: persist the autotest report for the E2E runner. */
  autotestReport: (report: unknown): Promise<void> => call("autotest_report", { report }),
};

/* ================= events (Rust → frontend) ================= */

/** Second-instance / file-association opens. Drain via takePendingOpenPaths. */
export function onOpenPath(cb: () => void): Promise<UnlistenFn> {
  if (!inTauri) return Promise.resolve(() => {});
  return listen("open-path", cb);
}

/** Voice/model download progress. */
export function onDownloadProgress(cb: (p: DownloadProgress) => void): Promise<UnlistenFn> {
  if (!inTauri) return Promise.resolve(() => {});
  return listen<DownloadProgress>("download-progress", (e) => cb(e.payload));
}

/** Tray menu actions: "play-pause" | "next" | "prev" | "open" | "quit-requested". */
export function onTrayAction(cb: (action: string) => void): Promise<UnlistenFn> {
  if (!inTauri) return Promise.resolve(() => {});
  return listen<string>("tray-action", (e) => cb(e.payload));
}
