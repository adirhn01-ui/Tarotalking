import { describe, expect, it } from "vitest";
import {
  fileExt,
  fileName,
  fileStem,
  formatBytes,
  formatDuration,
  formatPct,
  formatTimeLeft,
  listeningMinutes,
  readingMinutes,
} from "./format";

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration(42)).toBe("0:42");
    expect(formatDuration(187)).toBe("3:07");
    expect(formatDuration(3723)).toBe("1:02:03");
  });
  it("clamps invalid input", () => {
    expect(formatDuration(-5)).toBe("0:00");
    expect(formatDuration(NaN)).toBe("0:00");
  });
});

describe("formatTimeLeft", () => {
  it("renders sub-minute, minutes, and hours", () => {
    expect(formatTimeLeft(0.4)).toBe("under a minute");
    expect(formatTimeLeft(12.4)).toBe("12 min");
    expect(formatTimeLeft(125)).toBe("2 h 5 min");
    expect(formatTimeLeft(120)).toBe("2 h");
  });
});

describe("estimates", () => {
  it("reading is faster than listening at 1x", () => {
    expect(readingMinutes(10000)).toBeLessThan(listeningMinutes(10000, 1));
  });
  it("listening scales with rate", () => {
    expect(listeningMinutes(3100, 2)).toBeCloseTo(listeningMinutes(3100, 1) / 2, 5);
  });
});

describe("paths", () => {
  it("extracts name, stem, ext from windows paths", () => {
    expect(fileName("C:\\books\\Moby Dick.epub")).toBe("Moby Dick.epub");
    expect(fileStem("C:\\books\\Moby Dick.epub")).toBe("Moby Dick");
    expect(fileExt("C:\\books\\Moby Dick.EPUB")).toBe("epub");
    expect(fileExt("noext")).toBe("");
  });
});

describe("formatBytes / formatPct", () => {
  it("formats byte sizes", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(63_000_000)).toBe("63.0 MB");
  });
  it("clamps percentages", () => {
    expect(formatPct(0.0731)).toBe("7%");
    expect(formatPct(1.4)).toBe("100%");
    expect(formatPct(-1)).toBe("0%");
  });
});
