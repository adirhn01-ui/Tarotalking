// The "only one thing is audible" rule. These are cheap to write and the
// failure they guard against — two sources playing over each other — is one a
// passing app can exhibit while every other test stays green.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimPlayback,
  playbackOwner,
  registerPlayer,
  releasePlayback,
  resetPlaybackOwners,
} from "./audio-lock";

describe("playback arbitration", () => {
  beforeEach(() => resetPlaybackOwners());

  it("stops the other player when one claims the output", () => {
    const stopTts = vi.fn();
    const stopBook = vi.fn();
    registerPlayer("tts", stopTts);
    registerPlayer("audiobook", stopBook);

    claimPlayback("audiobook");
    expect(stopTts).toHaveBeenCalledTimes(1);
    expect(stopBook).not.toHaveBeenCalled();
    expect(playbackOwner()).toBe("audiobook");

    claimPlayback("tts");
    expect(stopBook).toHaveBeenCalledTimes(1);
    expect(stopTts).toHaveBeenCalledTimes(1); // not re-stopped by its own claim
    expect(playbackOwner()).toBe("tts");
  });

  it("is idempotent — re-claiming by the owner stops nobody", () => {
    const stopTts = vi.fn();
    const stopBook = vi.fn();
    registerPlayer("tts", stopTts);
    registerPlayer("audiobook", stopBook);

    claimPlayback("tts");
    stopBook.mockClear();
    claimPlayback("tts");
    claimPlayback("tts");
    expect(stopBook).not.toHaveBeenCalled();
    expect(stopTts).not.toHaveBeenCalled();
  });

  it("releasing clears ownership, but only for the current owner", () => {
    registerPlayer("tts", vi.fn());
    registerPlayer("audiobook", vi.fn());

    claimPlayback("tts");
    releasePlayback("audiobook"); // not the owner — must not clear
    expect(playbackOwner()).toBe("tts");

    releasePlayback("tts");
    expect(playbackOwner()).toBeNull();
  });

  it("a player that throws while stopping cannot block the one starting", () => {
    const angry = vi.fn(() => {
      throw new Error("device is wedged");
    });
    const stopBook = vi.fn();
    registerPlayer("tts", angry);
    registerPlayer("audiobook", stopBook);

    expect(() => claimPlayback("audiobook")).not.toThrow();
    expect(angry).toHaveBeenCalledTimes(1);
    expect(playbackOwner()).toBe("audiobook");
  });

  it("claiming with nothing else registered is harmless", () => {
    registerPlayer("audiobook", vi.fn());
    expect(() => claimPlayback("audiobook")).not.toThrow();
    expect(playbackOwner()).toBe("audiobook");
  });

  it("stops every other registered player, not just a known pair", () => {
    // The point of a central arbiter: a source nobody special-cased still gets
    // silenced. Stand in a third player to prove the rule is not pairwise.
    const stopTts = vi.fn();
    const stopBook = vi.fn();
    const stopThird = vi.fn();
    registerPlayer("tts", stopTts);
    registerPlayer("audiobook", stopBook);
    registerPlayer("third" as never, stopThird);

    claimPlayback("tts");
    expect(stopBook).toHaveBeenCalledTimes(1);
    expect(stopThird).toHaveBeenCalledTimes(1);
  });
});
