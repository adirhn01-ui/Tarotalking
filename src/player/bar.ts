// The player bar — compact transport surface embedded by the reader.
// Renders engine state only; every control calls into the engine.

import "./bar.css";
import { getItem } from "../core/library";
import { formatTimeLeft, listeningMinutes } from "../core/format";
import { settingsStore, updatePlaybackPrefs } from "../core/session";
import { subscribeSelect } from "../core/store";
import { PLAYBACK_RATES, PROVIDER_LABELS, type VoiceInfo, type VoiceRef } from "../core/types";
import { icon } from "../ui/icons";
import { showMenu, type MenuItem } from "../ui/menu";
import { toast } from "../ui/toast";
import { engine, engineState, sleepState } from "./engine";
import { allProviders } from "./providers/provider";

export interface PlayerBar {
  dispose(): void;
}

export function mountPlayerBar(host: HTMLElement): PlayerBar {
  const root = document.createElement("div");
  root.className = "pbar no-select";
  root.innerHTML = `
    <button class="btn btn--ghost pbar__voice" title="Voice">
      ${icon.headphones}<span class="pbar__voice-name">Voice</span>${icon.chevronDown}
    </button>
    <div class="pbar__transport">
      <button class="btn btn--ghost btn--icon" data-act="prevPara" title="Previous paragraph">${icon.skipBack}</button>
      <button class="btn btn--ghost btn--icon" data-act="prevSent" title="Previous sentence">${icon.prev}</button>
      <button class="btn btn--primary btn--icon btn--lg pbar__play" title="Play / pause">${icon.play}</button>
      <button class="btn btn--ghost btn--icon" data-act="nextSent" title="Next sentence">${icon.next}</button>
      <button class="btn btn--ghost btn--icon" data-act="nextPara" title="Next paragraph">${icon.skipFwd}</button>
    </div>
    <div class="pbar__seek">
      <input type="range" class="slider pbar__slider" min="0" max="1000" value="0" title="Position">
      <span class="pbar__time faint"></span>
    </div>
    <button class="btn btn--ghost btn--sm pbar__rate" title="Playback speed">1×</button>
    <button class="btn btn--ghost btn--icon btn--sm pbar__sleep" title="Sleep timer">${icon.sleep}</button>
    <div class="pbar__vol">
      <span class="pbar__vol-icon" title="Volume">${icon.volume}</span>
      <input type="range" class="slider pbar__vol-slider" min="0" max="100" title="Volume">
    </div>`;
  host.appendChild(root);

  const playBtn = root.querySelector<HTMLButtonElement>(".pbar__play")!;
  const voiceBtn = root.querySelector<HTMLButtonElement>(".pbar__voice")!;
  const voiceName = root.querySelector<HTMLElement>(".pbar__voice-name")!;
  const slider = root.querySelector<HTMLInputElement>(".pbar__slider")!;
  const timeEl = root.querySelector<HTMLElement>(".pbar__time")!;
  const rateBtn = root.querySelector<HTMLButtonElement>(".pbar__rate")!;
  const sleepBtn = root.querySelector<HTMLButtonElement>(".pbar__sleep")!;
  const volSlider = root.querySelector<HTMLInputElement>(".pbar__vol-slider")!;

  /* ---- transport ---- */
  playBtn.addEventListener("click", () => engine.toggle());
  root.querySelector('[data-act="prevPara"]')!.addEventListener("click", () => engine.prevParagraph());
  root.querySelector('[data-act="prevSent"]')!.addEventListener("click", () => engine.prevSentence());
  root.querySelector('[data-act="nextSent"]')!.addEventListener("click", () => engine.nextSentence());
  root.querySelector('[data-act="nextPara"]')!.addEventListener("click", () => engine.nextParagraph());

  /* ---- seek slider ---- */
  let dragging = false;
  slider.addEventListener("pointerdown", () => {
    dragging = true;
  });
  slider.addEventListener("change", () => {
    dragging = false;
    engine.seekToPct(Number(slider.value) / 1000);
  });
  slider.addEventListener("keydown", (e) => {
    // Keep arrow keys for sentence nav (reader shortcuts), not slider steps.
    e.preventDefault();
  });

  /* ---- volume ---- */
  volSlider.value = String(Math.round(settingsStore.get().playback.volume * 100));
  volSlider.addEventListener("input", () => {
    engine.setVolume(Number(volSlider.value) / 100);
  });

  /* ---- rate menu ---- */
  rateBtn.addEventListener("click", () => {
    const r = rateBtn.getBoundingClientRect();
    const current = settingsStore.get().playback.rate;
    showMenu(
      r.left,
      r.top - 8 - PLAYBACK_RATES.length * 30,
      PLAYBACK_RATES.map((rate) => ({
        label: `${rate}×${rate === current ? "  ✓" : ""}`,
        onSelect: () => engine.setRate(rate),
      })),
    );
  });

  /* ---- sleep menu ---- */
  sleepBtn.addEventListener("click", () => {
    const r = sleepBtn.getBoundingClientRect();
    const st = sleepState.get();
    const items: MenuItem[] = [
      { label: "In 15 minutes", onSelect: () => engine.startSleepTimer(15) },
      { label: "In 30 minutes", onSelect: () => engine.startSleepTimer(30) },
      { label: "In 60 minutes", onSelect: () => engine.startSleepTimer(60) },
      { label: "At end of chapter", onSelect: () => engine.startSleepTimer("chapter") },
    ];
    if (st.until !== null || st.endOfChapter) {
      items.push({ label: "Turn off sleep timer", danger: true, onSelect: () => engine.cancelSleepTimer() });
    }
    showMenu(r.left, r.top - 8 - items.length * 30, items);
  });

  /* ---- voice menu ---- */
  let knownVoices: VoiceInfo[] = [];
  voiceBtn.addEventListener("click", () => {
    void openVoiceMenu();
  });

  async function openVoiceMenu(): Promise<void> {
    const r = voiceBtn.getBoundingClientRect();
    const current = settingsStore.get().playback.voice;
    const items: MenuItem[] = [];
    for (const provider of allProviders()) {
      let voices: VoiceInfo[] = [];
      let reason: string | undefined;
      try {
        const avail = await provider.availability();
        if (avail.ok) voices = await provider.voices();
        else reason = avail.reason;
      } catch {
        reason = "Unavailable";
      }
      if (voices.length === 0 && !reason) continue;
      items.push({ label: PROVIDER_LABELS[provider.id], disabled: true, onSelect: () => {} });
      if (voices.length === 0) {
        items.push({
          label: reason ?? "Unavailable",
          disabled: true,
          title: reason,
          onSelect: () => {},
        });
        continue;
      }
      for (const v of voices.slice(0, 24)) {
        const active = current?.provider === v.provider && current.id === v.id;
        items.push({
          label: `${active ? "✓ " : "   "}${v.name}${v.locale ? `  (${shortLocale(v.locale)})` : ""}`,
          onSelect: () => selectVoice({ provider: v.provider, id: v.id }),
        });
      }
      knownVoices = knownVoices.concat(voices);
    }
    if (items.length === 0) {
      toast.error("No voices available — check Settings → Voices");
      return;
    }
    showMenu(r.left, Math.max(8, r.top - Math.min(480, items.length * 30) - 8), items);
    renderVoiceName();
  }

  function selectVoice(ref: VoiceRef): void {
    updatePlaybackPrefs({ voice: ref });
    renderVoiceName();
  }

  function shortLocale(locale: string): string {
    const part = locale.split("-")[1];
    return part ? part.toUpperCase() : locale;
  }

  function renderVoiceName(): void {
    const ref = settingsStore.get().playback.voice;
    if (!ref) {
      voiceName.textContent = "Voice";
      return;
    }
    const known = knownVoices.find((v) => v.provider === ref.provider && v.id === ref.id);
    voiceName.textContent = known?.name ?? prettifyVoiceId(ref.id);
  }

  function prettifyVoiceId(id: string): string {
    // "en-US-AriaNeural" → "Aria"; "en_US-amy-medium" → "amy"
    const m = /^[a-z]{2}[-_][A-Z]{2}-([A-Za-z_]+?)(Neural)?(-[a-z]+)?$/.exec(id);
    return m ? m[1]!.replace(/_/g, " ") : id;
  }

  /* ---- reactive rendering ---- */
  let lastStatusGlyph = "";
  const unsubState = engineState.subscribe((s) => {
    // Idempotent glyph swap: only rewrite on an actual visual flip.
    const glyph = s.status === "playing" || s.status === "loading" ? "pause" : "play";
    const spin = s.status === "loading";
    const wanted = `${glyph}${spin ? "+spin" : ""}`;
    if (wanted !== lastStatusGlyph) {
      lastStatusGlyph = wanted;
      playBtn.innerHTML = spin ? `<span class="spin">${icon.refresh}</span>` : icon[glyph];
    }
    playBtn.title = glyph === "pause" ? "Pause" : "Play";

    if (!dragging) slider.value = String(Math.round(s.pct * 1000));

    const item = s.itemId ? getItem(s.itemId) : undefined;
    if (item && item.wordCount > 0) {
      const minutes = listeningMinutes(item.wordCount * (1 - s.pct), s.rate);
      timeEl.textContent = s.pct >= 1 ? "finished" : `${formatTimeLeft(minutes)} left`;
    } else {
      timeEl.textContent = "";
    }
    if (s.status === "error" && s.error) {
      if (root.dataset.lastError !== s.error) {
        root.dataset.lastError = s.error;
        toast.error(s.error);
      }
    } else if (s.status === "playing") {
      delete root.dataset.lastError;
    }
  });

  const unsubRate = subscribeSelect(
    settingsStore,
    (s) => s.playback.rate,
    () => renderRate(),
  );
  function renderRate(): void {
    rateBtn.textContent = `${settingsStore.get().playback.rate}×`;
  }
  renderRate();

  const unsubVoice = subscribeSelect(
    settingsStore,
    (s) => s.playback.voice,
    () => renderVoiceName(),
  );
  renderVoiceName();
  // Resolve a friendly name for the persisted voice without opening the menu.
  void (async () => {
    const ref = settingsStore.get().playback.voice;
    if (!ref) return;
    try {
      const voices = await allProviders()
        .find((p) => p.id === ref.provider)
        ?.voices();
      if (voices) {
        knownVoices = voices;
        renderVoiceName();
      }
    } catch {
      /* name fallback is fine */
    }
  })();

  const unsubSleep = sleepState.subscribe((st) => {
    const on = st.until !== null || st.endOfChapter;
    sleepBtn.classList.toggle("btn--on", on);
    sleepBtn.title = st.endOfChapter
      ? "Sleep: end of chapter"
      : st.until
        ? `Sleep at ${new Date(st.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
        : "Sleep timer";
  });

  return {
    dispose() {
      unsubState();
      unsubRate();
      unsubVoice();
      unsubSleep();
      root.remove();
    },
  };
}
