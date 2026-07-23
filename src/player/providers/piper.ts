// Piper local voices — downloadable ONNX models, fully offline synthesis via
// the Rust-managed piper process. Voice list = installed models only (the
// full catalog with download controls lives in Settings).

import { ipc } from "../../core/ipc";
import type { SynthResult, VoiceInfo } from "../../core/types";
import type { TtsProvider } from "./provider";

export const piperProvider: TtsProvider = {
  id: "piper",
  label: "Local voices",
  kind: "audio",

  async availability() {
    try {
      const status = await ipc.piperStatus();
      if (!status.binaryInstalled || !status.models.some((m) => m.installed)) {
        return { ok: false, reason: "Download a local voice in Settings" };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: "Local voices are unavailable" };
    }
  },

  async voices(): Promise<VoiceInfo[]> {
    const status = await ipc.piperStatus();
    return status.models
      .filter((m) => m.installed && status.binaryInstalled)
      .map((m) => ({
        provider: "piper" as const,
        id: m.id,
        name: m.name,
        locale: m.locale,
        installed: true,
      }));
  },

  synth(voiceId: string, text: string): Promise<SynthResult> {
    return ipc.synth("piper", voiceId, text);
  },
};
