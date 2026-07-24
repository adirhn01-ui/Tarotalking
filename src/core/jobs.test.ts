// Audio-job queue: the pure ETA math plus the queue semantics the whole app
// leans on (up to three jobs at once, FIFO behind that, dedupe, per-job cancel,
// per-job progress routing, capped history). The IPC layer is mocked so the
// runner can be driven deterministically.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadProgress } from "./ipc";
import type { ExportSpec, JobSample, PrepareSpec } from "./jobs";

const mocks = vi.hoisted(() => ({
  precache: vi.fn(),
  exportAudiobook: vi.fn(),
  precacheCancel: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  /** The queue's download-progress listener, captured on first enqueue. */
  progress: null as null | ((p: DownloadProgress) => void),
}));

vi.mock("./ipc", () => ({
  ipc: {
    precache: mocks.precache,
    exportAudiobook: mocks.exportAudiobook,
    precacheCancel: mocks.precacheCancel,
  },
  onDownloadProgress: (cb: (p: DownloadProgress) => void) => {
    mocks.progress = cb;
    return Promise.resolve(() => {});
  },
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

vi.mock("../ui/toast", () => ({
  toast: { info: mocks.toastInfo, error: mocks.toastError },
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
}));

type JobsModule = typeof import("./jobs");
let jobs: JobsModule;

/** Let the runner's promise chain settle (all pending microtasks). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function prep(itemId: string, texts: string[] = ["one", "two"]): PrepareSpec {
  return {
    kind: "prepare",
    itemId,
    title: `Book ${itemId}`,
    provider: "edge",
    voiceId: "v1",
    texts,
  };
}

function exp(itemId: string): ExportSpec {
  return {
    kind: "export",
    itemId,
    title: `Book ${itemId}`,
    provider: "edge",
    voiceId: "v1",
    author: "Someone",
    chapters: [
      { title: "One", texts: ["a", "b"] },
      { title: "Two", texts: ["c"] },
    ],
    destDir: "D:/out",
  };
}

/** Feed one backend progress event to the queue's listener. */
function emitProgress(taskId: string, received: number, total: number | null = null): void {
  mocks.progress?.({ taskId, label: "", received, total, done: false, error: null });
}

/** Progress ticks publish on a 200ms throttle; wait it out before asserting. */
function settlePublish(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 260));
}

beforeEach(async () => {
  vi.resetModules();
  mocks.precache.mockReset();
  mocks.exportAudiobook.mockReset();
  mocks.precacheCancel.mockReset();
  mocks.toastInfo.mockReset();
  mocks.toastError.mockReset();
  mocks.progress = null;
  mocks.precacheCancel.mockResolvedValue(undefined);
  jobs = await import("./jobs");
});

describe("secondsLeftFromSamples", () => {
  it("returns null with fewer than two samples", () => {
    expect(jobs.secondsLeftFromSamples([], 100)).toBeNull();
    expect(jobs.secondsLeftFromSamples([{ t: 0, received: 0 }], 100)).toBeNull();
  });

  it("returns null when the window spans less than 1.5s", () => {
    const samples: JobSample[] = [
      { t: 0, received: 0 },
      { t: 1000, received: 10 },
    ];
    expect(jobs.secondsLeftFromSamples(samples, 100)).toBeNull();
  });

  it("returns null when the rate is zero (no progress across the window)", () => {
    const samples: JobSample[] = [
      { t: 0, received: 40 },
      { t: 2000, received: 40 },
      { t: 4000, received: 40 },
    ];
    expect(jobs.secondsLeftFromSamples(samples, 100)).toBeNull();
  });

  it("returns null for a non-positive total", () => {
    const samples: JobSample[] = [
      { t: 0, received: 0 },
      { t: 2000, received: 20 },
    ];
    expect(jobs.secondsLeftFromSamples(samples, 0)).toBeNull();
    expect(jobs.secondsLeftFromSamples(samples, -100)).toBeNull();
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
    expect(jobs.secondsLeftFromSamples(samples, 100)).toBeCloseTo(6, 6);
  });

  it("drops samples older than the 20s window", () => {
    // The stale t:0 sample would drag the rate down to ~4.07/s (=> ~22s). After
    // pruning, only the recent pair counts: 5/s over 90 remaining => 18s.
    const samples: JobSample[] = [
      { t: 0, received: 0 },
      { t: 25000, received: 100 },
      { t: 27000, received: 110 },
    ];
    expect(jobs.secondsLeftFromSamples(samples, 200)).toBeCloseTo(18, 6);
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
    expect(jobs.secondsLeftFromSamples(samples, 100)).toBeCloseTo(0.2, 6);
  });

  it("clamps to 0 when received meets or exceeds total", () => {
    const samples: JobSample[] = [
      { t: 0, received: 0 },
      { t: 2000, received: 120 },
    ];
    expect(jobs.secondsLeftFromSamples(samples, 100)).toBe(0);
  });
});

describe("job queue", () => {
  it("runs three jobs at once and keeps the rest queued FIFO", async () => {
    const held = Array.from({ length: 5 }, () => deferred<number>());
    let n = 0;
    mocks.precache.mockImplementation(() => held[n++]!.promise);

    for (const id of ["a", "b", "c", "d", "e"]) jobs.enqueue(prep(id));
    const byItem = (itemId: string) =>
      jobs.jobsStore.get().jobs.find((j) => j.itemId === itemId);

    const list = jobs.jobsStore.get().jobs;
    expect(list.map((j) => j.itemId)).toEqual(["a", "b", "c", "d", "e"]);
    expect(list.map((j) => j.status)).toEqual([
      "running",
      "running",
      "running",
      "queued",
      "queued",
    ]);
    expect(mocks.precache).toHaveBeenCalledTimes(3);

    // Freeing one slot admits exactly one more, the oldest queued.
    held[0]!.resolve(0);
    await flush();
    expect(mocks.precache).toHaveBeenCalledTimes(4);
    expect(byItem("a")?.status).toBe("done");
    expect(byItem("d")?.status).toBe("running");
    expect(byItem("e")?.status).toBe("queued");

    held[1]!.resolve(0);
    await flush();
    expect(mocks.precache).toHaveBeenCalledTimes(5);
    expect(byItem("e")?.status).toBe("running");

    for (const d of held.slice(2)) d.resolve(0);
    await flush();
    expect(jobs.activeCount()).toBe(0);
  });

  it("never runs more than three jobs at once", async () => {
    const pending = Array.from({ length: 3 }, () => deferred<number>());
    let n = 0;
    mocks.precache.mockImplementation(() => pending[n++]?.promise ?? Promise.resolve(0));

    for (let i = 0; i < 8; i++) jobs.enqueue(prep(`item-${i}`));
    await flush();

    expect(mocks.precache).toHaveBeenCalledTimes(3);
    expect(jobs.jobsStore.get().jobs.filter((j) => j.status === "running")).toHaveLength(3);
    expect(jobs.jobsStore.get().jobs.filter((j) => j.status === "queued")).toHaveLength(5);

    for (const p of pending) p.resolve(0);
    await flush();
    expect(jobs.activeCount()).toBe(0);
  });

  it("orders finished entries newest-first behind the active ones", async () => {
    mocks.precache.mockResolvedValue(0);
    jobs.enqueue(prep("a"));
    await flush();
    jobs.enqueue(prep("b"));
    await flush();

    const running = deferred<number>();
    mocks.precache.mockReturnValueOnce(running.promise);
    jobs.enqueue(prep("c"));

    const list = jobs.jobsStore.get().jobs;
    expect(list[0]?.itemId).toBe("c");
    expect(list[0]?.status).toBe("running");
    expect(list.slice(1).map((j) => j.itemId)).toEqual(["b", "a"]);
    running.resolve(0);
    await flush();
  });

  it("returns the existing id for a duplicate itemId+kind and adds nothing", async () => {
    const first = deferred<number>();
    mocks.precache.mockReturnValue(first.promise);

    const id = jobs.enqueue(prep("a"));
    expect(jobs.enqueue(prep("a"))).toBe(id);
    expect(jobs.jobsStore.get().jobs).toHaveLength(1);

    // A different kind for the same item is its own job.
    mocks.exportAudiobook.mockResolvedValue({ dir: "D:/out", chaptersWritten: 2 });
    const exportId = jobs.enqueue(exp("a"));
    expect(exportId).not.toBe(id);
    expect(jobs.jobsStore.get().jobs).toHaveLength(2);

    first.resolve(0);
    await flush();
  });

  it("keeps differently-scoped jobs for one item separate", async () => {
    const first = deferred<number>();
    mocks.precache.mockReturnValue(first.promise);

    // Per-chapter prepares share a book but must queue side by side.
    const ch1 = jobs.enqueue({ ...prep("a"), scope: "ch-1" });
    const ch2 = jobs.enqueue({ ...prep("a"), scope: "ch-2" });
    expect(ch2).not.toBe(ch1);
    expect(jobs.jobsStore.get().jobs).toHaveLength(2);

    // Same scope still dedupes.
    expect(jobs.enqueue({ ...prep("a"), scope: "ch-1" })).toBe(ch1);
    expect(jobs.jobsStore.get().jobs).toHaveLength(2);

    first.resolve(0);
    await flush();
  });

  it("re-enqueues an item once its earlier job finished", async () => {
    mocks.precache.mockResolvedValue(0);
    const id = jobs.enqueue(prep("a"));
    await flush();
    const again = jobs.enqueue(prep("a"));
    expect(again).not.toBe(id);
    await flush();
  });

  it("drops a queued job on cancel without touching IPC", async () => {
    const held = deferred<number>();
    mocks.precache.mockReturnValue(held.promise);

    // Fill the three parallel slots so the fourth is genuinely queued.
    for (const id of ["a", "b", "c"]) jobs.enqueue(prep(id));
    const dId = jobs.enqueue(prep("d"));
    expect(jobs.jobsStore.get().jobs.find((j) => j.id === dId)?.status).toBe("queued");

    jobs.cancelJob(dId);
    expect(jobs.jobsStore.get().jobs.map((j) => j.itemId)).toEqual(["a", "b", "c"]);
    expect(mocks.precacheCancel).not.toHaveBeenCalled();
    expect(jobs.jobForItem("d")).toBeNull();

    held.resolve(0);
    await flush();
    expect(mocks.precache).toHaveBeenCalledTimes(3);
  });

  it("cancels the running job through IPC exactly once, by task id", async () => {
    const first = deferred<number>();
    mocks.precache.mockReturnValue(first.promise);

    const id = jobs.enqueue(prep("a"));
    jobs.cancelJob(id);
    jobs.cancelJob(id);
    expect(mocks.precacheCancel).toHaveBeenCalledTimes(1);
    expect(mocks.precacheCancel).toHaveBeenCalledWith(`job-${id}`);

    first.reject(new Error("Cancelled"));
    await flush();
    expect(jobs.jobsStore.get().jobs[0]?.status).toBe("cancelled");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("cancels one running job without disturbing the others", async () => {
    const held = [deferred<number>(), deferred<number>(), deferred<number>()];
    let n = 0;
    mocks.precache.mockImplementation(() => held[n++]!.promise);

    const [aId, bId, cId] = [
      jobs.enqueue(prep("a")),
      jobs.enqueue(prep("b")),
      jobs.enqueue(prep("c")),
    ];

    jobs.cancelJob(bId);
    expect(mocks.precacheCancel).toHaveBeenCalledTimes(1);
    expect(mocks.precacheCancel).toHaveBeenCalledWith(`job-${bId}`);

    // b settles as cancelled; a and c are untouched and still running.
    held[1]!.resolve(1);
    await flush();
    const byId = (id: string) => jobs.jobsStore.get().jobs.find((j) => j.id === id);
    expect(byId(bId)?.status).toBe("cancelled");
    expect(byId(aId)?.status).toBe("running");
    expect(byId(cId)?.status).toBe("running");

    held[0]!.resolve(0);
    held[2]!.resolve(0);
    await flush();
    expect(byId(aId)?.status).toBe("done");
    expect(byId(cId)?.status).toBe("done");
    expect(mocks.precacheCancel).toHaveBeenCalledTimes(1);
  });

  it("counts a resolved precache as done only when no cancel was requested", async () => {
    // tts_precache RESOLVES when cancelled — it returns the sentences it did
    // finish — so the resolve path must respect the cancel request.
    const cancelled = deferred<number>();
    const clean = deferred<number>();
    mocks.precache.mockReturnValueOnce(cancelled.promise).mockReturnValueOnce(clean.promise);

    const aId = jobs.enqueue(prep("a"));
    const bId = jobs.enqueue(prep("b"));

    jobs.cancelJob(aId);
    cancelled.resolve(7); // partial count, not a rejection
    clean.resolve(2);
    await flush();

    const byId = (id: string) => jobs.jobsStore.get().jobs.find((j) => j.id === id);
    expect(byId(aId)?.status).toBe("cancelled");
    expect(byId(bId)?.status).toBe("done");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("routes parallel progress events to the job named by the task id", async () => {
    const held = [deferred<number>(), deferred<number>()];
    let n = 0;
    mocks.precache.mockImplementation(() => held[n++]!.promise);

    const aId = jobs.enqueue(prep("a", ["one", "two", "three", "four"]));
    const bId = jobs.enqueue(prep("b", ["one", "two", "three", "four"]));

    emitProgress(`job-${aId}`, 3);
    emitProgress(`job-${bId}`, 1);
    // A backend total overrides the local estimate — for that job only.
    emitProgress(`job-${bId}`, 2, 9);
    // Foreign task ids (voice/model installs) and unknown jobs are ignored.
    emitProgress("voice-install", 99, 99);
    emitProgress("job-nope", 99, 99);
    await settlePublish();

    const byId = (id: string) => jobs.jobsStore.get().jobs.find((j) => j.id === id);
    expect(byId(aId)?.received).toBe(3);
    expect(byId(bId)?.received).toBe(2);
    expect(byId(aId)?.total).toBe(4);
    expect(byId(bId)?.total).toBe(9);
    expect(jobs.jobsStore.get().jobs).toHaveLength(2);

    held[0]!.resolve(0);
    held[1]!.resolve(0);
    await flush();
  });

  it("treats a cancel-shaped rejection as cancelled and anything else as failed", async () => {
    mocks.precache.mockRejectedValueOnce(new Error("Synthesis failed: 403"));
    jobs.enqueue(prep("a"));
    await flush();
    const failed = jobs.jobsStore.get().jobs[0]!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Synthesis failed: 403");
    expect(mocks.toastError).toHaveBeenCalledWith("Synthesis failed: 403");

    mocks.precache.mockRejectedValueOnce(new Error("Cancelled"));
    jobs.enqueue(prep("b"));
    await flush();
    expect(jobs.jobsStore.get().jobs[0]?.status).toBe("cancelled");
  });

  it("records the export result and totals sentences plus stitched chapters", async () => {
    mocks.exportAudiobook.mockResolvedValue({ dir: "D:/out/Book a", chaptersWritten: 2 });
    jobs.enqueue(exp("a"));
    // 3 sentences + 2 chapter stitches.
    expect(jobs.jobsStore.get().jobs[0]?.total).toBe(5);
    await flush();

    const job = jobs.jobsStore.get().jobs[0]!;
    expect(job.status).toBe("done");
    expect(job.resultDir).toBe("D:/out/Book a");
    expect(job.chaptersWritten).toBe(2);
    expect(job.received).toBe(5);
    expect(mocks.toastInfo).toHaveBeenCalledWith("Audiobook exported");

    const req = mocks.exportAudiobook.mock.calls[0]![0] as { taskId: string; bookTitle: string };
    expect(req.taskId).toBe(`job-${job.id}`);
    expect(req.bookTitle).toBe("Book a");
  });

  it("keeps at most 20 finished entries, dropping the oldest", async () => {
    mocks.precache.mockResolvedValue(0);
    for (let i = 0; i < 22; i++) jobs.enqueue(prep(`item-${i}`));
    await flush();

    const list = jobs.jobsStore.get().jobs;
    expect(list).toHaveLength(20);
    expect(jobs.activeCount()).toBe(0);
    // The two earliest (item-0, item-1) aged out.
    const ids = list.map((j) => j.itemId);
    expect(ids).not.toContain("item-0");
    expect(ids).not.toContain("item-1");
    expect(ids).toContain("item-2");
    expect(ids[0]).toBe("item-21");
  });

  it("clearFinished drops only settled entries", async () => {
    mocks.precache.mockResolvedValue(0);
    jobs.enqueue(prep("a"));
    await flush();

    const running = deferred<number>();
    mocks.precache.mockReturnValueOnce(running.promise);
    jobs.enqueue(prep("b"));
    jobs.enqueue(prep("c"));

    jobs.clearFinished();
    expect(jobs.jobsStore.get().jobs.map((j) => j.itemId)).toEqual(["b", "c"]);

    running.resolve(0);
    await flush();
  });

  it("jobForItem prefers the running job and activeCount counts both states", async () => {
    const running = deferred<number>();
    const exportRunning = deferred<{ dir: string; chaptersWritten: number }>();
    mocks.precache.mockReturnValue(running.promise);
    mocks.exportAudiobook.mockReturnValue(exportRunning.promise);

    // Three fill the parallel slots; "b" lands behind them, still queued.
    jobs.enqueue(prep("a"));
    jobs.enqueue(exp("a"));
    jobs.enqueue(prep("filler"));
    jobs.enqueue(prep("b"));

    expect(jobs.activeCount()).toBe(4);
    expect(jobs.jobForItem("a")?.kind).toBe("prepare");
    expect(jobs.jobForItem("a")?.status).toBe("running");
    expect(jobs.jobForItem("b")?.status).toBe("queued");
    expect(jobs.jobForItem("nope")).toBeNull();

    running.resolve(0);
    exportRunning.resolve({ dir: "D:/out", chaptersWritten: 2 });
    await flush();
    expect(jobs.activeCount()).toBe(0);
    expect(jobs.jobForItem("a")).toBeNull();
  });

  it("estimateSecondsLeft is null for unknown and settled jobs", async () => {
    mocks.precache.mockResolvedValue(0);
    const id = jobs.enqueue(prep("a"));
    expect(jobs.estimateSecondsLeft(id)).toBeNull(); // no samples yet
    await flush();
    expect(jobs.estimateSecondsLeft(id)).toBeNull(); // finished
    expect(jobs.estimateSecondsLeft("missing")).toBeNull();
  });
});
