import { describe, expect, it } from "vitest";
import { classWeight, cleanTitle, scoreText } from "./readability";

describe("scoreText", () => {
  it("ignores short fragments", () => {
    expect(scoreText("too short")).toBe(0);
    expect(scoreText("x".repeat(24))).toBe(0);
  });
  it("scores a plain sentence at base + comma credit", () => {
    // 30 chars, no commas: 1 + (0 + 1) + min(floor(30/100), 3) = 2
    expect(scoreText("x".repeat(30))).toBe(2);
  });
  it("rewards commas and length", () => {
    // 122 chars, 2 commas: 1 + (2 + 1) + min(floor(122/100)=1, 3) = 5
    const s = "word, word, " + "z".repeat(110);
    expect(scoreText(s)).toBe(5);
  });
  it("caps the length bonus at 3", () => {
    const s = "z".repeat(1000);
    // 1 + (0 + 1) + 3 = 5
    expect(scoreText(s)).toBe(5);
  });
});

describe("classWeight", () => {
  it("penalizes boilerplate names", () => {
    expect(classWeight("sidebar", "")).toBe(-25);
    expect(classWeight("", "newsletter-signup")).toBe(-25);
  });
  it("rewards content-ish names", () => {
    expect(classWeight("post-content", "")).toBe(25);
  });
  it("nets to zero when both signals fire", () => {
    expect(classWeight("comment", "main")).toBe(0);
  });
  it("is neutral for unrelated names", () => {
    expect(classWeight("wrapper", "x1")).toBe(0);
  });
});

describe("cleanTitle", () => {
  it("strips a trailing site suffix when the headline is substantial", () => {
    expect(cleanTitle("Awesome Long Headline Here | The Times")).toBe("Awesome Long Headline Here");
    expect(cleanTitle("A Great Long Piece - Blog Name")).toBe("A Great Long Piece");
  });
  it("keeps the full string when the remainder is too short", () => {
    expect(cleanTitle("Short | Site")).toBe("Short | Site");
  });
  it("normalizes whitespace", () => {
    expect(cleanTitle("  Spaced   Title  ")).toBe("Spaced Title");
  });
});
