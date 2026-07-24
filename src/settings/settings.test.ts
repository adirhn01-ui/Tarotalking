// Pure-helper coverage for the Settings screen: cache/size formatting, the
// shortcut-conflict display mapping, and the piper download-task routing.

import { describe, expect, it } from "vitest";
import {
  actionChordDisplay,
  CACHE_CUSTOM_MAX,
  CACHE_CUSTOM_MIN,
  CACHE_LIMIT_PRESETS,
  cacheLimitLabel,
  cacheLimitSelectValue,
  cacheUsageLabel,
  chordKeys,
  clampCustomCacheLimit,
  isCustomCacheLimit,
  shortcutConflictSet,
} from "./settings";
import {
  defaultVoiceLabel,
  downloadPct,
  formatMB,
  isHighQuality,
  isKeyProvider,
  KOKORO_ENGINE_TASK,
  KOKORO_MODEL_TASK,
  kokoroTaskBase,
  localeShortBadge,
  piperModelTask,
  piperTaskBase,
  PIPER_BINARY_TASK,
  previewCostsCredits,
  previewSampleText,
  qualityLabel,
  taskMatches,
} from "./voices";

describe("cacheLimitLabel", () => {
  it("uses MB below 1 GB and GB at/above", () => {
    expect(cacheLimitLabel(200)).toBe("200 MB");
    expect(cacheLimitLabel(500)).toBe("500 MB");
    expect(cacheLimitLabel(1000)).toBe("1 GB");
    expect(cacheLimitLabel(2000)).toBe("2 GB");
    expect(cacheLimitLabel(5000)).toBe("5 GB");
  });
  it("labels a zero/negative cap as Unlimited", () => {
    expect(cacheLimitLabel(0)).toBe("Unlimited");
    expect(cacheLimitLabel(-5)).toBe("Unlimited");
  });
  it("offers the documented preset sizes", () => {
    expect([...CACHE_LIMIT_PRESETS]).toEqual([200, 500, 1000, 2000, 5000]);
  });
});

describe("cache-limit select mapping", () => {
  it("maps 0 to Unlimited (not custom)", () => {
    expect(cacheLimitSelectValue(0)).toBe("unlimited");
    expect(isCustomCacheLimit(0)).toBe(false);
  });
  it("maps a preset to its numeric value", () => {
    expect(cacheLimitSelectValue(200)).toBe("200");
    expect(cacheLimitSelectValue(5000)).toBe("5000");
    expect(isCustomCacheLimit(500)).toBe(false);
  });
  it("maps any non-preset, non-zero size to Custom", () => {
    expect(cacheLimitSelectValue(750)).toBe("custom");
    expect(cacheLimitSelectValue(50)).toBe("custom");
    expect(isCustomCacheLimit(750)).toBe(true);
    expect(isCustomCacheLimit(50)).toBe(true);
  });
});

describe("clampCustomCacheLimit", () => {
  it("clamps into the allowed MB range and rounds", () => {
    expect(clampCustomCacheLimit(750)).toBe(750);
    expect(clampCustomCacheLimit(10)).toBe(CACHE_CUSTOM_MIN);
    expect(clampCustomCacheLimit(999_999)).toBe(CACHE_CUSTOM_MAX);
    expect(clampCustomCacheLimit(123.6)).toBe(124);
  });
  it("falls back to the minimum for non-finite input", () => {
    expect(clampCustomCacheLimit(NaN)).toBe(CACHE_CUSTOM_MIN);
    expect(clampCustomCacheLimit(Infinity)).toBe(CACHE_CUSTOM_MIN);
  });
});

describe("cacheUsageLabel", () => {
  it("joins a byte size with a clip count", () => {
    expect(cacheUsageLabel({ bytes: 184_000_000, files: 213 })).toBe("184 MB · 213 clips");
  });
  it("singularizes one clip", () => {
    expect(cacheUsageLabel({ bytes: 500, files: 1 })).toBe("500 B · 1 clip");
  });
});

