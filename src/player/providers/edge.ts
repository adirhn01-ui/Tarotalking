// Microsoft Edge neural voices — synthesized in Rust over Edge's read-aloud
// endpoint, cached on disk, word boundaries included (word-level highlight).

import { ipc } from "../../core/ipc";
import type { SynthResult, VoiceInfo } from "../../core/types";
import type { TtsProvider } from "./provider";

let voicesCache: VoiceInfo[] | null = null;

export const edgeProvider: TtsProvider = {
  id: "edge",
  label: "Microsoft Edge voices",
  kind: "audio",

  async availability() {
    try {
      const v = await this.voices();
      return v.length > 0
        ? { ok: true }
        : { ok: false, reason: "Edge voices need an internet connection" };
    } catch {
      return { ok: false, reason: "Edge voices need an internet connection" };
    }
  },

  async voices(): Promise<VoiceInfo[]> {
    if (voicesCache) return voicesCache;
    voicesCache = await ipc.edgeVoices();
    return voicesCache;
  },

  synth(voiceId: string, text: string): Promise<SynthResult> {
    return ipc.synth("edge", voiceId, text);
  },
};
