// Kokoro local voices — the second fully-offline neural engine (sherpa-onnx
// runtime). One ~330 MB model bundle serves all voices; a clear quality step
// up from Piper. Download management lives in Settings → Voices.

import { ipc } from "../../core/ipc";
import type { SynthResult, VoiceInfo } from "../../core/types";
import type { TtsProvider } from "./provider";

export const kokoroProvider: TtsProvider = {
  id: "kokoro",
  label: "Kokoro (local)",
  kind: "audio",

  async availability() {
    try {
      const s = await ipc.kokoroStatus();
      if (!s.engineInstalled || !s.modelInstalled) {
        return { ok: false, reason: "Download Kokoro in Settings" };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: "Kokoro is unavailable" };
    }
  },

  async voices(): Promise<VoiceInfo[]> {
    const s = await ipc.kokoroStatus();
    if (!s.engineInstalled || !s.modelInstalled) return [];
    return s.voices.map((v) => ({
      provider: "kokoro" as const,
      id: v.id,
      name: v.name,
      locale: v.locale,
      gender: v.gender,
      installed: true,
    }));
  },

  synth(voiceId: string, text: string): Promise<SynthResult> {
    return ipc.synth("kokoro", voiceId, text);
  },
};
