// Deepgram Aura — BYO API key (Credential Manager, Rust-only). Fixed model
// catalog (no listing endpoint); synthesis disk-cached like every provider.

import { ipc } from "../../core/ipc";
import type { SynthResult, VoiceInfo } from "../../core/types";
import type { TtsProvider } from "./provider";

/** Mirrors the Rust-side curated Aura-2 English catalog. */
const DEEPGRAM_VOICES: { id: string; name: string; gender: string }[] = [
  { id: "aura-2-thalia-en", name: "Thalia", gender: "Female" },
  { id: "aura-2-asteria-en", name: "Asteria", gender: "Female" },
  { id: "aura-2-luna-en", name: "Luna", gender: "Female" },
  { id: "aura-2-athena-en", name: "Athena", gender: "Female" },
  { id: "aura-2-hera-en", name: "Hera", gender: "Female" },
  { id: "aura-2-andromeda-en", name: "Andromeda", gender: "Female" },
  { id: "aura-2-orion-en", name: "Orion", gender: "Male" },
  { id: "aura-2-arcas-en", name: "Arcas", gender: "Male" },
  { id: "aura-2-apollo-en", name: "Apollo", gender: "Male" },
  { id: "aura-2-atlas-en", name: "Atlas", gender: "Male" },
  { id: "aura-2-zeus-en", name: "Zeus", gender: "Male" },
  { id: "aura-2-draco-en", name: "Draco", gender: "Male" },
];

export const deepgramProvider: TtsProvider = {
  id: "deepgram",
  label: "Deepgram",
  kind: "audio",

  async availability() {
    try {
      const has = await ipc.hasKey("deepgram");
      return has ? { ok: true } : { ok: false, reason: "Add your Deepgram API key in Settings" };
    } catch {
      return { ok: false, reason: "Add your Deepgram API key in Settings" };
    }
  },

  voices(): Promise<VoiceInfo[]> {
    return Promise.resolve(
      DEEPGRAM_VOICES.map((v) => ({
        provider: "deepgram" as const,
        id: v.id,
        name: v.name,
        gender: v.gender,
        locale: "en-US",
      })),
    );
  },

  synth(voiceId: string, text: string): Promise<SynthResult> {
    return ipc.synth("deepgram", voiceId, text);
  },
};
