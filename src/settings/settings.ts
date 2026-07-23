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
import { ACTION_LABELS, DEFAULT_SHORTCUTS, PLAYBACK_RATES } from "../core/types";
import { invalidateElevenVoices } from "../player/providers/eleven";
import { trapTab } from "../ui/focus";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";
import { mountVoices } from "./voices";

export interface SettingsView {
  dispose(): void | Promise<void>;
}

/* ================= pure helpers (unit-tested) ================= */

/** Cache-limit choices, in megabytes. */
export const CACHE_LIMIT_OPTIONS = [100, 200, 500, 1000, 2000] as const;

/** "100 MB", "1 GB", "2 GB" — GB above 1000 MB. */
export function cacheLimitLabel(mb: number): string {
  return mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB`;
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
  { id: "storage", label: "Storage & privacy", icon: icon.shield },
  { id: "about", label: "About", icon: icon.info },
];
const SECTION_IDS = new Set(SECTIONS.map((s) => s.id));

const READER_THEMES: { id: ReaderTheme; label: string; bg: string; text: string }[] = [
  { id: "default", label: "Default", bg: "var(--page-bg)", text: "var(--page-text)" },
  { id: "paper", label: "Paper", bg: "#f4f1ea", text: "#33302b" },
  { id: "sepia", label: "Sepia", bg: "#f3e6cf", text: "#5b4a33" },
  { id: "slate", label: "Slate", bg: "#2b303a", text: "#ced4de" },
  { id: "black", label: "Black", bg: "#000000", text: "#c7c7cf" },
];

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

function swatchesHtml(active: ReaderTheme): string {
  return `<div class="set-swatches">${READER_THEMES.map(
    (t) => `<button type="button" class="set-swatch ${t.id === active ? "set-swatch--active" : ""}" data-rtheme="${t.id}" title="${escapeHtml(t.label)}" aria-label="${escapeHtml(t.label)}" aria-pressed="${t.id === active}">
      <span class="set-swatch__page" style="background:${t.bg};color:${t.text}">
        <span class="set-swatch__line"></span>
        <span class="set-swatch__line set-swatch__line--short"></span>
      </span>
      <span class="set-swatch__label">${escapeHtml(t.label)}</span>
    </button>`,
  ).join("")}</div>`;
}

function staticRow(iconSvg: string, label: string, desc: string): string {
  return `<div class="set-row set-static-row">
    <span class="set-static-row__icon">${iconSvg}</span>
    <div class="set-row__text">
      <div class="set-row__label">${escapeHtml(label)}</div>
      <div class="set-row__desc">${escapeHtml(desc)}</div>
    </div>
  </div>`;
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
  let hasElevenKey: boolean | null = null;
  let keyReplacing = false;

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
      `<div class="set__title">Appearance</div>` +
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
      rowHtml(
        "Font",
        selectHtml("r-font", r.font === "sans" ? "sans" : "serif", [
          { value: "serif", label: "Serif" },
          { value: "sans", label: "Sans" },
        ]),
      ) +
      rowHtml("Text size", sliderHtml("r-size", 13, 30, 1, r.fontSize, `${r.fontSize}px`)) +
      rowHtml(
        "Line spacing",
        sliderHtml("r-leading", 1.2, 2.4, 0.1, r.lineHeight, r.lineHeight.toFixed(1)),
      ) +
      rowHtml("Reading width", sliderHtml("r-width", 480, 1040, 40, r.width, `${r.width}px`)) +
      rowHtml("Justify text", switchHtml("r-justify", r.justify));
    const page = rowHtml("Reader theme", swatchesHtml(r.theme));
    return (
      `<div class="set__title">Reader</div>
      <p class="set__lead">These apply to the reading page. You can also change them from the Aa menu while reading.</p>` +
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
        "Highlight spoken text",
        selectHtml("p-hl", pb.highlight, [
          { value: "sentence", label: "Sentence" },
          { value: "word", label: "Word (where supported)" },
          { value: "off", label: "Off" },
        ]),
      ) +
      rowHtml("Auto-scroll while listening", switchHtml("p-auto", pb.autoScroll));
    const appBehavior =
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
      `<div class="set__title">Playback</div>` +
      groupHtml("Audio", audio) +
      groupHtml("App behavior", appBehavior)
    );
  }

  function keysHtml(): string {
    let control: string;
    if (hasElevenKey === null) {
      control = `<span class="faint">Checking…</span>`;
    } else if (hasElevenKey && !keyReplacing) {
      control = `<span class="set-key-mask mono">••••••••</span>
        <button type="button" class="btn btn--sm" id="k-replace">Replace</button>
        <button type="button" class="btn btn--sm btn--ghost" id="k-remove">Remove</button>`;
    } else {
      control = `<input type="password" class="input set-key-input" id="k-input" placeholder="ElevenLabs API key" autocomplete="off" spellcheck="false" />
        <button type="button" class="btn btn--sm btn--primary" id="k-save">Save</button>
        ${hasElevenKey ? `<button type="button" class="btn btn--sm btn--ghost" id="k-cancel">Cancel</button>` : ""}`;
    }
    return (
      `<div class="set__title">API keys</div>
      <p class="set__lead">Keys are stored in Windows Credential Manager, never in files or logs, and never leave this computer except to call the provider.</p>` +
      groupHtml("ElevenLabs", rowHtml("API key", control))
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
      `<div class="set__title">Shortcuts</div>
      <p class="set__lead">Click a shortcut, then press a new key combination. Esc cancels · Backspace resets to default.</p>
      ${warn}` +
      groupHtml(
        "Reader & playback",
        `<div class="set-sc-list">${rows}</div>`,
        `<button type="button" class="btn btn--sm btn--ghost" id="sc-reset">Reset all</button>`,
      )
    );
  }

  function storageHtml(s: Settings): string {
    let usage: string;
    if (cacheStatsError) usage = `<span class="faint">Couldn't read cache usage.</span>`;
    else if (cacheStats === null) usage = `<span class="faint">Reading usage…</span>`;
    else usage = `<span class="set-usage">${escapeHtml(cacheUsageLabel(cacheStats))}</span>`;
    const cacheGroup = groupHtml(
      "Audio cache",
      rowHtml("Used", usage) +
        rowHtml(
          "Cache limit",
          selectHtml(
            "s-limit",
            String(s.cacheLimitMB),
            CACHE_LIMIT_OPTIONS.map((mb) => ({ value: String(mb), label: cacheLimitLabel(mb) })),
          ),
        ) +
        rowHtml(
          "Clear cache",
          `<button type="button" class="btn btn--sm" id="s-clear">Clear cache</button>`,
          "Delete all synthesized audio. It is re-created as you listen.",
        ),
    );
    const privacyGroup = groupHtml(
      "Privacy",
      staticRow(icon.shield, "No telemetry", "Tarotalking sends nothing about you anywhere.") +
        staticRow(
          icon.globe,
          "Direct fetches",
          "Web articles are fetched directly from the site you enter.",
        ) +
        staticRow(
          icon.folder,
          "Local library",
          "Your library lives on this PC, in %APPDATA%\\Tarotalking.",
        ),
    );
    const dataGroup = groupHtml(
      "Data",
      rowHtml("Data folder", `<span class="set-path mono">%APPDATA%\\Tarotalking</span>`),
    );
    return `<div class="set__title">Storage & privacy</div>` + cacheGroup + privacyGroup + dataGroup;
  }

  function aboutHtml(): string {
    return (
      `<div class="set__title">About</div>` +
      groupHtml(
        "Tarotalking",
        `<div class="set-about">
          <div class="set-about__name">Tarotalking <span class="set-about__ver">0.1.0</span></div>
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
    inner.querySelector<HTMLSelectElement>("#r-font")?.addEventListener("change", (e) => {
      updateReaderPrefs({ font: (e.target as HTMLSelectElement).value });
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
    inner.querySelector<HTMLSelectElement>("#p-hl")?.addEventListener("change", (e) => {
      updatePlaybackPrefs({ highlight: (e.target as HTMLSelectElement).value as Settings["playback"]["highlight"] });
    });
    inner.querySelector<HTMLInputElement>("#p-auto")?.addEventListener("change", (e) => {
      updatePlaybackPrefs({ autoScroll: (e.target as HTMLInputElement).checked });
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
    try {
      const has = await ipc.hasKey("eleven");
      hasElevenKey = has;
    } catch {
      hasElevenKey = false;
    }
    if (active === "keys") renderSimple("keys");
  }

  function wireKeys(): void {
    inner.querySelector<HTMLButtonElement>("#k-replace")?.addEventListener("click", () => {
      keyReplacing = true;
      renderSimple("keys");
    });
    inner.querySelector<HTMLButtonElement>("#k-cancel")?.addEventListener("click", () => {
      keyReplacing = false;
      renderSimple("keys");
    });
    inner.querySelector<HTMLButtonElement>("#k-remove")?.addEventListener("click", () => {
      confirmModal({
        title: "Remove API key?",
        message: "Tarotalking will no longer be able to use your ElevenLabs voices until you add a key again.",
        confirmLabel: "Remove key",
        danger: true,
        onConfirm: () => void removeKey(),
      });
    });
    const input = inner.querySelector<HTMLInputElement>("#k-input");
    const save = (): void => void saveKey(input?.value ?? "");
    inner.querySelector<HTMLButtonElement>("#k-save")?.addEventListener("click", save);
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
    });
  }

  async function saveKey(raw: string): Promise<void> {
    const value = raw.trim();
    if (!value) {
      toast.error("Enter an API key first.");
      return;
    }
    try {
      await ipc.setKey("eleven", value);
      invalidateElevenVoices();
      hasElevenKey = true;
      keyReplacing = false;
      if (active === "keys") renderSimple("keys");
      toast.info("Key saved");
    } catch (e) {
      toast.error(`Couldn't save the key: ${describeError(e)}`);
    }
  }

  async function removeKey(): Promise<void> {
    try {
      await ipc.deleteKey("eleven");
      invalidateElevenVoices();
      hasElevenKey = false;
      keyReplacing = false;
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

  function wireStorage(): void {
    inner.querySelector<HTMLSelectElement>("#s-limit")?.addEventListener("change", (e) => {
      const mb = Number((e.target as HTMLSelectElement).value);
      updateSettings({ cacheLimitMB: mb });
      void ipc.cachePrune(mb * 1e6).catch(() => {});
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
    inner.querySelector<HTMLButtonElement>("#sc-reset")?.addEventListener("click", () => {
      confirmModal({
        title: "Reset all shortcuts?",
        message: "Every keyboard shortcut returns to its default binding.",
        confirmLabel: "Reset all",
        onConfirm: () => updateSettings({ shortcuts: { ...DEFAULT_SHORTCUTS } }),
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
    keyReplacing = false;
    active = id;
    updateSidebar();
    content.scrollTop = 0;

    if (id === "voices") {
      inner.innerHTML = "";
      const view = mountVoices(inner, { goToSection: enterSection });
      voicesDispose = view.dispose;
      return;
    }

    renderSimple(id);
    if (id === "storage") {
      cacheStats = null;
      cacheStatsError = false;
      void loadCacheStats();
    } else if (id === "keys") {
      hasElevenKey = null;
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
