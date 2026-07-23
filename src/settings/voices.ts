// The Voices section — the centerpiece of Settings. A default-voice chooser at
// the top, then one card per TTS provider (in allProviders() order). The Local
// voices (Piper) card is a full download manager: engine binary + per-model
// download / progress / remove, wired to piperInstall* / piperRemove* with live
// progress from the download-progress event.

import type { UnlistenFn } from "@tauri-apps/api/event";
import { escapeHtml } from "../core/format";
import { describeError, ipc, onDownloadProgress, type DownloadProgress } from "../core/ipc";
import { settingsStore, updatePlaybackPrefs } from "../core/session";
import { subscribeSelect } from "../core/store";
import { PROVIDER_LABELS } from "../core/types";
import type { PiperStatus, VoiceInfo, VoiceRef } from "../core/types";
import {
  allProviders,
  getProvider,
  type ProviderAvailability,
  type TtsProvider,
} from "../player/providers/provider";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";
import { confirmModal, openModal, type ModalHandle } from "./settings";

export interface VoicesCtx {
  goToSection(id: string): void;
}

/* ================= pure helpers (unit-tested) ================= */

/** Download task id for the piper engine binary. */
export const PIPER_BINARY_TASK = "piper-binary";

/** Download task id for a piper model. */
export function piperModelTask(id: string): string {
  return `piper-model-${id}`;
}

/** True when a download task id belongs to `base` — the model/binary itself or
 *  its `-cfg` companion (the config file downloads under a sibling task). */
export function taskMatches(taskId: string, base: string): boolean {
  return taskId === base || taskId === `${base}-cfg`;
}

/** Normalize any piper download task id back to its owning row's base id, or
 *  null when the task isn't a piper task. */
export function piperTaskBase(taskId: string): string | null {
  if (taskMatches(taskId, PIPER_BINARY_TASK)) return PIPER_BINARY_TASK;
  if (taskId.startsWith("piper-model-")) {
    return taskId.endsWith("-cfg") ? taskId.slice(0, -4) : taskId;
  }
  return null;
}

export function isHighQuality(quality: string): boolean {
  return quality.toLowerCase() === "high";
}

/** "high" → "high quality"; "" → "voice". */
export function qualityLabel(quality: string): string {
  const q = quality.trim().toLowerCase();
  return q ? `${q} quality` : "voice";
}

/** Piper sizes come as whole MB. "21 MB", "63 MB", "1.5 GB". */
export function formatMB(mb: number): string {
  if (!Number.isFinite(mb) || mb < 0) return "—";
  if (mb >= 1024) {
    const g = mb / 1024;
    return `${g >= 10 ? Math.round(g) : Number(g.toFixed(1))} GB`;
  }
  return `${Math.round(mb)} MB`;
}

/** Primary/secondary lines for the "Default voice" row. */
export function defaultVoiceLabel(
  voice: VoiceRef | null,
  name: string | null,
): { primary: string; secondary: string } {
  if (!voice) return { primary: "Automatic", secondary: "The best available voice is chosen for you" };
  return { primary: name || voice.id, secondary: PROVIDER_LABELS[voice.provider] };
}

/** Percentage of a download, clamped 0..100 (null total = indeterminate). */
export function downloadPct(received: number, total: number | null): number | null {
  if (!total || total <= 0) return null;
  return Math.max(0, Math.min(100, (received / total) * 100));
}

/* ================= descriptions ================= */

const PROVIDER_DESC: Record<string, string> = {
  edge: "Free Microsoft neural voices. Requires internet.",
  system: "Voices installed in Windows. Always available, fully offline.",
  piper: "Downloadable neural voices that run fully offline on your PC.",
  eleven: "Your ElevenLabs voices via your API key.",
};

/* ================= mount ================= */

