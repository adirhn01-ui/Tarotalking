// OpenAI TTS — bring-your-own API key (stored in Windows Credential Manager,
// read only inside Rust). Fixed voice catalog (the API has no voices
// endpoint); model defaults to gpt-4o-mini-tts on the Rust side. Audio is
// disk-cached like every provider, so repeated listening never re-bills.

import { ipc } from "../../core/ipc";
import type { SynthResult, VoiceInfo } from "../../core/types";
import type { TtsProvider } from "./provider";

/** The published OpenAI TTS voices (stable ids, no listing endpoint). */
const OPENAI_VOICES: { id: string; name: string; gender?: string }[] = [
  { id: "alloy", name: "Alloy" },
  { id: "ash", name: "Ash", gender: "Male" },
  { id: "ballad", name: "Ballad", gender: "Male" },
  { id: "coral", name: "Coral", gender: "Female" },
  { id: "echo", name: "Echo", gender: "Male" },
  { id: "fable", name: "Fable" },
  { id: "nova", name: "Nova", gender: "Female" },
  { id: "onyx", name: "Onyx", gender: "Male" },
  { id: "sage", name: "Sage", gender: "Female" },
  { id: "shimmer", name: "Shimmer", gender: "Female" },
];

export const openaiProvider: TtsProvider = {
  id: "openai",
  label: "OpenAI",
  kind: "audio",

  async availability() {
    try {
      const has = await ipc.hasKey("openai");
      return has ? { ok: true } : { ok: false, reason: "Add your OpenAI API key in Settings" };
    } catch {
      return { ok: false, reason: "Add your OpenAI API key in Settings" };
    }
  },

  voices(): Promise<VoiceInfo[]> {
    return Promise.resolve(
      OPENAI_VOICES.map((v) => ({
        provider: "openai" as const,
        id: v.id,
        name: v.name,
        gender: v.gender,
      })),
    );
  },

  synth(voiceId: string, text: string): Promise<SynthResult> {
    return ipc.synth("openai", voiceId, text);
  },
};
