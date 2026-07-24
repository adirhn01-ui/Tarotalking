// Pure-helper coverage for the Library screen: the "prepare audio" (whole-book
// pre-synthesis) size estimate. Importing ./library pulls the view module (and
// its transitive engine/provider graph) but exercises only the pure export.

import { describe, expect, it } from "vitest";
import { prepareAudioBytes } from "./library";

describe("prepareAudioBytes", () => {
  // 1550 words at 155 wpm = 10 min = 600 s of speech.
  it("scales word count by the provider's bytes-per-second", () => {
    expect(prepareAudioBytes(1550, "edge", "high")).toBe(600 * 12_000);
    expect(prepareAudioBytes(1550, "edge", "standard")).toBe(600 * 6_000);
    expect(prepareAudioBytes(1550, "eleven", "high")).toBe(600 * 16_000);
  });

  it("returns 0 for empty or negative word counts", () => {
    expect(prepareAudioBytes(0, "edge", "high")).toBe(0);
    expect(prepareAudioBytes(-500, "edge", "high")).toBe(0);
  });

  it("rounds to whole bytes", () => {
    const n = prepareAudioBytes(1, "edge", "high");
    expect(Number.isInteger(n)).toBe(true);
  });
});
