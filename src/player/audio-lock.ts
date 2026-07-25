// Exactly one thing is ever audible.
//
// The app has two independent players — sentence-by-sentence TTS (engine.ts)
// and linear audiobook playback (audiobook.ts) — each owning its own audio
// output. Without a single arbiter they can talk past each other: whoever
// happens to know about the other stops it, and any direction nobody thought
// of overlaps. That is not a bug you fix once; it is a bug you re-introduce
// every time a third source appears.
//
// So ownership lives here instead. A player registers how to stop itself, and
// claims the output before it makes a sound. Claiming stops everyone else,
// whoever they are — the rule holds for pairs that were never considered.

export type PlaybackOwner = "tts" | "audiobook";

const stoppers = new Map<PlaybackOwner, () => void>();
let owner: PlaybackOwner | null = null;

/** Register how to silence a player. Called once, at module init. */
export function registerPlayer(who: PlaybackOwner, stop: () => void): void {
  stoppers.set(who, stop);
}

/** Take the audio output for `who`, stopping every other registered player.
 *  Safe to call repeatedly — re-claiming by the current owner does nothing. */
export function claimPlayback(who: PlaybackOwner): void {
  if (owner === who) return;
  owner = who;
  for (const [other, stop] of stoppers) {
    if (other === who) continue;
    try {
      stop();
    } catch {
      // A player that fails to stop must not block the one starting up.
    }
  }
}

/** Give up the output, if `who` still holds it. */
export function releasePlayback(who: PlaybackOwner): void {
  if (owner === who) owner = null;
}

/** Who currently holds the audio output (null when nothing is playing). */
export function playbackOwner(): PlaybackOwner | null {
  return owner;
}

/** Test seam: forget all registrations and ownership. */
export function resetPlaybackOwners(): void {
  stoppers.clear();
  owner = null;
}