export function mountVoices(container: HTMLElement, ctx: VoicesCtx): { dispose(): void } {
  let disposed = false;

  // Piper download-manager state.
  const progress = new Map<string, DownloadProgress>(); // base task id → latest
  let piper: PiperStatus | null = null;
  let piperError = false;
  let piperPath: string | null = null;
  let piperCard: HTMLElement | null = null;

  // Default-voice display.
  let defaultVoiceName: string | null = null;

  let chooser: ModalHandle | null = null;

  // Download-progress subscription.
  let unlisten: UnlistenFn | null = null;
  let unlistened = false;

  container.innerHTML = `
    <div class="set__title">Voices</div>
    <p class="set__lead">Pick the voice used when reading aloud, and manage downloadable local voices.</p>
    <div class="set__group" id="v-default"></div>
    <div class="set__cards" id="v-cards"></div>`;
  const defaultSlot = container.querySelector<HTMLElement>("#v-default")!;
  const cardsSlot = container.querySelector<HTMLElement>("#v-cards")!;

  /* ---------------- default-voice row ---------------- */

  function renderDefault(): void {
    const voice = settingsStore.get().playback.voice;
    const d = defaultVoiceLabel(voice, defaultVoiceName);
    defaultSlot.innerHTML = `
      <div class="set__group-head">Default voice</div>
      <div class="card set-card">
        <div class="set-row">
          <div class="set-row__text">
            <div class="set-voice-name">${escapeHtml(d.primary)}</div>
            <div class="set-voice-sub">${escapeHtml(d.secondary)}</div>
          </div>
          <div class="set-row__control">
            <button type="button" class="btn btn--sm" id="v-change">Change</button>
          </div>
        </div>
      </div>`;
    defaultSlot.querySelector<HTMLButtonElement>("#v-change")?.addEventListener("click", openChooser);
  }

  async function resolveDefaultVoiceName(): Promise<void> {
    const voice = settingsStore.get().playback.voice;
    if (!voice) {
      defaultVoiceName = null;
      renderDefault();
      return;
    }
    try {
      const voices = await getProvider(voice.provider).voices();
      if (disposed) return;
      defaultVoiceName = voices.find((v) => v.id === voice.id)?.name ?? voice.id;
    } catch {
      defaultVoiceName = voice.id;
    }
    if (!disposed) renderDefault();
  }

  /* ---------------- provider cards ---------------- */

  function providerHeaderHtml(label: string): string {
    return `<div class="set-provider-head">
      <div class="set-provider-title">${escapeHtml(label)}</div>
      <div class="set-chip set-chip--pending" data-chip><span class="set-chip__dot"></span>Checking…</div>
    </div>`;
  }

  function applyChip(chip: HTMLElement, av: ProviderAvailability): void {
    chip.classList.remove("set-chip--pending", "set-chip--ok", "set-chip--muted");
    if (av.ok) {
      chip.classList.add("set-chip--ok");
      chip.innerHTML = `<span class="set-chip__dot"></span>Ready`;
    } else {
      chip.classList.add("set-chip--muted");
      chip.textContent = av.reason ?? "Unavailable";
    }
  }

  function buildInfoCard(card: HTMLElement, provider: TtsProvider): void {
    const withCount = provider.id === "edge";
    const manageKey = provider.id === "eleven";
    card.innerHTML = `
      ${providerHeaderHtml(provider.label)}
      <div class="set-provider-desc">${escapeHtml(PROVIDER_DESC[provider.id] ?? "")}${
        withCount ? ` <span class="set-provider-count" data-count></span>` : ""
      }</div>
      ${manageKey ? `<div class="set-provider-actions"><button type="button" class="btn btn--sm btn--ghost" data-managekey>Manage key</button></div>` : ""}`;

    const chip = card.querySelector<HTMLElement>("[data-chip]")!;
    void provider
      .availability()
      .then((av) => {
        if (!disposed) applyChip(chip, av);
      })
      .catch(() => {
        if (!disposed) applyChip(chip, { ok: false, reason: "Unavailable" });
      });

    if (withCount) {
      void provider
        .voices()
        .then((vs) => {
          if (disposed) return;
          const el = card.querySelector<HTMLElement>("[data-count]");
          if (el) el.textContent = `· ${vs.length} ${vs.length === 1 ? "voice" : "voices"}`;
        })
        .catch(() => {});
    }
    if (manageKey) {
      card
        .querySelector<HTMLButtonElement>("[data-managekey]")
        ?.addEventListener("click", () => ctx.goToSection("keys"));
    }
  }

  /* ---------------- piper download manager ---------------- */

  function progressCtrlHtml(base: string, dl: DownloadProgress): string {
    const pct = downloadPct(dl.received, dl.total);
    const indeterminate = pct === null ? "progress--indeterminate" : "";
    const width = pct === null ? 100 : pct;
    const pctText = pct === null ? "…" : `${Math.round(pct)}%`;
    return `<div class="set-model-ctrl set-model-ctrl--progress">
      <div class="progress ${indeterminate}" data-progress="${base}"><div class="progress__fill" style="width:${width}%"></div></div>
      <span class="set-model-pct" data-progress-pct="${base}">${pctText}</span>
    </div>`;
  }

  function binaryRowHtml(status: PiperStatus): string {
    const dl = progress.get(PIPER_BINARY_TASK);
    const info = (meta: string): string =>
      `<div class="set-model-info"><div class="set-model-name">Voice engine</div><div class="set-model-meta">${escapeHtml(meta)}</div></div>`;
    if (dl) {
      return `<div class="set-model-row">${info("Downloading…")}${progressCtrlHtml(PIPER_BINARY_TASK, dl)}</div>`;
    }
    if (status.binaryInstalled) {
      return `<div class="set-model-row">${info(`${formatMB(status.binarySizeMB)} · installed`)}<div class="set-model-ctrl set-model-ctrl--done">${icon.check}<span>Installed</span></div></div>`;
    }
    return `<div class="set-model-row">${info(`Required for local voices · ${formatMB(status.binarySizeMB)}`)}<div class="set-model-ctrl"><button type="button" class="btn btn--sm btn--primary" data-binary-dl>${icon.download}Download</button></div></div>`;
  }

  function modelRowHtml(m: PiperStatus["models"][number], binaryInstalled: boolean): string {
    const base = piperModelTask(m.id);
    const dl = progress.get(base);
    const badge = `<span class="badge ${isHighQuality(m.quality) ? "badge--accent" : ""}">${escapeHtml(qualityLabel(m.quality))}</span>`;
    const info = `<div class="set-model-info">
      <div class="set-model-name">${escapeHtml(m.name)} ${badge}</div>
      <div class="set-model-meta">${escapeHtml(m.locale)} · ${escapeHtml(formatMB(m.sizeMB))}</div>
    </div>`;
    let ctrl: string;
    if (dl) {
      ctrl = progressCtrlHtml(base, dl);
    } else if (m.installed) {
      ctrl = `<div class="set-model-ctrl"><span class="set-model-installed" title="Installed">${icon.check}</span><button type="button" class="btn btn--sm btn--ghost set-danger-hover" data-model-remove="${escapeHtml(m.id)}">Remove</button></div>`;
    } else {
      ctrl = `<div class="set-model-ctrl"><button type="button" class="btn btn--sm" data-model-dl="${escapeHtml(m.id)}" ${binaryInstalled ? "" : 'disabled title="Download the voice engine first"'}>${icon.download}Download</button></div>`;
    }
    return `<div class="set-model-row">${info}${ctrl}</div>`;
  }

  function storageFooterHtml(): string {
    const pathText = piperPath ? `Stored in ${escapeHtml(piperPath)}` : "Local voices folder";
    return `<div class="set-voice-storage">
      <span class="set-voice-path mono" title="${escapeHtml(piperPath ?? "")}">${pathText}</span>
      <div class="set-voice-storage__actions">
        <button type="button" class="btn btn--sm btn--ghost" data-open-folder ${piperPath ? "" : "disabled"}>Open folder</button>
        <button type="button" class="btn btn--sm btn--ghost set-danger-hover" data-remove-all>Remove all</button>
      </div>
    </div>`;
  }

  function renderPiper(card: HTMLElement): void {
    let html = providerHeaderHtml(PROVIDER_LABELS.piper);
    html += `<div class="set-provider-desc">${escapeHtml(PROVIDER_DESC.piper ?? "")}</div>`;
    if (piperError) {
      html += `<div class="set-voice-reason">Couldn't read local voice status.</div>`;
    } else if (!piper) {
      html += `<div class="set-voice-loading">${icon.refresh}<span>Loading…</span></div>`;
    } else {
      html += binaryRowHtml(piper);
      html += `<div class="set-model-list">${piper.models
        .map((m) => modelRowHtml(m, piper!.binaryInstalled))
        .join("")}</div>`;
      html += storageFooterHtml();
    }
    card.innerHTML = html;

    // Availability chip, derived from status to avoid a second IPC round-trip.
    const chip = card.querySelector<HTMLElement>("[data-chip]");
    if (chip) {
      if (piperError) applyChip(chip, { ok: false, reason: "Unavailable" });
      else if (!piper) {
        /* keep pending */
      } else if (piper.binaryInstalled && piper.models.some((m) => m.installed)) {
        applyChip(chip, { ok: true });
      } else {
        applyChip(chip, { ok: false, reason: "No voice downloaded yet" });
      }
    }

    card
      .querySelector<HTMLButtonElement>("[data-binary-dl]")
      ?.addEventListener("click", () =>
        void startDownload(PIPER_BINARY_TASK, "Voice engine", () => ipc.piperInstallBinary()),
      );
    card.querySelectorAll<HTMLButtonElement>("[data-model-dl]").forEach((btn) => {
      const id = btn.dataset.modelDl!;
      btn.addEventListener("click", () =>
        void startDownload(piperModelTask(id), "Voice", () => ipc.piperInstallModel(id)),
      );
    });
    card.querySelectorAll<HTMLButtonElement>("[data-model-remove]").forEach((btn) => {
      const id = btn.dataset.modelRemove!;
      btn.addEventListener("click", () => void removeModel(id));
    });
    card.querySelector<HTMLButtonElement>("[data-open-folder]")?.addEventListener("click", () => {
      if (piperPath) void ipc.showInFolder(piperPath).catch((e) => toast.error(describeError(e)));
    });
    card.querySelector<HTMLButtonElement>("[data-remove-all]")?.addEventListener("click", () => {
      confirmModal({
        title: "Remove all local voices?",
        message: "The voice engine and every downloaded model are deleted from this PC.",
        confirmLabel: "Remove all",
        danger: true,
        onConfirm: () => void removeAll(),
      });
    });
  }

  async function refreshPiper(): Promise<void> {
    try {
      piper = await ipc.piperStatus();
      piperError = false;
    } catch {
      piper = null;
      piperError = true;
    }
    if (!disposed && piperCard) renderPiper(piperCard);
  }

  async function loadPath(): Promise<void> {
    try {
      const dir = await ipc.piperDir();
      if (disposed) return;
      piperPath = dir;
      if (piperCard) renderPiper(piperCard);
    } catch {
      /* leave the placeholder */
    }
  }

  async function startDownload(
    base: string,
    label: string,
    run: () => Promise<void>,
  ): Promise<void> {
    // Optimistically show a progress row; events refine it, the command's
    // resolution (or a done/error event) clears it.
    progress.set(base, { taskId: base, label, received: 0, total: null, done: false, error: null });
    if (piperCard) renderPiper(piperCard);
    try {
      await run();
      if (progress.has(base)) {
        progress.delete(base);
        await refreshPiper();
      }
    } catch (e) {
      progress.delete(base);
      toast.error(describeError(e));
      await refreshPiper();
    }
  }

  async function removeModel(id: string): Promise<void> {
    try {
      await ipc.piperRemoveModel(id);
      toast.info("Voice removed");
    } catch (e) {
      toast.error(`Couldn't remove the voice: ${describeError(e)}`);
    }
    await refreshPiper();
  }

  async function removeAll(): Promise<void> {
    try {
      await ipc.piperRemoveAll();
      toast.info("Local voices removed");
    } catch (e) {
      toast.error(`Couldn't remove local voices: ${describeError(e)}`);
    }
    await refreshPiper();
  }

  function paintProgress(base: string, p: DownloadProgress): void {
    if (!piperCard) return;
    const wrap = piperCard.querySelector<HTMLElement>(`[data-progress="${base}"]`);
    if (!wrap) {
      renderPiper(piperCard);
      return;
    }
    const fill = wrap.querySelector<HTMLElement>(".progress__fill");
    const pctEl = piperCard.querySelector<HTMLElement>(`[data-progress-pct="${base}"]`);
    const pct = downloadPct(p.received, p.total);
    if (pct === null) {
      wrap.classList.add("progress--indeterminate");
      if (pctEl) pctEl.textContent = "…";
    } else {
      wrap.classList.remove("progress--indeterminate");
      if (fill) fill.style.width = `${pct}%`;
      if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
    }
  }

  function onProgress(p: DownloadProgress): void {
    if (disposed) return;
    const base = piperTaskBase(p.taskId);
    if (!base) return;
    if (p.error) {
      progress.delete(base);
      toast.error(p.error);
      void refreshPiper();
      return;
    }
    if (p.done) {
      progress.delete(base);
      void refreshPiper();
      return;
    }
    const had = progress.has(base);
    progress.set(base, p);
    if (had) paintProgress(base, p);
    else if (piperCard) renderPiper(piperCard);
  }

  /* ---------------- voice chooser modal ---------------- */

  function voiceOptionHtml(v: VoiceInfo, selected: boolean): string {
    return `<button type="button" class="set-voice-option ${selected ? "is-selected" : ""}" data-voice-id="${escapeHtml(v.id)}">
      <span class="set-voice-option__name">${escapeHtml(v.name)}</span>
      ${v.locale ? `<span class="badge set-voice-option__badge">${escapeHtml(v.locale)}</span>` : ""}
      ${v.gender ? `<span class="set-voice-option__gender">${escapeHtml(v.gender)}</span>` : ""}
      <span class="set-voice-option__check">${selected ? icon.check : ""}</span>
    </button>`;
  }

  async function loadChooserGroup(
    provider: TtsProvider,
    bodyEl: HTMLElement,
    close: () => void,
  ): Promise<void> {
    let reason = "Couldn't load voices";
    try {
      const av = await provider.availability();
      if (!bodyEl.isConnected) return;
      if (av.reason) reason = av.reason;
      if (!av.ok) {
        bodyEl.innerHTML = `<div class="set-voice-reason">${escapeHtml(av.reason ?? "Unavailable")}</div>`;
        return;
      }
      const voices = await provider.voices();
      if (!bodyEl.isConnected) return;
      if (voices.length === 0) {
        bodyEl.innerHTML = `<div class="set-voice-reason">No voices available.</div>`;
        return;
      }
      const current = settingsStore.get().playback.voice;
      bodyEl.innerHTML = voices
        .map((v) =>
          voiceOptionHtml(v, current?.provider === provider.id && current.id === v.id),
        )
        .join("");
      bodyEl.querySelectorAll<HTMLButtonElement>("[data-voice-id]").forEach((btn) => {
        const id = btn.dataset.voiceId!;
        btn.addEventListener("click", () => {
          const picked = voices.find((v) => v.id === id);
          defaultVoiceName = picked?.name ?? id;
          updatePlaybackPrefs({ voice: { provider: provider.id, id } });
          renderDefault();
          close();
        });
      });
    } catch {
      if (bodyEl.isConnected) {
        bodyEl.innerHTML = `<div class="set-voice-reason">${escapeHtml(reason)}</div>`;
      }
    }
  }

  function openChooser(): void {
    chooser = openModal({
      title: "Choose a voice",
      ariaLabel: "Choose a voice",
      onClose: () => {
        chooser = null;
      },
      build: (body, close) => {
        body.classList.add("set-voice-chooser");
        for (const provider of allProviders()) {
          const group = document.createElement("div");
          group.className = "set-voice-group";
          group.innerHTML = `<div class="set-voice-group-head">${escapeHtml(provider.label)}</div><div class="set-voice-group-body"><div class="set-voice-loading">${icon.refresh}<span>Loading…</span></div></div>`;
          body.appendChild(group);
          const groupBody = group.querySelector<HTMLElement>(".set-voice-group-body")!;
          void loadChooserGroup(provider, groupBody, close);
        }
      },
    });
  }

  /* ---------------- init ---------------- */

  renderDefault();
  void resolveDefaultVoiceName();

  for (const provider of allProviders()) {
    const card = document.createElement("div");
    card.className = "card set-provider-card";
    cardsSlot.appendChild(card);
    if (provider.id === "piper") {
      piperCard = card;
      renderPiper(card);
    } else {
      buildInfoCard(card, provider);
    }
  }
  void refreshPiper();
  void loadPath();

  void onDownloadProgress(onProgress).then((fn) => {
    if (unlistened) fn();
    else unlisten = fn;
  });

  const unsubVoice = subscribeSelect(
    settingsStore,
    (s) => s.playback.voice,
    () => {
      renderDefault();
      void resolveDefaultVoiceName();
    },
  );

  return {
    dispose() {
      disposed = true;
      unsubVoice();
      unlistened = true;
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      chooser?.close();
    },
  };
}
