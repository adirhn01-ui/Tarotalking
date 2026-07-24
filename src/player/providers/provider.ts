// The one TTS provider interface. Two kinds:
//  - "audio": synthesizes a sentence to a cached audio file (Edge, Piper,
//    ElevenLabs — all via Rust). The engine plays files and owns timing.
//  - "utterance": speaks directly via the platform (system speechSynthesis);
//    the provider surfaces boundary events and the engine follows along.

import type { ProviderId, SynthResult, VoiceInfo } from "../../core/types";

export interface ProviderAvailability {
  ok: boolean;
  /** Short, user-readable reason when not ok ("Add an API key in Settings"). */
  reason?: string;
}

export interface SpeakCallbacks {
  onBoundary?: (charStart: number, charLen: number) => void;
  onEnd: () => void;
  onError: (message: string) => void;
}

export interface SpeakHandle {
  cancel(): void;
}

export interface TtsProvider {
  id: ProviderId;
  label: string;
  kind: "audio" | "utterance";
  availability(): Promise<ProviderAvailability>;
  voices(): Promise<VoiceInfo[]>;
  /** audio kind — synthesize one sentence (cached in Rust). */
  synth?(voiceId: string, text: string): Promise<SynthResult>;
  /** utterance kind — speak one sentence now. */
  speak?(
    voiceId: string,
    text: string,
    opts: { rate: number; volume: number } & SpeakCallbacks,
  ): SpeakHandle;
}

import { systemProvider } from "./system";
import { edgeProvider } from "./edge";
import { piperProvider } from "./piper";
import { kokoroProvider } from "./kokoro";
import { elevenProvider } from "./eleven";
import { openaiProvider } from "./openai";
import { speechifyProvider } from "./speechify";
import { deepgramProvider } from "./deepgram";
import { cartesiaProvider } from "./cartesia";

const PROVIDERS: Record<ProviderId, TtsProvider> = {
  system: systemProvider,
  edge: edgeProvider,
  piper: piperProvider,
  kokoro: kokoroProvider,
  eleven: elevenProvider,
  openai: openaiProvider,
  speechify: speechifyProvider,
  deepgram: deepgramProvider,
  cartesia: cartesiaProvider,
};

export function getProvider(id: ProviderId): TtsProvider {
  return PROVIDERS[id];
}

/** Display order: free/no-setup first, cloud key last. */
export function allProviders(): TtsProvider[] {
  return [
    edgeProvider,
    systemProvider,
    kokoroProvider,
    piperProvider,
    elevenProvider,
    openaiProvider,
    speechifyProvider,
    deepgramProvider,
    cartesiaProvider,
  ];
}
