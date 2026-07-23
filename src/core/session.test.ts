// sanitizeSettings must survive any garbage on disk — a corrupt settings.json
// can never crash mount.

import { describe, expect, it } from "vitest";
import { sanitizeSettings } from "./session";
import { DEFAULT_SETTINGS } from "./types";

describe("sanitizeSettings", () => {
  it("returns defaults for garbage input", () => {
    for (const garbage of [null, undefined, 42, "hi", [], { theme: 9 }]) {
      const s = sanitizeSettings(garbage);
      expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
      expect(s.reader.fontSize).toBe(DEFAULT_SETTINGS.reader.fontSize);
      expect(s.playback.rate).toBe(1);
    }
  });

  it("keeps valid values and clamps out-of-range numbers", () => {
    const s = sanitizeSettings({
      theme: "light",
      reader: { fontSize: 900, lineHeight: 0.1, width: 700 },
      playback: { rate: 1.5, volume: 3, highlight: "word" },
      cacheLimitMB: 5,
    });
    expect(s.theme).toBe("light");
    expect(s.reader.fontSize).toBe(30);
    expect(s.reader.lineHeight).toBe(1.2);
    expect(s.reader.width).toBe(700);
    expect(s.playback.rate).toBe(1.5);
    expect(s.playback.volume).toBe(1);
    expect(s.playback.highlight).toBe("word");
    expect(s.cacheLimitMB).toBe(20);
  });

  it("drops an off-list playback rate to 1", () => {
    expect(sanitizeSettings({ playback: { rate: 1.37 } }).playback.rate).toBe(1);
  });

  it("sanitizes the voice ref", () => {
    expect(
      sanitizeSettings({ playback: { voice: { provider: "edge", id: "en-US-AriaNeural" } } })
        .playback.voice,
    ).toEqual({ provider: "edge", id: "en-US-AriaNeural" });
    expect(sanitizeSettings({ playback: { voice: { provider: "evil", id: "x" } } }).playback.voice).toBeNull();
    expect(sanitizeSettings({ playback: { voice: "aria" } }).playback.voice).toBeNull();
  });

  it("merges shortcuts over defaults, ignoring unknown actions", () => {
    const s = sanitizeSettings({ shortcuts: { playPause: "P", bogusAction: "X" } });
    expect(s.shortcuts.playPause).toBe("P");
    expect(s.shortcuts.nextSentence).toBe("ArrowRight");
    expect("bogusAction" in s.shortcuts).toBe(false);
  });
});