describe("chordKeys", () => {
  it("splits a chord into key tokens", () => {
    expect(chordKeys("Ctrl+ArrowLeft")).toEqual(["Ctrl", "ArrowLeft"]);
    expect(chordKeys("Space")).toEqual(["Space"]);
    expect(chordKeys("")).toEqual([]);
  });
});

describe("shortcut conflict display", () => {
  it("flags the chord bound to more than one action", () => {
    const shortcuts = { playPause: "Space", stop: "space", nextSentence: "ArrowRight" };
    const conflicts = shortcutConflictSet(shortcuts);
    expect(conflicts.has("Space")).toBe(true);
    expect(conflicts.has("ArrowRight")).toBe(false);
  });
  it("normalizes and marks a conflicting row, leaves unique rows clean", () => {
    const conflicts = shortcutConflictSet({ a: "Space", b: "Space" });
    const dup = actionChordDisplay("space", conflicts);
    expect(dup.chord).toBe("Space");
    expect(dup.keys).toEqual(["Space"]);
    expect(dup.conflict).toBe(true);

    const solo = actionChordDisplay("ctrl + z", conflicts);
    expect(solo.chord).toBe("Ctrl+Z");
    expect(solo.keys).toEqual(["Ctrl", "Z"]);
    expect(solo.conflict).toBe(false);
  });
  it("treats an empty binding as no conflict", () => {
    const conflicts = shortcutConflictSet({ a: "Space", b: "Space" });
    expect(actionChordDisplay("", conflicts).conflict).toBe(false);
  });
});

describe("piper task routing", () => {
  it("builds a model task id", () => {
    expect(piperModelTask("en_US-amy-medium")).toBe("piper-model-en_US-amy-medium");
  });
  it("matches a base and its -cfg companion", () => {
    expect(taskMatches("piper-model-amy", "piper-model-amy")).toBe(true);
    expect(taskMatches("piper-model-amy-cfg", "piper-model-amy")).toBe(true);
    expect(taskMatches("piper-model-amy2", "piper-model-amy")).toBe(false);
    expect(taskMatches("piper-binary", "piper-model-amy")).toBe(false);
  });
  it("resolves any task id back to its owning row", () => {
    expect(piperTaskBase(PIPER_BINARY_TASK)).toBe("piper-binary");
    expect(piperTaskBase("piper-binary-cfg")).toBe("piper-binary");
    expect(piperTaskBase("piper-model-en_US-amy-medium")).toBe("piper-model-en_US-amy-medium");
    expect(piperTaskBase("piper-model-en_US-amy-medium-cfg")).toBe("piper-model-en_US-amy-medium");
    expect(piperTaskBase("something-else")).toBeNull();
  });
});

describe("kokoro task routing", () => {
  it("resolves the engine and model task ids (and their -cfg companions)", () => {
    expect(kokoroTaskBase(KOKORO_ENGINE_TASK)).toBe("kokoro-engine");
    expect(kokoroTaskBase(KOKORO_MODEL_TASK)).toBe("kokoro-model");
    expect(kokoroTaskBase("kokoro-engine-cfg")).toBe("kokoro-engine");
    expect(kokoroTaskBase("kokoro-model-cfg")).toBe("kokoro-model");
  });
  it("ignores non-kokoro task ids", () => {
    expect(kokoroTaskBase(PIPER_BINARY_TASK)).toBeNull();
    expect(kokoroTaskBase("piper-model-amy")).toBeNull();
    expect(kokoroTaskBase("something-else")).toBeNull();
  });
});

