// The "Export audiobook" dialog: pick a voice (grouped by the providers that
// are actually available) and a destination folder, see the estimated output
// size, then hand the choice back to the library view. This module only
// collects the user's choices — building chapter payloads, the per-card
// progress overlay, and the exportAudiobook IPC call all live in library.ts.

import { describeError } from "../core/ipc";
import { escapeHtml, formatBytes, formatTimeLeft, listeningMinutes } from "../core/format";
import { settingsStore } from "../core/session";
import { audioBytesPerSecond, PROVIDER_LABELS, SPEAKING_WPM } from "../core/types";
import type { LibraryItem, ProviderId, VoiceInfo, VoiceRef } from "../core/types";
import { allProviders } from "../player/providers/provider";
import { trapTab } from "../ui/focus";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";

/** BYO-key cloud providers — exporting a whole book with one spends the user's
 *  own API credits, so the dialog warns before they commit. Kept local (a tiny
 *  set) to avoid pulling the settings module's graph into the library view. */
const CREDIT_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "eleven",
  "openai",
  "speechify",
  "deepgram",
  "cartesia",
]);

interface VoiceGroup {
  provider: ProviderId;
  label: string;
  voices: VoiceInfo[];
}

export interface ExportChoice {
  voice: VoiceRef;
  destDir: string;
}

/** Middle-truncate a long path so both ends stay readable ("C:\a…\book"). */
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

