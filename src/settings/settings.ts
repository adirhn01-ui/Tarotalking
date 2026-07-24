// Settings screen — a sectioned, sidebar-driven full-window route. A top bar
// (Back → library), a left section list, and a right content pane that swaps
// per section without a page reload. Everything reflects settingsStore live and
// persists immediately via updateSettings / updateReaderPrefs / updatePlaybackPrefs.
//
// This file owns: the shell, section routing, the "simple" sections
// (appearance, reader, playback, API keys, shortcuts, storage, about) and two
// shared modal helpers (openModal / confirmModal) that the voices section
// reuses. The voices section itself lives in ./voices.

import "./settings.css";
import { escapeHtml, formatBytes } from "../core/format";
import { describeError, inTauri, ipc, type CacheStats } from "../core/ipc";
import { navigate } from "../core/nav";
import {
  settingsStore,
  updatePlaybackPrefs,
  updateReaderPrefs,
  updateSettings,
} from "../core/session";
import { chordOf, findConflicts, normalizeChord } from "../core/shortcuts";
import type { ActionId, ReaderTheme, Settings } from "../core/types";
import {
  ACTION_LABELS,
  DEFAULT_PLAYBACK_PREFS,
  DEFAULT_READER_PREFS,
  DEFAULT_SETTINGS,
  DEFAULT_SHORTCUTS,
  PLAYBACK_RATES,
  READER_FONTS,
} from "../core/types";
import { invalidateCartesiaVoices } from "../player/providers/cartesia";
import { invalidateElevenVoices } from "../player/providers/eleven";
import { invalidateSpeechifyVoices } from "../player/providers/speechify";
import { trapTab } from "../ui/focus";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";
import { mountVoices } from "./voices";

export interface SettingsView {
  dispose(): void | Promise<void>;
}

/* ================= pure helpers (unit-tested) ================= */

/** Preset cache-limit sizes offered in the Storage select, in megabytes.
 *  ("Unlimited" (0) and "Custom" are added as non-numeric choices in the UI.) */
export const CACHE_LIMIT_PRESETS = [200, 500, 1000, 2000, 5000] as const;

/** Bounds for the Custom cache-limit input (megabytes). */
export const CACHE_CUSTOM_MIN = 50;
export const CACHE_CUSTOM_MAX = 100_000;

