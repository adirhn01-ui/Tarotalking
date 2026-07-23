// Cartesia Sonic — BYO API key (Credential Manager, Rust-only). Voices from
// the API; synthesis disk-cached like every provider.

import { ipc } from "../../core/ipc";
import type { SynthResult, VoiceInfo } from "../../core/types";
import type { TtsProvider } from "./provider";

let voicesCache: VoiceInfo[] | null = null;

export const cartesiaProvider: TtsProvider = {
  id: "cartesia",
  label: "Cartesia",
  kind: "audio",

  async availability() {
    try {
      const has = await ipc.hasKey("cartesia");
      return has ? { ok: true } : { ok: false, reason: "Add your Cartesia API key in Settings" };
    } catch {
      return { ok: false, reason: "Add your Cartesia API key in Settings" };
    }
  },

  async voices(): Promise<VoiceInfo[]> {
    if (voicesCache) return voicesCache;
    voicesCache = await ipc.cartesiaVoices();
    return voicesCache;
  },

  synth(voiceId: string, text: string): Promise<SynthResult> {
    return ipc.synth("cartesia", voiceId, text);
  },
};

/** Settings calls this after the key changes so the list refetches. */
export function invalidateCartesiaVoices(): void {
  voicesCache = null;
}