export function openExportDialog(opts: {
  item: LibraryItem;
  /** Non-null when another audio job is running: Export is disabled and this
   *  reason is shown. */
  busyReason: string | null;
  onExport: (choice: ExportChoice) => void;
}): void {
  const { item, busyReason, onExport } = opts;
  const quality = settingsStore.get().audioQuality;

  let destDir: string | null = null;
  let voiceGroups: VoiceGroup[] = [];
  let closed = false;

  const chapters = item.chapterCount;
  const chapterPart = `${chapters} ${chapters === 1 ? "chapter" : "chapters"}`;
  const mins = listeningMinutes(item.wordCount, 1);
  const timePart = item.wordCount > 0 && mins >= 1 ? ` · about ${formatTimeLeft(mins)}` : "";
  const bookLine = `${item.title} · ${chapterPart}${timePart}`;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal lib-modal" role="dialog" aria-modal="true" aria-label="Export audiobook">
      <div class="modal__header">Export audiobook<button class="btn btn--ghost btn--icon lib-modal__x" data-close type="button">${icon.x}</button></div>
      <div class="modal__body">
        <div class="lib-modal__text">${escapeHtml(bookLine)}</div>
        <div class="field">
          <label for="exp-voice">Voice</label>
          <select class="select" id="exp-voice" disabled><option>Loading voices…</option></select>
        </div>
        <div class="lib-modal__hint" data-info></div>
        <div class="lib-modal__text" data-credit hidden></div>
        <div class="lib-modal__hint">Files play at normal speed — set listening speed in your player app.</div>
        <div class="field">
          <label>Save to</label>
          <div style="display:flex; align-items:center; gap: var(--sp-3); flex-wrap: wrap;">
            <button class="btn btn--sm" data-choose type="button">${icon.folder}Choose folder</button>
            <span class="lib-modal__hint" style="min-width:0;" data-path>No folder chosen</span>
          </div>
        </div>
        ${busyReason ? `<div class="lib-modal__text" data-busy>${escapeHtml(busyReason)}</div>` : ""}
      </div>
      <div class="modal__footer">
        <button class="btn" data-close type="button">Cancel</button>
        <button class="btn btn--primary" data-export type="button" disabled>Export</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const release = trapTab(backdrop);

  const sel = backdrop.querySelector<HTMLSelectElement>("#exp-voice")!;
  const infoEl = backdrop.querySelector<HTMLElement>("[data-info]")!;
  const creditEl = backdrop.querySelector<HTMLElement>("[data-credit]")!;
  const pathEl = backdrop.querySelector<HTMLElement>("[data-path]")!;
  const chooseBtn = backdrop.querySelector<HTMLButtonElement>("[data-choose]")!;
  const exportBtn = backdrop.querySelector<HTMLButtonElement>("[data-export]")!;

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    release();
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
  };
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));

  function selectedProvider(): ProviderId | null {
    const i = sel.value.indexOf("|");
    return i > 0 ? (sel.value.slice(0, i) as ProviderId) : null;
  }

  function updateInfo(): void {
    const qLabel = quality === "high" ? "High quality" : "Standard quality";
    const provider = selectedProvider();
    if (!provider) {
      infoEl.textContent = `${qLabel} — change in Settings`;
      creditEl.hidden = true;
      return;
    }
    const bytes = Math.round(
      (Math.max(0, item.wordCount) / SPEAKING_WPM) * 60 * audioBytesPerSecond(provider, quality),
    );
    infoEl.textContent = `${qLabel} — change in Settings · about ${formatBytes(bytes)}`;
    if (CREDIT_PROVIDERS.has(provider)) {
      creditEl.textContent = `Exporting a whole book spends your ${PROVIDER_LABELS[provider]} API credits.`;
      creditEl.hidden = false;
    } else {
      creditEl.hidden = true;
    }
  }

  function updateExportEnabled(): void {
    exportBtn.disabled = !!busyReason || !destDir || voiceGroups.length === 0;
  }

  updateInfo();
  updateExportEnabled();

  chooseBtn.addEventListener("click", () => {
    void (async () => {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const picked = await open({ directory: true });
        if (closed || typeof picked !== "string") return;
        destDir = picked;
        pathEl.textContent = truncateMiddle(picked, 52);
        pathEl.title = picked;
        updateExportEnabled();
      } catch (e) {
        toast.error(describeError(e));
      }
    })();
  });

  sel.addEventListener("change", updateInfo);

  exportBtn.addEventListener("click", () => {
    if (exportBtn.disabled) return;
    const provider = selectedProvider();
    const i = sel.value.indexOf("|");
    if (!provider || i < 0 || !destDir) return;
    const id = sel.value.slice(i + 1);
    close();
    onExport({ voice: { provider, id }, destDir });
  });

  // Load the available providers' voices, grouped, then default to the item's
  // remembered voice (else the global default). Providers that aren't ready
  // (no key / not installed / offline) never appear.
  void (async () => {
    const groups = (
      await Promise.all(
        allProviders().map(async (p): Promise<VoiceGroup | null> => {
          try {
            const av = await p.availability();
            if (!av.ok) return null;
            const voices = await p.voices();
            return voices.length ? { provider: p.id, label: p.label, voices } : null;
          } catch {
            return null;
          }
        }),
      )
    ).filter((g): g is VoiceGroup => g !== null);
    if (closed) return;

    voiceGroups = groups;
    if (groups.length === 0) {
      sel.innerHTML = `<option>No voices available</option>`;
      updateExportEnabled();
      return;
    }

    const def = item.voice ?? settingsStore.get().playback.voice;
    let defaultValue: string | null = null;
    sel.innerHTML = groups
      .map((g) => {
        const options = g.voices
          .map((v) => {
            const value = `${g.provider}|${v.id}`;
            if (def && def.provider === g.provider && def.id === v.id) defaultValue = value;
            return `<option value="${escapeHtml(value)}">${escapeHtml(v.name)}</option>`;
          })
          .join("");
        return `<optgroup label="${escapeHtml(g.label)}">${options}</optgroup>`;
      })
      .join("");
    sel.disabled = false;
    if (defaultValue) sel.value = defaultValue; // else the first option stands
    updateInfo();
    updateExportEnabled();
    requestAnimationFrame(() => {
      if (!closed) sel.focus();
    });
  })();
}
