// Pure-helper coverage for the Settings screen: cache/size formatting, the
// shortcut-conflict display mapping, and the piper download-task routing.

import { describe, expect, it } from "vitest";
import {
  actionChordDisplay,
  CACHE_LIMIT_OPTIONS,
  cacheLimitLabel,
  cacheUsageLabel,
  chordKeys,
  shortcutConflictSet,
} from "./settings";
import {
  defaultVoiceLabel,
  downloadPct,
  formatMB,
  isHighQuality,
  piperModelTask,
  piperTaskBase,
  PIPER_BINARY_TASK,
  qualityLabel,
  taskMatches,
} from "./voices";

describe("cacheLimitLabel", () => {
  it("uses MB below 1 GB and GB at/above", () => {
    expect(cacheLimitLabel(100)).toBe("100 MB");
    expect(cacheLimitLabel(500)).toBe("500 MB");
    expect(cacheLimitLabel(1000)).toBe("1 GB");
    expect(cacheLimitLabel(2000)).toBe("2 GB");
  });
  it("offers the documented set of limits", () => {
    expect([...CACHE_LIMIT_OPTIONS]).toEqual([100, 200, 500, 1000, 2000]);
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
