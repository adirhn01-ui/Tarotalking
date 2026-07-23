// ElevenLabs — bring-your-own API key (stored in Windows Credential Manager,
// read only inside Rust). Synthesis is always disk-cached: re-listening never
// re-spends credits on the same sentence+voice.

import { ipc } from "../../core/ipc";
import type { SynthResult, VoiceInfo } from "../../core/types";
import type { TtsProvider } from "./provider";

let voicesCache: VoiceInfo[] | null = null;

export const elevenProvider: TtsProvider = {
  id: "eleven",
  label: "ElevenLabs",
  kind: "audio",

  async availability() {
    try {
      const has = await ipc.hasKey("eleven");
      return has ? { ok: true } : { ok: false, reason: "Add your ElevenLabs API key in Settings" };
    } catch {
      return { ok: false, reason: "Add your ElevenLabs API key in Settings" };
    }
  },

  async voices(): Promise<VoiceInfo[]> {
    if (voicesCache) return voicesCache;
    voicesCache = await ipc.elevenVoices();
    return voicesCache;
  },

  synth(voiceId: string, text: string): Promise<SynthResult> {
    return ipc.synth("eleven", voiceId, text);
  },
};

/** Settings calls this after the key changes so the list refetches. */
export function invalidateElevenVoices(): void {
  voicesCache = null;
}
