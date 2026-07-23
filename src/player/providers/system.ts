// System voices — Windows' built-in voices via the WinRT speech API in Rust.
// Zero setup, fully offline. WebView2 has no usable speechSynthesis bridge,
// so this is an audio-kind provider like the others: Rust synthesizes WAV
// into the cache and the engine plays it (uniform speed/volume/highlight).

import { inTauri, ipc } from "../../core/ipc";
import type { SynthResult, VoiceInfo } from "../../core/types";
import type { TtsProvider } from "./provider";

let voicesCache: VoiceInfo[] | null = null;

export const systemProvider: TtsProvider = {
  id: "system",
  label: "System voices",
  kind: "audio",

  async availability() {
    if (!inTauri) return { ok: false, reason: "Desktop app required" };
    try {
      const v = await this.voices();
      return v.length > 0
        ? { ok: true }
        : { ok: false, reason: "No Windows voices are installed" };
    } catch {
      return { ok: false, reason: "Windows voices are unavailable" };
    }
  },

  async voices(): Promise<VoiceInfo[]> {
    if (voicesCache) return voicesCache;
    voicesCache = await ipc.systemVoices();
    return voicesCache;
  },

  synth(voiceId: string, text: string): Promise<SynthResult> {
    return ipc.synth("system", voiceId, text);
  },
};
