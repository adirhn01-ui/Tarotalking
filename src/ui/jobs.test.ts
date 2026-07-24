import { describe, expect, it } from "vitest";
import { estimateSecondsLeft, type JobSample } from "./jobs";

describe("estimateSecondsLeft", () => {
  it("returns null with fewer than two samples", () => {
    expect(estimateSecondsLeft([], 100)).toBeNull();
    expect(estimateSecondsLeft([{ t: 0, received: 0 }], 100)).toBeNull();
  });

  it("returns null when the window spans less than 1.5s", () => {
    const samples: JobSample[] = [
      { t: 0, received: 0 },
      { t: 1000, received: 10 },
    ];
    expect(estimateSecondsLeft(samples, 100)).toBeNull();
  });

  it("returns null when the rate is zero (no progress across the window)", () => {
    const samples: JobSample[] = [
      { t: 0, received: 40 },
      { t: 2000, received: 40 },
      { t: 4000, received: 40 },
    ];
    expect(estimateSecondsLeft(samples, 100)).toBeNull();
  });

  it("returns null for a non-positive total", () => {
    const samples: JobSample[] = [
      { t: 0, received: 0 },
      { t: 2000, received: 20 },
    ];
    expect(estimateSecondsLeft(samples, 0)).toBeNull();
    expect(estimateSecondsLeft(samples, -100)).toBeNull();
  });

  it("computes seconds left on a steady series", () => {
    // 10 units/sec; 40 of 100 done -> 60 remaining -> 6s.
    const samples: JobSample[] = [
      { t: 0, received: 0 },
      { t: 1000, received: 10 },
      { t: 2000, received: 20 },
      { t: 3000, received: 30 },
      { t: 4000, received: 40 },
    ];
    expect(estimateSecondsLeft(samples, 100)).toBeCloseTo(6, 6);
  });

  it("drops samples older than the 20s window", () => {
    // The stale t:0 sample would drag the rate down to ~4.07/s (=> ~22s). After
    // pruning, only the recent pair counts: 5/s over 90 remaining => 18s.
    const samples: JobSample[] = [
      { t: 0, received: 0 },
      { t: 25000, received: 100 },
      { t: 27000, received: 110 },
    ];
    expect(estimateSecondsLeft(samples, 200)).toBeCloseTo(18, 6);
  });

  it("caps the window to the 50 most recent samples", () => {
    // 60 dense samples, all inside the 20s window so only the 50-cap trims. The
    // first 10 are a flat stall; the last 50 climb a clean 10 units/sec. If the
    // stall leaked in the rate would sag below 10 and the answer would drift off
    // 0.2s, so this pins the cap to the recent slope only.
    const samples: JobSample[] = Array.from({ length: 60 }, (_, i) => ({
      t: i * 200,
      received: i < 10 ? 0 : (i - 10) * 2,
    }));
    // Last 50: 98 units over 9.8s -> 10/s; 2 remaining of 100 -> 0.2s.
    expect(estimateSecondsLeft(samples, 100)).toBeCloseTo(0.2, 6);
  });

  it("clamps to 0 when received meets or exceeds total", () => {
    const samples: JobSample[] = [
      { t: 0, received: 0 },
      { t: 2000, received: 120 },
    ];
    expect(estimateSecondsLeft(samples, 100)).toBe(0);
  });
});
