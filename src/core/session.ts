// App-wide session state: the settings store (loaded once at boot, sanitized
// against corruption, autosaved on change) and theme application.

import { ipc } from "./ipc";
import { Store } from "./store";
import type { AppTheme, ReaderTheme, Settings, VoiceRef } from "./types";
import {
  ALL_PROVIDER_IDS,
  DEFAULT_PLAYBACK_PREFS,
  DEFAULT_READER_PREFS,
  DEFAULT_SETTINGS,
  DEFAULT_SHORTCUTS,
  PLAYBACK_RATES,
} from "./types";

export const settingsStore = new Store<Settings>(DEFAULT_SETTINGS);

export function applyTheme(theme: AppTheme): void {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : theme;
  document.documentElement.dataset.theme = resolved;
}

/* ---- sanitizers: a corrupt/hand-edited settings.json must never crash ---- */

function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : def;
  return Math.max(min, Math.min(max, n));
}
function bool(v: unknown, def: boolean): boolean {
  return typeof v === "boolean" ? v : def;
}
function str(v: unknown, def: string): string {
  return typeof v === "string" && v.length > 0 ? v : def;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : def;
}

function sanitizeVoice(v: unknown): VoiceRef | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const provider = o.provider;
  const id = o.id;
  if (
    typeof provider === "string" &&
    (ALL_PROVIDER_IDS as readonly string[]).includes(provider) &&
    typeof id === "string" &&
    id.length > 0
  ) {
    return { provider: provider as VoiceRef["provider"], id };
  }
  return null;
}

export function sanitizeSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SHORTCUTS } };
  const o = raw as Record<string, unknown>;
  const reader = (o.reader ?? {}) as Record<string, unknown>;
  const playback = (o.playback ?? {}) as Record<string, unknown>;
  const shortcuts: Record<string, string> = { ...DEFAULT_SHORTCUTS };
  if (o.shortcuts && typeof o.shortcuts === "object") {
    for (const [k, v] of Object.entries(o.shortcuts as Record<string, unknown>)) {
      if (k in DEFAULT_SHORTCUTS && typeof v === "string") shortcuts[k] = v;
    }
  }
  const rate = num(playback.rate, DEFAULT_PLAYBACK_PREFS.rate, 0.5, 3);
  return {
    theme: oneOf<AppTheme>(o.theme, ["dark", "light", "system"], "dark"),
    reader: {
      font: str(reader.font, DEFAULT_READER_PREFS.font),
      fontSize: num(reader.fontSize, DEFAULT_READER_PREFS.fontSize, 13, 30),
      lineHeight: num(reader.lineHeight, DEFAULT_READER_PREFS.lineHeight, 1.2, 2.4),
      width: num(reader.width, DEFAULT_READER_PREFS.width, 480, 1040),
      theme: oneOf<ReaderTheme>(
        reader.theme,
        ["default", "paper", "sepia", "slate", "black"],
        "default",
      ),
      justify: bool(reader.justify, DEFAULT_READER_PREFS.justify),
    },
    playback: {
      voice: sanitizeVoice(playback.voice),
      rate: PLAYBACK_RATES.includes(rate) ? rate : DEFAULT_PLAYBACK_PREFS.rate,
      volume: num(playback.volume, 1, 0, 1),
      autoScroll: bool(playback.autoScroll, true),
      highlight: oneOf(playback.highlight, ["sentence", "word", "off"], "sentence"),
    },
    shortcuts,
    audioQuality: oneOf(o.audioQuality, ["standard", "high"], "high"),
    miniPlayer: bool(o.miniPlayer, DEFAULT_SETTINGS.miniPlayer),
    // 0 = unlimited (pre-synthesized libraries can be large by choice).
    cacheLimitMB: num(o.cacheLimitMB, DEFAULT_SETTINGS.cacheLimitMB, 0, 100_000),
    closeToTray: bool(o.closeToTray, DEFAULT_SETTINGS.closeToTray),
    resumeLastItem: bool(o.resumeLastItem, DEFAULT_SETTINGS.resumeLastItem),
    notifications: bool(o.notifications, DEFAULT_SETTINGS.notifications),
    elevenModel: str(o.elevenModel, DEFAULT_SETTINGS.elevenModel),
    launchAtStartup: bool(o.launchAtStartup, DEFAULT_SETTINGS.launchAtStartup),
  };
}

export async function initSettings(): Promise<void> {
  try {
    const loaded = await ipc.loadSettings();
    if (loaded) settingsStore.set(sanitizeSettings(loaded));
  } catch {
    // defaults are fine; the settings UI reports persistence problems later
  }
  applyTheme(settingsStore.get().theme);
  window
    .matchMedia("(prefers-color-scheme: light)")
    .addEventListener("change", () => applyTheme(settingsStore.get().theme));
}

let saveTimer: number | undefined;

/** Apply a settings patch: update the store, apply theme, save (debounced). */
export function updateSettings(patch: Partial<Settings>): void {
  const next = { ...settingsStore.get(), ...patch };
  settingsStore.set(next);
  if (patch.theme) applyTheme(patch.theme);
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void ipc.saveSettings(settingsStore.get()).catch(() => {});
  }, 300);
}

/** Nested helpers so views don't hand-spread. */
export function updateReaderPrefs(patch: Partial<Settings["reader"]>): void {
  updateSettings({ reader: { ...settingsStore.get().reader, ...patch } });
}
export function updatePlaybackPrefs(patch: Partial<Settings["playback"]>): void {
  updateSettings({ playback: { ...settingsStore.get().playback, ...patch } });
}
