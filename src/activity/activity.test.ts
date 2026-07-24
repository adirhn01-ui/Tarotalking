// Pure-helper coverage for the Activity screen: the copy each job status
// produces, progress math, path shortening, and the assembled metrics line.

import { describe, expect, it } from "vitest";
import type { Job } from "../core/jobs";
import {
  actionLabel,
  durationLabel,
  etaLabel,
  isActive,
  metricsText,
  middleTruncate,
  progressFraction,
  unitWord,
} from "./activity";

function job(over: Partial<Job> = {}): Job {
  return {
    id: "j1",
    kind: "prepare",
    itemId: "i1",
    title: "The Long Way",
    status: "running",
    received: 30,
    total: 120,
    queuedAt: 1_000,
    ...over,
  };
}

describe("isActive", () => {
  it("covers running and queued only", () => {
    expect(isActive(job({ status: "running" }))).toBe(true);
    expect(isActive(job({ status: "queued" }))).toBe(true);
    for (const s of ["done", "failed", "cancelled"] as const) {
      expect(isActive(job({ status: s }))).toBe(false);
    }
  });
});

describe("progressFraction", () => {
  it("is zero until a total is known", () => {
    expect(progressFraction(job({ total: 0 }))).toBe(0);
    expect(progressFraction(job({ total: Number.NaN }))).toBe(0);
  });

  it("clamps into 0..1", () => {
    expect(progressFraction(job({ received: 60, total: 120 }))).toBe(0.5);
    expect(progressFraction(job({ received: 500, total: 120 }))).toBe(1);
    expect(progressFraction(job({ received: -5, total: 120 }))).toBe(0);
  });
});

describe("unitWord", () => {
  it("names export units steps, since chapters count too", () => {
    expect(unitWord("export")).toBe("steps");
    expect(unitWord("prepare")).toBe("sentences");
  });
});

describe("actionLabel", () => {
  it("reads differently per kind while working and when done", () => {
    expect(actionLabel(job({ kind: "export", status: "running" }))).toBe("Exporting audiobook");
    expect(actionLabel(job({ kind: "prepare", status: "running" }))).toBe("Preparing audio");
    expect(actionLabel(job({ kind: "export", status: "done" }))).toBe("Exported");
    expect(actionLabel(job({ kind: "prepare", status: "done" }))).toBe("Audio ready");
  });

  it("is kind-independent for the other states", () => {
    expect(actionLabel(job({ status: "queued" }))).toBe("Queued");
    expect(actionLabel(job({ status: "cancelled" }))).toBe("Cancelled");
    expect(actionLabel(job({ status: "failed" }))).toBe("Failed");
  });
});

describe("etaLabel", () => {
  it("says so plainly when there is not enough signal", () => {
    expect(etaLabel(null)).toBe("estimating time left");
  });

  it("never shows a jittery sub-minute countdown", () => {
    expect(etaLabel(0)).toBe("under a minute left");
    expect(etaLabel(59)).toBe("under a minute left");
  });

  it("rounds longer estimates", () => {
    expect(etaLabel(300)).toBe("about 5 min left");
    expect(etaLabel(3600 + 300)).toBe("about 1 h 5 min left");
  });
});

describe("durationLabel", () => {
  it("is empty without a complete pair of timestamps", () => {
    expect(durationLabel(job({ startedAt: 1_000 }))).toBe("");
    expect(durationLabel(job({ endedAt: 5_000 }))).toBe("");
    expect(durationLabel(job({ startedAt: 5_000, endedAt: 1_000 }))).toBe("");
  });

  it("reports how long the run took", () => {
    expect(durationLabel(job({ startedAt: 0, endedAt: 240_000 }))).toBe("took 4 min");
    expect(durationLabel(job({ startedAt: 0, endedAt: 20_000 }))).toBe("took under a minute");
  });
});

describe("middleTruncate", () => {
  it("leaves short strings alone", () => {
    expect(middleTruncate("C:\\Books", 52)).toBe("C:\\Books");
  });

  it("keeps both ends and lands exactly on the budget", () => {
    const path = `C:\\Users\\reader\\${"deep\\".repeat(20)}Dune`;
    const out = middleTruncate(path, 52);
    expect(out).toHaveLength(52);
    expect(out).toContain("…");
    expect(out.startsWith("C:\\Users\\reader")).toBe(true);
    expect(out.endsWith("Dune")).toBe(true);
  });
});

describe("metricsText", () => {
  it("pairs percent with the unit count while running", () => {
    // No such job is registered, so the estimate is honestly unknown.
    expect(metricsText(job({ received: 30, total: 120 }))).toBe(
      "25% · 30 of 120 sentences · estimating time left",
    );
  });

  it("uses steps for exports", () => {
    expect(metricsText(job({ kind: "export", received: 30, total: 120 }))).toContain(
      "30 of 120 steps",
    );
  });

  it("omits an estimate for work that has not started", () => {
    expect(metricsText(job({ status: "queued", received: 0, total: 120 }))).toBe(
      "0% · 0 of 120 sentences",
    );
  });

  it("summarises a finished export by chapters and run time", () => {
    const done = job({
      kind: "export",
      status: "done",
      received: 132,
      total: 132,
      chaptersWritten: 12,
      startedAt: 0,
      endedAt: 240_000,
    });
    expect(metricsText(done)).toBe("12 chapters · took 4 min");
  });

  it("keeps partial progress visible on a cancelled run", () => {
    const stopped = job({
      status: "cancelled",
      received: 60,
      total: 120,
      startedAt: 0,
      endedAt: 120_000,
    });
    expect(metricsText(stopped)).toBe("50% · 60 of 120 sentences · took 2 min");
  });
});