describe("quality + size formatting", () => {
  it("recognizes high quality case-insensitively", () => {
    expect(isHighQuality("high")).toBe(true);
    expect(isHighQuality("High")).toBe(true);
    expect(isHighQuality("medium")).toBe(false);
  });
  it("labels quality", () => {
    expect(qualityLabel("high")).toBe("high quality");
    expect(qualityLabel("Medium")).toBe("medium quality");
    expect(qualityLabel("")).toBe("voice");
  });
  it("formats megabytes, rolling into GB", () => {
    expect(formatMB(21)).toBe("21 MB");
    expect(formatMB(63)).toBe("63 MB");
    expect(formatMB(1024)).toBe("1 GB");
    expect(formatMB(1536)).toBe("1.5 GB");
    expect(formatMB(20480)).toBe("20 GB");
    expect(formatMB(-1)).toBe("—");
  });
});

describe("downloadPct", () => {
  it("clamps a determinate percentage", () => {
    expect(downloadPct(50, 100)).toBe(50);
    expect(downloadPct(200, 100)).toBe(100);
  });
  it("is indeterminate without a known total", () => {
    expect(downloadPct(0, null)).toBeNull();
    expect(downloadPct(3, 0)).toBeNull();
  });
});

describe("localeShortBadge", () => {
  it("extracts a 2-letter region subtag, uppercased", () => {
    expect(localeShortBadge("en-US")).toBe("US");
    expect(localeShortBadge("en_GB")).toBe("GB");
    expect(localeShortBadge("pt-br")).toBe("BR");
  });
  it("is empty without a usable region", () => {
    expect(localeShortBadge("en")).toBe("");
    expect(localeShortBadge("")).toBe("");
    expect(localeShortBadge(undefined)).toBe("");
    expect(localeShortBadge("en-Latn")).toBe("");
  });
});

describe("previewSampleText", () => {
  it("greets in the voice's own name", () => {
    expect(previewSampleText("Aria")).toBe("Hi, I'm Aria. This is how I sound in Tarotalking.");
  });
});

describe("previewCostsCredits", () => {
  it("is true for every BYO-key cloud provider", () => {
    expect(previewCostsCredits("eleven")).toBe(true);
    expect(previewCostsCredits("openai")).toBe(true);
    expect(previewCostsCredits("speechify")).toBe(true);
    expect(previewCostsCredits("deepgram")).toBe(true);
    expect(previewCostsCredits("cartesia")).toBe(true);
  });
  it("is false for the free/local providers", () => {
    expect(previewCostsCredits("edge")).toBe(false);
    expect(previewCostsCredits("system")).toBe(false);
    expect(previewCostsCredits("piper")).toBe(false);
    expect(previewCostsCredits("kokoro")).toBe(false);
  });
});

describe("isKeyProvider", () => {
  it("marks the BYO-key cloud providers", () => {
    expect(isKeyProvider("eleven")).toBe(true);
    expect(isKeyProvider("openai")).toBe(true);
    expect(isKeyProvider("speechify")).toBe(true);
    expect(isKeyProvider("deepgram")).toBe(true);
    expect(isKeyProvider("cartesia")).toBe(true);
  });
  it("leaves the free/local providers unmarked", () => {
    expect(isKeyProvider("edge")).toBe(false);
    expect(isKeyProvider("system")).toBe(false);
    expect(isKeyProvider("piper")).toBe(false);
    expect(isKeyProvider("kokoro")).toBe(false);
  });
});

describe("defaultVoiceLabel", () => {
  it("describes an explicit voice with its provider", () => {
    expect(defaultVoiceLabel({ provider: "edge", id: "en-US-AriaNeural" }, "Aria")).toEqual({
      primary: "Aria",
      secondary: "Microsoft Edge voices",
    });
  });
  it("falls back to the id when the name is unknown", () => {
    expect(defaultVoiceLabel({ provider: "system", id: "David" }, null)).toEqual({
      primary: "David",
      secondary: "System voices",
    });
  });
  it("describes the automatic default", () => {
    expect(defaultVoiceLabel(null, null).primary).toBe("Automatic");
  });
});