/** "200 MB", "1 GB", "5 GB" — GB at/above 1000 MB; 0 (or less) → "Unlimited". */
export function cacheLimitLabel(mb: number): string {
  if (mb <= 0) return "Unlimited";
  return mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB`;
}

/** The <select> option value matching a stored cacheLimitMB: "unlimited" for 0,
 *  the preset number as a string when it matches one, otherwise "custom". */
export function cacheLimitSelectValue(mb: number): string {
  if (mb <= 0) return "unlimited";
  return (CACHE_LIMIT_PRESETS as readonly number[]).includes(mb) ? String(mb) : "custom";
}

/** True when a stored cacheLimitMB needs the Custom input (non-zero, non-preset). */
export function isCustomCacheLimit(mb: number): boolean {
  return cacheLimitSelectValue(mb) === "custom";
}

/** Clamp a typed custom cache limit into the allowed MB range (NaN → min). */
export function clampCustomCacheLimit(mb: number): number {
  if (!Number.isFinite(mb)) return CACHE_CUSTOM_MIN;
  return Math.max(CACHE_CUSTOM_MIN, Math.min(CACHE_CUSTOM_MAX, Math.round(mb)));
}

/** "184 MB · 213 clips" from a CacheStats. */
export function cacheUsageLabel(stats: CacheStats): string {
  const clips = stats.files === 1 ? "1 clip" : `${stats.files} clips`;
  return `${formatBytes(stats.bytes)} · ${clips}`;
}

/** Split a normalized chord into its display key tokens ("Ctrl+ArrowLeft" → ["Ctrl","ArrowLeft"]). */
export function chordKeys(chord: string): string[] {
  return chord ? chord.split("+") : [];
}

/** The set of chords bound to more than one action. */
export function shortcutConflictSet(shortcuts: Record<string, string>): Set<string> {
  return new Set(findConflicts(shortcuts));
}

/** Display model for one shortcut row: its normalized chord, key tokens, and
 *  whether it collides with another binding. */
export function actionChordDisplay(
  stored: string,
  conflicts: Set<string>,
): { chord: string; keys: string[]; conflict: boolean } {
  const chord = normalizeChord(stored);
  return { chord, keys: chordKeys(chord), conflict: chord !== "" && conflicts.has(chord) };
}

/* ================= shared modal helpers ================= */

export interface ModalHandle {
  root: HTMLElement;
  body: HTMLElement;
  close(): void;
}

/** A framework-less modal: backdrop + trapTab + Esc/backdrop/X close paths. */
export function openModal(opts: {
  title: string;
  ariaLabel?: string;
  build: (body: HTMLElement, close: () => void) => void;
  footer?: (footer: HTMLElement, close: () => void) => void;
  onClose?: () => void;
}): ModalHandle {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal set-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", opts.ariaLabel ?? opts.title);

  const header = document.createElement("div");
  header.className = "modal__header";
  const titleEl = document.createElement("span");
  titleEl.textContent = opts.title;
  const xBtn = document.createElement("button");
  xBtn.type = "button";
  xBtn.className = "btn btn--icon btn--ghost btn--sm";
  xBtn.title = "Close";
  xBtn.setAttribute("aria-label", "Close");
  xBtn.innerHTML = icon.x;
  header.append(titleEl, xBtn);

  const body = document.createElement("div");
  body.className = "modal__body";

  modal.append(header, body);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const releaseTrap = trapTab(backdrop);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    releaseTrap();
    backdrop.remove();
    opts.onClose?.();
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  xBtn.addEventListener("click", close);

  opts.build(body, close);
  if (opts.footer) {
    const footer = document.createElement("div");
    footer.className = "modal__footer";
    opts.footer(footer, close);
    modal.appendChild(footer);
  }

  const focusable = modal.querySelector<HTMLElement>(
    'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  focusable?.focus();

  return { root: backdrop, body, close };
}

/** A simple confirm dialog (Cancel / confirm). */
export function confirmModal(opts: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}): void {
  openModal({
    title: opts.title,
    build: (body) => {
      const p = document.createElement("p");
      p.className = "set-modal-msg";
      p.textContent = opts.message;
      body.appendChild(p);
    },
    footer: (footer, close) => {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn--sm";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", close);
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = opts.danger ? "btn btn--sm btn--danger" : "btn btn--sm btn--primary";
      confirm.textContent = opts.confirmLabel;
      confirm.addEventListener("click", () => {
        close();
        opts.onConfirm();
      });
      footer.append(cancel, confirm);
    },
  });
}

/* ================= section registry ================= */

const SECTIONS: { id: string; label: string; icon: string }[] = [
  { id: "appearance", label: "Appearance", icon: icon.sun },
  { id: "reader", label: "Reader", icon: icon.type },
  { id: "playback", label: "Playback", icon: icon.headphones },
  { id: "voices", label: "Voices", icon: icon.mic },
  { id: "keys", label: "API keys", icon: icon.key },
  { id: "shortcuts", label: "Shortcuts", icon: icon.keyboard },
  { id: "storage", label: "Storage", icon: icon.shield },
  { id: "about", label: "About", icon: icon.info },
];
const SECTION_IDS = new Set(SECTIONS.map((s) => s.id));

type KeyProviderId = "eleven" | "openai" | "speechify" | "deepgram" | "cartesia";

const KEY_PROVIDERS: { id: KeyProviderId; label: string; placeholder: string; desc: string }[] = [
  {
    id: "eleven",
    label: "ElevenLabs",
    placeholder: "ElevenLabs API key",
    desc: "Your custom and premium ElevenLabs voices",
  },
  {
    id: "openai",
    label: "OpenAI",
    placeholder: "OpenAI API key",
    desc: "Alloy, Nova, Shimmer and the other OpenAI voices",
  },
  {
    id: "speechify",
    label: "Speechify",
    placeholder: "Speechify API key",
    desc: "Speechify's Simba voices via your API key",
  },
  {
    id: "deepgram",
    label: "Deepgram",
    placeholder: "Deepgram API key",
    desc: "Deepgram's Aura voices via your API key",
  },
  {
    id: "cartesia",
    label: "Cartesia",
    placeholder: "Cartesia API key",
    desc: "Cartesia's Sonic voices via your API key",
  },
];

// Colors mirror the reader themes in src/reader/reader.css so each swatch is a
// true preview of the page surface. Default reads the live app page tokens.
const READER_THEMES: { id: ReaderTheme; label: string; bg: string; text: string }[] = [
  { id: "default", label: "Default", bg: "var(--page-bg)", text: "var(--page-text)" },
  { id: "paper", label: "Paper", bg: "#f4f1ea", text: "#2a2722" },
  { id: "sepia", label: "Sepia", bg: "#f0e6d2", text: "#433422" },
  { id: "slate", label: "Slate", bg: "#23262e", text: "#c9cfdb" },
  { id: "black", label: "Black", bg: "#000000", text: "#b8b8bf" },
];

/** Sections that expose a per-section "Reset" control in their header. */
const RESETTABLE_SECTIONS = new Set(["appearance", "reader", "playback", "shortcuts", "storage"]);

/* ================= small HTML builders ================= */

function groupHtml(head: string, rowsHtml: string, headExtra = ""): string {
  const headClass = headExtra ? "set__group-head set__group-head--row" : "set__group-head";
  const headContent = headExtra ? `<span>${escapeHtml(head)}</span>${headExtra}` : escapeHtml(head);
  return `<div class="set__group">
    <div class="${headClass}">${headContent}</div>
    <div class="card set-card">${rowsHtml}</div>
  </div>`;
}

function rowHtml(label: string, controlHtml: string, desc?: string): string {
  return `<div class="set-row">
    <div class="set-row__text">
      <div class="set-row__label">${escapeHtml(label)}</div>
      ${desc ? `<div class="set-row__desc">${escapeHtml(desc)}</div>` : ""}
    </div>
    <div class="set-row__control">${controlHtml}</div>
  </div>`;
}

function switchHtml(id: string, on: boolean): string {
  return `<input type="checkbox" class="switch" id="${id}" ${on ? "checked" : ""} />`;
}

function selectHtml(
  id: string,
  value: string,
  options: { value: string; label: string }[],
): string {
  return `<select class="select select--sm" id="${id}">${options
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}" ${o.value === value ? "selected" : ""}>${escapeHtml(o.label)}</option>`,
    )
    .join("")}</select>`;
}

function sliderHtml(
  id: string,
  min: number,
  max: number,
  step: number,
  value: number,
  valueText: string,
): string {
  return `<input type="range" class="slider set-slider" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" />
    <span class="set-slider-val" id="${id}-val">${escapeHtml(valueText)}</span>`;
}

function segHtml(
  active: string,
  options: { value: string; label: string }[],
  attr: string,
): string {
  return `<div class="set-seg">${options
    .map(
      (o) =>
        `<button type="button" class="set-seg__btn ${o.value === active ? "set-seg__btn--on" : ""}" ${attr}="${escapeHtml(o.value)}">${escapeHtml(o.label)}</button>`,
    )
    .join("")}</div>`;
}

function fontGridHtml(activeId: string): string {
  // "serif" and "sans" are valid ids in READER_FONTS (the legacy defaults), so
  // an exact id match is all we need to light the active card.
  const cards = READER_FONTS.map((f) => {
    const active = f.id === activeId;
    return `<button type="button" class="set-font-card ${active ? "set-font-card--active" : ""}" data-font="${escapeHtml(f.id)}" title="${escapeHtml(f.label)}" aria-pressed="${active}">
      <span class="set-font-card__ag" style="font-family: ${f.stack}">Ag</span>
      <span class="set-font-card__label">${escapeHtml(f.label)}</span>
    </button>`;
  }).join("");
  return `<div class="set-font-grid">${cards}</div>`;
}

function swatchesHtml(active: ReaderTheme): string {
  // Each swatch is a miniature page: the theme's real page background with an
  // "Aa" in the theme's real text color — a true preview of the reading surface.
  return `<div class="set-swatches">${READER_THEMES.map(
    (t) => `<button type="button" class="set-swatch ${t.id === active ? "set-swatch--active" : ""}" data-rtheme="${t.id}" title="${escapeHtml(t.label)}" aria-label="${escapeHtml(t.label)}" aria-pressed="${t.id === active}">
      <span class="set-swatch__page" style="background:${t.bg};color:${t.text}">
        <span class="set-swatch__aa">Aa</span>
      </span>
      <span class="set-swatch__label">${escapeHtml(t.label)}</span>
    </button>`,
  ).join("")}</div>`;
}

/** Section header: the big title plus, for resettable sections, a ghost Reset. */
function sectionHeadHtml(id: string, title: string): string {
  const reset = RESETTABLE_SECTIONS.has(id)
    ? `<button type="button" class="btn btn--sm btn--ghost" data-reset-section="${id}">Reset</button>`
    : "";
  return `<div class="set__head"><div class="set__title">${escapeHtml(title)}</div>${reset}</div>`;
}

/* ================= mount ================= */

export function mountSettings(el: HTMLElement, section?: string): SettingsView {
  const root = document.createElement("div");
  root.className = "set no-select";
  root.innerHTML = `
    <header class="set__topbar">
      <button type="button" class="btn btn--icon btn--ghost" id="set-back" title="Back to library" aria-label="Back to library">${icon.back}</button>
      <div class="set__topbar-title">Settings</div>
    </header>
    <div class="set__body">
      <nav class="set__sidebar" id="set-nav" aria-label="Settings sections"></nav>
      <main class="set__content" id="set-content"><div class="set__inner" id="set-inner"></div></main>
    </div>`;
  el.appendChild(root);

  const nav = root.querySelector<HTMLElement>("#set-nav")!;
  const inner = root.querySelector<HTMLElement>("#set-inner")!;
  const content = root.querySelector<HTMLElement>("#set-content")!;
  root.querySelector<HTMLButtonElement>("#set-back")!.addEventListener("click", () =>
    navigate({ view: "library" }),
  );

  nav.innerHTML = SECTIONS.map(
    (s) =>
      `<button type="button" class="set__nav-item" data-section="${s.id}"><span class="set__nav-icon">${s.icon}</span><span>${escapeHtml(s.label)}</span></button>`,
  ).join("");
  nav.querySelectorAll<HTMLButtonElement>("[data-section]").forEach((btn) => {
    btn.addEventListener("click", () => enterSection(btn.dataset.section!));
  });

  let active = section && SECTION_IDS.has(section) ? section : "appearance";
  let voicesDispose: (() => void) | null = null;

  // Async, section-scoped state.
  let cacheStats: CacheStats | null = null;
  let cacheStatsError = false;
  // Storage: whether the Custom cache-limit input is revealed.
  let customCacheOpen = false;
  // API keys, per provider: presence (null = still checking) and whether the
  // row is in "replace" (input) mode.
  const hasKey: Record<KeyProviderId, boolean | null> = {
    eleven: null,
    openai: null,
    speechify: null,
    deepgram: null,
    cartesia: null,
  };
  const keyReplacing: Record<KeyProviderId, boolean> = {
    eleven: false,
    openai: false,
    speechify: false,
    deepgram: false,
    cartesia: false,
  };

  // Shortcut-capture state (kept out of render so re-renders don't drop it).
  let capturing: ActionId | null = null;
  let captureCleanup: (() => void) | null = null;

  function updateSidebar(): void {
    nav.querySelectorAll<HTMLButtonElement>("[data-section]").forEach((btn) => {
      const on = btn.dataset.section === active;
      btn.classList.toggle("set__nav-item--active", on);
      if (on) btn.setAttribute("aria-current", "true");
      else btn.removeAttribute("aria-current");
    });
  }

  /* ---------------- section HTML ---------------- */

  function appearanceHtml(s: Settings): string {
    return (
      sectionHeadHtml("appearance", "Appearance") +
      groupHtml(
        "Theme",
        rowHtml(
          "App theme",
          segHtml(
            s.theme,
            [
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
              { value: "system", label: "System" },
            ],
            "data-theme",
          ),
        ),
      )
    );
  }

  function readerHtml(s: Settings): string {
    const r = s.reader;
    const text =
      `<div class="set-row set-row--stack">
        <div class="set-row__label">Font</div>
        ${fontGridHtml(r.font)}
      </div>` +
      rowHtml("Text size", sliderHtml("r-size", 13, 30, 1, r.fontSize, `${r.fontSize}px`)) +
      rowHtml(
        "Line spacing",
        sliderHtml("r-leading", 1.2, 2.4, 0.1, r.lineHeight, r.lineHeight.toFixed(1)),
      ) +
      rowHtml("Reading width", sliderHtml("r-width", 480, 1040, 40, r.width, `${r.width}px`)) +
      rowHtml("Justify text", switchHtml("r-justify", r.justify));
    const page = rowHtml("Reader theme", swatchesHtml(r.theme));
    return (
      sectionHeadHtml("reader", "Reader") +
      `<p class="set__lead">These apply to the reading page. You can also change them from the Aa menu while reading.</p>` +
      groupHtml("Text", text) +
      groupHtml("Page", page)
    );
  }

  function playbackHtml(s: Settings): string {
    const pb = s.playback;
    const audio =
      rowHtml(
        "Default speed",
        selectHtml(
          "p-rate",
          String(pb.rate),
          PLAYBACK_RATES.map((r) => ({ value: String(r), label: `${r}×` })),
        ),
      ) +
      rowHtml(
        "Volume",
        sliderHtml("p-vol", 0, 1, 0.05, pb.volume, `${Math.round(pb.volume * 100)}%`),
      ) +
      rowHtml(
        "Audio quality",
        selectHtml("p-quality", s.audioQuality, [
          { value: "standard", label: "Standard" },
          { value: "high", label: "High" },
        ]),
        "High synthesizes at a higher bitrate. Already-cached sentences re-synthesize at the new quality.",
      ) +
      rowHtml(
        "Highlight spoken text",
        selectHtml("p-hl", pb.highlight, [
          { value: "sentence", label: "Sentence" },
          { value: "word", label: "Word (where supported)" },
          { value: "off", label: "Off" },
        ]),
      ) +
      rowHtml("Auto-scroll while listening", switchHtml("p-auto", pb.autoScroll));
    const appBehavior =
      rowHtml(
        "Mini player",
        switchHtml("p-mini", s.miniPlayer),
        "Keep playing when you leave a book, with a compact player on the home screen. Off: leaving a book pauses it.",
      ) +
      rowHtml("Resume last item on launch", switchHtml("p-resume", s.resumeLastItem)) +
      rowHtml(
        "Keep playing when window closes",
        switchHtml("p-tray", s.closeToTray),
        "Playback continues in the tray when you close the window.",
      ) +
      rowHtml(
        "Notifications",
        switchHtml("p-notif", s.notifications),
        "Show a notification when playback moves to the background.",
      ) +
      rowHtml("Launch at startup", switchHtml("p-startup", s.launchAtStartup));
    return (
      sectionHeadHtml("playback", "Playback") +
      groupHtml("Audio", audio) +
      groupHtml("App behavior", appBehavior)
    );
  }

  function keyControlHtml(p: KeyProviderId, placeholder: string): string {
    const present = hasKey[p];
    if (present === null) {
      return `<span class="faint">Checking…</span>`;
    }
    if (present && !keyReplacing[p]) {
      return `<span class="set-key-mask mono">••••••••</span>
        <button type="button" class="btn btn--sm" data-k-replace="${p}">Replace</button>
        <button type="button" class="btn btn--sm btn--ghost" data-k-remove="${p}">Remove</button>`;
    }
    return `<input type="password" class="input set-key-input" data-k-input="${p}" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false" />
      <button type="button" class="btn btn--sm btn--primary" data-k-save="${p}">Save</button>
      ${present ? `<button type="button" class="btn btn--sm btn--ghost" data-k-cancel="${p}">Cancel</button>` : ""}`;
  }

  function keysHtml(): string {
    const groups = KEY_PROVIDERS.map((kp) =>
      groupHtml(kp.label, rowHtml("API key", keyControlHtml(kp.id, kp.placeholder), kp.desc)),
    ).join("");
    return (
      sectionHeadHtml("keys", "API keys") +
      `<p class="set__lead">Keys are stored in Windows Credential Manager, never in files or logs, and never leave this computer except to call the provider.</p>` +
      groups
    );
  }

  function shortcutsHtml(s: Settings): string {
    const conflicts = shortcutConflictSet(s.shortcuts);
    const dupes = [...conflicts];
    const warn = dupes.length
      ? `<div class="set-conflict-warn">${icon.warning}<span>Duplicate shortcuts: ${escapeHtml(
          dupes.join(", "),
        )}. The most recently bound action wins.</span></div>`
      : "";
    const rows = (Object.keys(ACTION_LABELS) as ActionId[])
      .map((action) => {
        const d = actionChordDisplay(s.shortcuts[action] ?? "", conflicts);
        const isCapturing = capturing === action;
        let chordHtml: string;
        if (isCapturing) {
          chordHtml = `<span class="set-capturing">Press keys…</span>`;
        } else if (d.keys.length) {
          chordHtml = d.keys
            .map((k) => `<kbd class="set-kbd">${escapeHtml(k)}</kbd>`)
            .join(`<span class="set-kbd-sep">+</span>`);
        } else {
          chordHtml = `<span class="faint">Not set</span>`;
        }
        return `<button type="button" class="set-sc ${d.conflict ? "set-sc--conflict" : ""} ${isCapturing ? "set-sc--capturing" : ""}" data-action="${action}">
          <span class="set-sc__label">${escapeHtml(ACTION_LABELS[action])}</span>
          <span class="set-sc__chord">${chordHtml}</span>
        </button>`;
      })
      .join("");
    return (
      sectionHeadHtml("shortcuts", "Shortcuts") +
      `<p class="set__lead">Click a shortcut, then press a new key combination. Esc cancels · Backspace resets to default.</p>
      ${warn}` +
      groupHtml("Reader & playback", `<div class="set-sc-list">${rows}</div>`)
    );
  }

  function storageHtml(s: Settings): string {
    let usage: string;
    if (cacheStatsError) usage = `<span class="faint">Couldn't read cache usage.</span>`;
    else if (cacheStats === null) usage = `<span class="faint">Reading usage…</span>`;
    else usage = `<span class="set-usage">${escapeHtml(cacheUsageLabel(cacheStats))}</span>`;
    const limitOptions = [
      ...CACHE_LIMIT_PRESETS.map((mb) => ({ value: String(mb), label: cacheLimitLabel(mb) })),
      { value: "unlimited", label: "Unlimited" },
      { value: "custom", label: "Custom" },
    ];
    const selValue = customCacheOpen ? "custom" : cacheLimitSelectValue(s.cacheLimitMB);
    const limitRow = rowHtml(
      "Cache limit",
      selectHtml("s-limit", selValue, limitOptions),
      "Unlimited keeps every synthesized clip; a size cap prunes the oldest audio automatically.",
    );
    const prefill = s.cacheLimitMB >= CACHE_CUSTOM_MIN ? s.cacheLimitMB : 1000;
    const customRow = customCacheOpen
      ? rowHtml(
          "Custom limit",
          `<input type="number" class="input set-cache-input" id="s-custom" min="${CACHE_CUSTOM_MIN}" max="${CACHE_CUSTOM_MAX}" step="10" value="${prefill}" />
            <span class="set-cache-unit">MB</span>
            <button type="button" class="btn btn--sm btn--primary" id="s-custom-apply">Apply</button>`,
          `Between ${CACHE_CUSTOM_MIN} MB and ${CACHE_CUSTOM_MAX.toLocaleString("en-US")} MB.`,
        )
      : "";
    const cacheGroup = groupHtml(
      "Audio cache",
      rowHtml("Used", usage) +
        limitRow +
        customRow +
        rowHtml(
          "Clear cache",
          `<button type="button" class="btn btn--sm" id="s-clear">Clear cache</button>`,
          "Delete all synthesized audio. It is re-created as you listen.",
        ),
    );
    const dataGroup = groupHtml(
      "Data",
      rowHtml(
        "Data folder",
        `<span class="set-path mono">%APPDATA%\\Tarotalking</span>`,
        "Library, imported content, and settings",
      ),
    );
    return sectionHeadHtml("storage", "Storage") + cacheGroup + dataGroup;
  }

  function aboutHtml(): string {
    return (
      sectionHeadHtml("about", "About") +
      groupHtml(
        "Tarotalking",
        `<div class="set-about">
          <div class="set-about__name">Tarotalking <span class="set-about__ver">0.5.0</span></div>
          <div class="set-about__desc">A fast, private text-to-speech reader for your books, articles, and notes.</div>
          <div class="set-about__tag faint">Built as a fast, private, offline-friendly reader.</div>
          <div class="set-about__license faint">Licensed under GPL-3.0.</div>
          <div class="set-about__actions"><button type="button" class="btn btn--sm btn--ghost" id="a-shortcuts">${icon.keyboard}Keyboard shortcuts</button></div>
        </div>`,
      )
    );
  }

  /* ---------------- render + wire (simple sections) ---------------- */

  function renderSimple(id: string): void {
    const s = settingsStore.get();
    if (id === "appearance") inner.innerHTML = appearanceHtml(s);
    else if (id === "reader") inner.innerHTML = readerHtml(s);
    else if (id === "playback") inner.innerHTML = playbackHtml(s);
    else if (id === "keys") inner.innerHTML = keysHtml();
    else if (id === "shortcuts") inner.innerHTML = shortcutsHtml(s);
    else if (id === "storage") inner.innerHTML = storageHtml(s);
    else if (id === "about") inner.innerHTML = aboutHtml();
    wireSimple(id);
  }

  function wireSimple(id: string): void {
    wireSectionReset();
    if (id === "appearance") {
      inner.querySelectorAll<HTMLButtonElement>("[data-theme]").forEach((btn) => {
        btn.addEventListener("click", () =>
          updateSettings({ theme: btn.dataset.theme as Settings["theme"] }),
        );
      });
    } else if (id === "reader") {
      wireReader();
    } else if (id === "playback") {
      wirePlayback();
    } else if (id === "keys") {
      wireKeys();
    } else if (id === "shortcuts") {
      wireShortcuts();
    } else if (id === "storage") {
      wireStorage();
    } else if (id === "about") {
      inner
        .querySelector<HTMLButtonElement>("#a-shortcuts")
        ?.addEventListener("click", () => enterSection("shortcuts"));
    }
  }

  function bindSlider(id: string, format: (v: number) => string, commit: (v: number) => void): void {
    const el = inner.querySelector<HTMLInputElement>(`#${id}`);
    const val = inner.querySelector<HTMLElement>(`#${id}-val`);
    if (!el) return;
    el.addEventListener("input", () => {
      if (val) val.textContent = format(Number(el.value));
    });
    el.addEventListener("change", () => commit(Number(el.value)));
  }

  function wireReader(): void {
    inner.querySelectorAll<HTMLButtonElement>("[data-font]").forEach((btn) => {
      // Paint each preview in its own font stack (belt-and-suspenders over the
      // inline style, so every "Ag" renders in — and reads as — that font).
      const ag = btn.querySelector<HTMLElement>(".set-font-card__ag");
      const f = READER_FONTS.find((x) => x.id === btn.dataset.font);
      if (ag && f) ag.style.fontFamily = f.stack;
      btn.addEventListener("click", () => updateReaderPrefs({ font: btn.dataset.font! }));
    });
    bindSlider("r-size", (v) => `${v}px`, (v) => updateReaderPrefs({ fontSize: v }));
    bindSlider("r-leading", (v) => v.toFixed(1), (v) => updateReaderPrefs({ lineHeight: v }));
    bindSlider("r-width", (v) => `${v}px`, (v) => updateReaderPrefs({ width: v }));
    inner.querySelector<HTMLInputElement>("#r-justify")?.addEventListener("change", (e) => {
      updateReaderPrefs({ justify: (e.target as HTMLInputElement).checked });
    });
    inner.querySelectorAll<HTMLButtonElement>("[data-rtheme]").forEach((btn) => {
      btn.addEventListener("click", () =>
        updateReaderPrefs({ theme: btn.dataset.rtheme as ReaderTheme }),
      );
    });
  }

  function wirePlayback(): void {
    inner.querySelector<HTMLSelectElement>("#p-rate")?.addEventListener("change", (e) => {
      updatePlaybackPrefs({ rate: Number((e.target as HTMLSelectElement).value) });
    });
    bindSlider("p-vol", (v) => `${Math.round(v * 100)}%`, (v) => updatePlaybackPrefs({ volume: v }));
    inner.querySelector<HTMLSelectElement>("#p-quality")?.addEventListener("change", (e) => {
      updateSettings({ audioQuality: (e.target as HTMLSelectElement).value as Settings["audioQuality"] });
    });
    inner.querySelector<HTMLSelectElement>("#p-hl")?.addEventListener("change", (e) => {
      updatePlaybackPrefs({ highlight: (e.target as HTMLSelectElement).value as Settings["playback"]["highlight"] });
    });
    inner.querySelector<HTMLInputElement>("#p-auto")?.addEventListener("change", (e) => {
      updatePlaybackPrefs({ autoScroll: (e.target as HTMLInputElement).checked });
    });
    inner.querySelector<HTMLInputElement>("#p-mini")?.addEventListener("change", (e) => {
      updateSettings({ miniPlayer: (e.target as HTMLInputElement).checked });
    });
    inner.querySelector<HTMLInputElement>("#p-resume")?.addEventListener("change", (e) => {
      updateSettings({ resumeLastItem: (e.target as HTMLInputElement).checked });
    });
    inner.querySelector<HTMLInputElement>("#p-tray")?.addEventListener("change", (e) => {
      updateSettings({ closeToTray: (e.target as HTMLInputElement).checked });
    });
    inner.querySelector<HTMLInputElement>("#p-notif")?.addEventListener("change", (e) => {
      updateSettings({ notifications: (e.target as HTMLInputElement).checked });
    });
    inner.querySelector<HTMLInputElement>("#p-startup")?.addEventListener("change", (e) => {
      const on = (e.target as HTMLInputElement).checked;
      updateSettings({ launchAtStartup: on });
      void applyAutostart(on);
    });
  }

  async function applyAutostart(on: boolean): Promise<void> {
    if (!inTauri) return;
    try {
      const { enable, disable } = await import("@tauri-apps/plugin-autostart");
      if (on) await enable();
      else await disable();
    } catch (e) {
      toast.error(`Couldn't ${on ? "enable" : "disable"} launch at startup: ${describeError(e)}`);
    }
  }

  /* ---------------- API keys ---------------- */

  async function loadHasKey(): Promise<void> {
    await Promise.all(
      KEY_PROVIDERS.map(async (kp) => {
        try {
          hasKey[kp.id] = await ipc.hasKey(kp.id);
        } catch {
          hasKey[kp.id] = false;
        }
      }),
    );
    if (active === "keys") renderSimple("keys");
  }

  function wireKeys(): void {
    inner.querySelectorAll<HTMLButtonElement>("[data-k-replace]").forEach((btn) => {
      const p = btn.dataset.kReplace as KeyProviderId;
      btn.addEventListener("click", () => {
        keyReplacing[p] = true;
        renderSimple("keys");
      });
    });
    inner.querySelectorAll<HTMLButtonElement>("[data-k-cancel]").forEach((btn) => {
      const p = btn.dataset.kCancel as KeyProviderId;
      btn.addEventListener("click", () => {
        keyReplacing[p] = false;
        renderSimple("keys");
      });
    });
    inner.querySelectorAll<HTMLButtonElement>("[data-k-remove]").forEach((btn) => {
      const p = btn.dataset.kRemove as KeyProviderId;
      const label = KEY_PROVIDERS.find((k) => k.id === p)!.label;
      btn.addEventListener("click", () => {
        confirmModal({
          title: "Remove API key?",
          message: `Tarotalking will no longer be able to use your ${label} voices until you add a key again.`,
          confirmLabel: "Remove key",
          danger: true,
          onConfirm: () => void removeKey(p),
        });
      });
    });
    inner.querySelectorAll<HTMLInputElement>("[data-k-input]").forEach((input) => {
      const p = input.dataset.kInput as KeyProviderId;
      const save = (): void => void saveKey(p, input.value);
      inner
        .querySelector<HTMLButtonElement>(`[data-k-save="${p}"]`)
        ?.addEventListener("click", save);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          save();
        }
      });
    });
  }

  /** Drop a provider's cached voice list after its key changes (live-list
   *  providers only; fixed-catalog providers keep their static list). */
  function invalidateVoiceCache(provider: KeyProviderId): void {
    if (provider === "eleven") invalidateElevenVoices();
    else if (provider === "speechify") invalidateSpeechifyVoices();
    else if (provider === "cartesia") invalidateCartesiaVoices();
  }

  async function saveKey(provider: KeyProviderId, raw: string): Promise<void> {
    const value = raw.trim();
    if (!value) {
      toast.error("Enter an API key first.");
      return;
    }
    try {
      await ipc.setKey(provider, value);
      // Providers with live (network-fetched) voice lists cache them, so a new
      // key must drop that cache. OpenAI/Deepgram are fixed catalogs — no-op.
      invalidateVoiceCache(provider);
      hasKey[provider] = true;
      keyReplacing[provider] = false;
      if (active === "keys") renderSimple("keys");
      toast.info("Key saved");
    } catch (e) {
      toast.error(`Couldn't save the key: ${describeError(e)}`);
    }
  }

  async function removeKey(provider: KeyProviderId): Promise<void> {
    try {
      await ipc.deleteKey(provider);
      invalidateVoiceCache(provider);
      hasKey[provider] = false;
      keyReplacing[provider] = false;
      if (active === "keys") renderSimple("keys");
      toast.info("Key removed");
    } catch (e) {
      toast.error(`Couldn't remove the key: ${describeError(e)}`);
    }
  }

  /* ---------------- storage ---------------- */

  async function loadCacheStats(): Promise<void> {
    try {
      cacheStats = await ipc.cacheStats();
      cacheStatsError = false;
    } catch {
      cacheStats = null;
      cacheStatsError = true;
    }
    if (active === "storage") renderSimple("storage");
  }

  /** Persist a cache limit (0 = unlimited) and enforce it in the backend. */
  function applyCacheLimit(mb: number): void {
    updateSettings({ cacheLimitMB: mb });
    void ipc.cachePrune(mb === 0 ? 0 : mb * 1e6).catch(() => {});
  }

  function wireStorage(): void {
    inner.querySelector<HTMLSelectElement>("#s-limit")?.addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v === "custom") {
        // Reveal the number input; nothing is committed until Apply.
        customCacheOpen = true;
        renderSimple("storage");
        return;
      }
      customCacheOpen = false;
      applyCacheLimit(v === "unlimited" ? 0 : Number(v));
    });
    const customInput = inner.querySelector<HTMLInputElement>("#s-custom");
    const applyCustom = (): void => {
      if (!customInput) return;
      customCacheOpen = true;
      applyCacheLimit(clampCustomCacheLimit(Number(customInput.value)));
    };
    inner.querySelector<HTMLButtonElement>("#s-custom-apply")?.addEventListener("click", applyCustom);
    customInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        applyCustom();
      }
    });
    inner.querySelector<HTMLButtonElement>("#s-clear")?.addEventListener("click", () => {
      confirmModal({
        title: "Clear audio cache?",
        message: "All synthesized audio is deleted. It is re-created as you listen again.",
        confirmLabel: "Clear cache",
        onConfirm: () => void clearCache(),
      });
    });
  }

  async function clearCache(): Promise<void> {
    try {
      await ipc.cacheClear();
      toast.info("Audio cache cleared");
    } catch (e) {
      toast.error(`Couldn't clear the cache: ${describeError(e)}`);
    }
    await loadCacheStats();
  }

  /* ---------------- shortcut capture ---------------- */

  function wireShortcuts(): void {
    inner.querySelectorAll<HTMLButtonElement>(".set-sc").forEach((rowEl) => {
      const action = rowEl.dataset.action as ActionId;
      rowEl.addEventListener("click", () => beginCapture(action));
    });
  }

  /* ---------------- per-section reset ---------------- */

  /** Restore just the active section's slice of Settings to its defaults. */
  function resetSection(id: string): void {
    if (id === "appearance") {
      updateSettings({ theme: "dark" });
    } else if (id === "reader") {
      updateSettings({ reader: { ...DEFAULT_READER_PREFS } });
    } else if (id === "playback") {
      const wasAutostart = settingsStore.get().launchAtStartup;
      updateSettings({
        playback: { ...DEFAULT_PLAYBACK_PREFS },
        audioQuality: DEFAULT_SETTINGS.audioQuality,
        miniPlayer: DEFAULT_SETTINGS.miniPlayer,
        closeToTray: DEFAULT_SETTINGS.closeToTray,
        resumeLastItem: DEFAULT_SETTINGS.resumeLastItem,
        notifications: DEFAULT_SETTINGS.notifications,
        launchAtStartup: DEFAULT_SETTINGS.launchAtStartup,
      });
      if (wasAutostart !== DEFAULT_SETTINGS.launchAtStartup) {
        void applyAutostart(DEFAULT_SETTINGS.launchAtStartup);
      }
    } else if (id === "shortcuts") {
      updateSettings({ shortcuts: { ...DEFAULT_SHORTCUTS } });
    } else if (id === "storage") {
      // Reset the cap only — synthesized audio is left untouched.
      customCacheOpen = false;
      updateSettings({ cacheLimitMB: DEFAULT_SETTINGS.cacheLimitMB });
    }
  }

  function wireSectionReset(): void {
    const btn = inner.querySelector<HTMLButtonElement>("[data-reset-section]");
    if (!btn) return;
    const id = btn.dataset.resetSection!;
    const label = SECTIONS.find((s) => s.id === id)?.label ?? id;
    btn.addEventListener("click", () => {
      confirmModal({
        title: `Reset ${label}?`,
        message: "This returns these settings to their defaults.",
        confirmLabel: "Reset",
        onConfirm: () => resetSection(id),
      });
    });
  }

  function beginCapture(action: ActionId): void {
    if (capturing === action) return;
    endCapture();
    capturing = action;
    renderSimple("shortcuts");

    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        endCapture();
        renderSimple("shortcuts");
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        const cur = settingsStore.get().shortcuts;
        capturing = null;
        captureCleanup?.();
        captureCleanup = null;
        updateSettings({ shortcuts: { ...cur, [action]: DEFAULT_SHORTCUTS[action] } });
        return;
      }
      const chord = chordOf(e);
      if (!chord) return; // modifier-only press: keep waiting
      const cur = settingsStore.get().shortcuts;
      capturing = null;
      captureCleanup?.();
      captureCleanup = null;
      updateSettings({ shortcuts: { ...cur, [action]: chord } });
    };

    window.addEventListener("keydown", onKey, true);
    captureCleanup = () => window.removeEventListener("keydown", onKey, true);
  }

  function endCapture(): void {
    capturing = null;
    captureCleanup?.();
    captureCleanup = null;
  }

  /* ---------------- section routing ---------------- */

  function enterSection(id: string): void {
    if (voicesDispose) {
      voicesDispose();
      voicesDispose = null;
    }
    endCapture();
    for (const kp of KEY_PROVIDERS) keyReplacing[kp.id] = false;
    active = id;
    updateSidebar();
    content.scrollTop = 0;

    if (id === "voices") {
      inner.innerHTML = "";
      const view = mountVoices(inner, { goToSection: enterSection });
      voicesDispose = view.dispose;
      return;
    }

    if (id === "storage") {
      cacheStats = null;
      cacheStatsError = false;
      // Open Custom mode up-front when the stored value isn't a preset/unlimited.
      customCacheOpen = isCustomCacheLimit(settingsStore.get().cacheLimitMB);
    }
    renderSimple(id);
    if (id === "storage") {
      void loadCacheStats();
    } else if (id === "keys") {
      for (const kp of KEY_PROVIDERS) hasKey[kp.id] = null;
      void loadHasKey();
    }
  }

  /* ---------------- live settings updates ---------------- */

  const unsubscribe = settingsStore.subscribe(() => {
    // Mid-capture: the capture listener owns the DOM; a re-render would drop the
    // "Press keys…" row. Voices and API keys self-manage (async state / a live
    // text field) so we never blow them away from here.
    if (capturing) return;
    if (active === "voices" || active === "keys") return;
    renderSimple(active);
  });

  enterSection(active);

  return {
    dispose() {
      unsubscribe();
      endCapture();
      if (voicesDispose) {
        voicesDispose();
        voicesDispose = null;
      }
      root.remove();
    },
  };
}
