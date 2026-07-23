// System voices via the WebView2 speechSynthesis bridge — zero setup, fully
// offline, includes any natural voices installed in Windows. Utterance-kind:
// no audio files; boundary events drive highlighting.

import type { VoiceInfo } from "../../core/types";
import type { SpeakCallbacks, SpeakHandle, TtsProvider } from "./provider";

let voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null;

/** getVoices() is empty until the voice list loads asynchronously; wait for
 *  voiceschanged with a timeout so a broken bridge can't hang callers. */
function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (voicesPromise) return voicesPromise;
  voicesPromise = new Promise((resolve) => {
    if (typeof speechSynthesis === "undefined") {
      resolve([]);
      return;
    }
    const now = speechSynthesis.getVoices();
    if (now.length > 0) {
      resolve(now);
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(speechSynthesis.getVoices());
    };
    speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
    window.setTimeout(finish, 1500);
  });
  return voicesPromise;
}

/** "Microsoft Zira - English (United States)" → "Zira". */
function displayName(v: SpeechSynthesisVoice): string {
  let name = v.name.replace(/^Microsoft\s+/i, "").replace(/\s+Online\b.*$/i, "");
  const dash = name.indexOf(" - ");
  if (dash > 0) name = name.slice(0, dash);
  return name.trim() || v.name;
}

function findVoice(voices: SpeechSynthesisVoice[], id: string): SpeechSynthesisVoice | null {
  return voices.find((v) => v.voiceURI === id) ?? voices.find((v) => v.name === id) ?? null;
}

export const systemProvider: TtsProvider = {
  id: "system",
  label: "System voices",
  kind: "utterance",

  async availability() {
    const voices = await loadVoices();
    return voices.length > 0
      ? { ok: true }
      : { ok: false, reason: "No Windows voices are available" };
  },

  async voices(): Promise<VoiceInfo[]> {
    const voices = await loadVoices();
    return voices
      .filter((v) => v.lang.toLowerCase().startsWith("en"))
      .map((v) => ({
        provider: "system" as const,
        id: v.voiceURI,
        name: displayName(v),
        locale: v.lang,
      }))
      .sort((a, b) => (a.locale ?? "").localeCompare(b.locale ?? "") || a.name.localeCompare(b.name));
  },

  speak(
    voiceId: string,
    text: string,
    opts: { rate: number; volume: number } & SpeakCallbacks,
  ): SpeakHandle {
    let cancelled = false;
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = Math.max(0.1, Math.min(10, opts.rate));
    utter.volume = Math.max(0, Math.min(1, opts.volume));
    utter.lang = "en-US";

    void loadVoices().then((voices) => {
      if (cancelled) return;
      const v = findVoice(voices, voiceId);
      if (v) {
        utter.voice = v;
        utter.lang = v.lang;
      }
      utter.onboundary = (e) => {
        if (cancelled || e.name !== "word") return;
        // charLength is missing on some voices — extend to the next word gap.
        let len = e.charLength ?? 0;
        if (!len) {
          const rest = text.slice(e.charIndex);
          const m = /^\S+/.exec(rest);
          len = m ? m[0].length : 0;
        }
        opts.onBoundary?.(e.charIndex, len);
      };
      utter.onend = () => {
        if (!cancelled) opts.onEnd();
      };
      utter.onerror = (e) => {
        if (cancelled || e.error === "canceled" || e.error === "interrupted") return;
        opts.onError(`System voice error: ${e.error}`);
      };
      speechSynthesis.speak(utter);
    });

    return {
      cancel() {
        cancelled = true;
        // cancel() flushes the whole queue — we only ever queue one utterance.
        speechSynthesis.cancel();
      },
    };
  },
};
