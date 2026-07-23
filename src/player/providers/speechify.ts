// Speechify — BYO API key (Credential Manager, Rust-only). Voices from the
// API; synthesis disk-cached like every provider.

import { ipc } from "../../core/ipc";
import type { SynthResult, VoiceInfo } from "../../core/types";
import type { TtsProvider } from "./provider";

let voicesCache: VoiceInfo[] | null = null;

export const speechifyProvider: TtsProvider = {
  id: "speechify",
  label: "Speechify",
  kind: "audio",

  async availability() {
    try {
      const has = await ipc.hasKey("speechify");
      return has ? { ok: true } : { ok: false, reason: "Add your Speechify API key in Settings" };
    } catch {
      return { ok: false, reason: "Add your Speechify API key in Settings" };
    }
  },

  async voices(): Promise<VoiceInfo[]> {
    if (voicesCache) return voicesCache;
    voicesCache = await ipc.speechifyVoices();
    return voicesCache;
  },

  synth(voiceId: string, text: string): Promise<SynthResult> {
    return ipc.synth("speechify", voiceId, text);
  },
};

/** Settings calls this after the key changes so the list refetches. */
export function invalidateSpeechifyVoices(): void {
  voicesCache = null;
}
