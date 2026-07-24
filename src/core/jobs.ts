// The audio-job queue — one owner for "prepare audio" and "export audiobook"
// work across the whole app. The backend runs jobs in parallel, registering
// each under its own task id and cancelling them individually, while a shared
// per-provider permit pool keeps total synthesis bounded. This queue therefore
// runs a few jobs side by side and lines the rest up behind them.
//
// This module also owns completion feedback (toasts + the OS notification) so
// it fires wherever the user happens to be — the library grid, the reader, or
// the Activity screen. Nothing runs at idle: the progress listener is
// registered on the first enqueue and there are no timers between jobs.

import { describeError, ipc, onDownloadProgress, type DownloadProgress } from "./ipc";
import { settingsStore } from "./session";
import { Store } from "./store";
import type { ProviderId } from "./types";
import { toast } from "../ui/toast";

export type JobKind = "export" | "prepare";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** Pre-synthesize every sentence of a book into the audio cache. */
export interface PrepareSpec {
  kind: "prepare";
  itemId: string;
  title: string;
  cover?: string;
  provider: ProviderId;
  voiceId: string;
  texts: string[];
  /** Distinguishes partial jobs for the same book (e.g. "ch-3" for a single
   *  chapter) so they queue alongside each other instead of deduping into one. */
  scope?: string;
}

/** Write a book out as per-chapter tagged MP3 files. */
export interface ExportSpec {
  kind: "export";
  itemId: string;
  title: string;
  cover?: string;
  provider: ProviderId;
  voiceId: string;
  author: string | null;
  chapters: { title: string; texts: string[] }[];
  destDir: string;
  scope?: string;
}

export type JobSpec = PrepareSpec | ExportSpec;

export interface Job {
  id: string;
  kind: JobKind;
  itemId: string;
  title: string;
  cover?: string;
  scope?: string;
  status: JobStatus;
  received: number;
  total: number;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  resultDir?: string;
  chaptersWritten?: number;
}

export interface JobsState {
  jobs: Job[];
}

/** Task ids the backend echoes back on download-progress events. Voice and
 *  model installs share that event, so everything else is ignored. */
const TASK_PREFIX = "job-";

/** Finished entries are history, not state — keep the list short. */
const MAX_FINISHED = 20;

/** How many jobs run at once. Enough that a quick chapter prepare never sits
 *  behind a 50-hour book; few enough that the Activity list stays readable and
 *  each running job still visibly progresses. Resource use doesn't scale with
 *  this: the backend caps concurrent synthesis per provider regardless. */
const MAX_PARALLEL_JOBS = 3;

/** The backend emits roughly every 300ms; this only guards against a burst. */
const PUBLISH_MS = 200;

const WINDOW_MS = 20_000;
const MAX_SAMPLES = 50;
const MIN_SPAN_MS = 1_500;

export interface JobSample {
  /** Event timestamp in ms (Date.now()). */
  t: number;
  /** Units completed so far (sentences, plus stitched chapters on export). */
  received: number;
}

/**
 * Honest, jitter-resistant seconds-left estimate over a rolling sample window.
 * Pure: prunes the given samples to the last 20s (max 50 most recent), then
 * extrapolates a positive completion rate. Returns null whenever there isn't
 * enough trustworthy signal, so callers render an "estimating" state instead of
 * a number that would jump around.
 */
export function secondsLeftFromSamples(samples: JobSample[], total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1]!;
  const cutoff = last.t - WINDOW_MS;
  let window = samples.filter((s) => s.t >= cutoff);
  if (window.length > MAX_SAMPLES) window = window.slice(window.length - MAX_SAMPLES);
  if (window.length < 2) return null;
  const first = window[0]!;
  const spanMs = last.t - first.t;
  if (spanMs < MIN_SPAN_MS) return null;
  const rate = (last.received - first.received) / (spanMs / 1000);
  if (!(rate > 0)) return null;
  return Math.max(0, (total - last.received) / rate);
}

/* ================= internal queue state ================= */

interface Entry {
  id: string;
  /** Insertion order — FIFO among queued entries, tiebreak everywhere else. */
  seq: number;
  spec: JobSpec;
  kind: JobKind;
  itemId: string;
  title: string;
  cover?: string;
  scope?: string;
  status: JobStatus;
  received: number;
  total: number;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  resultDir?: string;
  chaptersWritten?: number;
  /** True once a cancel was requested for this entry (IPC is fired once). */
  cancelRequested: boolean;
  samples: JobSample[];
}

const entries = new Map<string, Entry>();
let seqCounter = 0;
let idCounter = 0;
let listening = false;
let pubTimer: ReturnType<typeof setTimeout> | null = null;
let lastPublish = 0;

export const jobsStore = new Store<JobsState>({ jobs: [] });

function newId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** Units the backend counts: one per sentence, plus one per stitched chapter. */
function specTotal(spec: JobSpec): number {
  if (spec.kind === "prepare") return spec.texts.length;
  return spec.chapters.reduce((n, c) => n + c.texts.length, 0) + spec.chapters.length;
}

function isActive(status: JobStatus): boolean {
  return status === "running" || status === "queued";
}

function rank(status: JobStatus): number {
  if (status === "running") return 0;
  return status === "queued" ? 1 : 2;
}

function toJob(e: Entry): Job {
  return {
    id: e.id,
    kind: e.kind,
    itemId: e.itemId,
    title: e.title,
    cover: e.cover,
    scope: e.scope,
    status: e.status,
    received: e.received,
    total: e.total,
    queuedAt: e.queuedAt,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    error: e.error,
    resultDir: e.resultDir,
    chaptersWritten: e.chaptersWritten,
  };
}

/** Running first, then queued FIFO, then finished newest-first. */
function snapshot(): Job[] {
  return [...entries.values()]
    .sort((a, b) => {
      const r = rank(a.status) - rank(b.status);
      if (r !== 0) return r;
      if (rank(a.status) === 2) {
        const t = (b.endedAt ?? 0) - (a.endedAt ?? 0);
        return t !== 0 ? t : b.seq - a.seq;
      }
      return a.seq - b.seq;
    })
    .map(toJob);
}

function publish(): void {
  if (pubTimer !== null) {
    clearTimeout(pubTimer);
    pubTimer = null;
  }
  lastPublish = Date.now();
  jobsStore.set({ jobs: snapshot() });
}

/** Progress ticks coalesce; every state transition publishes immediately. */
function publishThrottled(): void {
  if (pubTimer !== null) return;
  const wait = PUBLISH_MS - (Date.now() - lastPublish);
  if (wait <= 0) {
    publish();
    return;
  }
  pubTimer = setTimeout(() => {
    pubTimer = null;
    publish();
  }, wait);
}

function trimFinished(): void {
  const finished = [...entries.values()].filter((e) => !isActive(e.status));
  if (finished.length <= MAX_FINISHED) return;
  finished.sort((a, b) => {
    const t = (a.endedAt ?? 0) - (b.endedAt ?? 0);
    return t !== 0 ? t : a.seq - b.seq;
  });
  for (const e of finished.slice(0, finished.length - MAX_FINISHED)) entries.delete(e.id);
}

/* ================= completion feedback ================= */

/** Post-export OS notification (best-effort; gated on the notifications
 *  setting, mirroring the Rust close-to-tray notification). */
async function notifyExported(title: string, dir: string): Promise<void> {
  if (!settingsStore.get().notifications) return;
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      "@tauri-apps/plugin-notification"
    );
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title: "Audiobook exported", body: `${title} · ${dir}` });
  } catch {
    // Notifications are a nicety — never let one break the export flow.
  }
}

function announce(e: Entry): void {
  if (e.status === "done") {
    if (e.kind === "export") {
      toast.info("Audiobook exported");
      if (e.resultDir) void notifyExported(e.title, e.resultDir);
    } else {
      toast.info(`Audio ready — ${e.title}`);
    }
    return;
  }
  if (e.status === "cancelled") {
    // A cancelled export still leaves the chapters it already wrote on disk;
    // a cancelled prepare just stops filling the cache, which needs no words.
    if (e.kind === "export") toast.info("Export cancelled — finished chapters were kept");
    return;
  }
  if (e.status === "failed" && e.error) toast.error(e.error);
}

/* ================= runner ================= */

function handleProgress(p: DownloadProgress): void {
  if (!p.taskId.startsWith(TASK_PREFIX)) return;
  const e = entries.get(p.taskId.slice(TASK_PREFIX.length));
  if (!e || e.status !== "running") return;
  // Terminal state comes from the awaited call, which carries the result or the
  // real error message; the done event would only race it.
  if (p.done) return;

  e.received = p.received;
  if (typeof p.total === "number" && p.total > 0) e.total = p.total;

  const now = Date.now();
  e.samples.push({ t: now, received: p.received });
  const cutoff = now - WINDOW_MS;
  while (e.samples.length > 0 && (e.samples[0]!.t < cutoff || e.samples.length > MAX_SAMPLES)) {
    e.samples.shift();
  }
  publishThrottled();
}

function ensureListener(): void {
  if (listening) return;
  listening = true;
  void onDownloadProgress(handleProgress);
}

function finish(e: Entry, status: JobStatus, error?: string): void {
  e.status = status;
  e.endedAt = Date.now();
  if (status === "done") e.received = e.total;
  if (status === "failed" && error) e.error = error;
  e.samples.length = 0;
  trimFinished();
  publish();
  announce(e);
}

async function run(e: Entry): Promise<void> {
  const taskId = `${TASK_PREFIX}${e.id}`;
  const spec = e.spec;
  try {
    if (spec.kind === "prepare") {
      await ipc.precache(spec.provider, spec.voiceId, spec.texts, taskId, e.title);
    } else {
      const result = await ipc.exportAudiobook({
        itemId: spec.itemId,
        provider: spec.provider,
        voiceId: spec.voiceId,
        bookTitle: e.title,
        author: spec.author,
        chapters: spec.chapters,
        destDir: spec.destDir,
        taskId,
        label: e.title,
      });
      e.resultDir = result.dir;
      e.chaptersWritten = result.chaptersWritten;
    }
    // tts_precache resolves normally when cancelled (it returns however many
    // sentences it managed), so a resolved call is only "done" if nobody
    // asked to stop it.
    finish(e, e.cancelRequested ? "cancelled" : "done");
  } catch (err) {
    const msg = describeError(err);
    // A cancel rejects the same call the job is awaiting — that's a settled
    // outcome, not a failure worth an error toast.
    finish(e, e.cancelRequested || /cancel/i.test(msg) ? "cancelled" : "failed", msg);
  }
  drain();
}

/** Fill the free parallel slots from the queue, oldest first. */
function drain(): void {
  let running = 0;
  const queued: Entry[] = [];
  for (const e of entries.values()) {
    if (e.status === "running") running += 1;
    else if (e.status === "queued") queued.push(e);
  }
  const slots = MAX_PARALLEL_JOBS - running;
  if (slots <= 0 || queued.length === 0) return;

  queued.sort((a, b) => a.seq - b.seq);
  const starting = queued.slice(0, slots);
  const now = Date.now();
  for (const e of starting) {
    e.status = "running";
    e.startedAt = now;
    e.samples.length = 0;
  }
  // One publish for the whole batch, then hand them to the backend. Each job
  // carries its own `job-<id>` task id, so their progress events and cancels
  // stay independent.
  publish();
  for (const e of starting) void run(e);
}

/* ================= public API ================= */

/** Enqueue; starts running immediately when a parallel slot is free. If an
 *  active (queued|running) job with the same itemId+kind+scope exists, returns
 *  that job's id and adds nothing. */
export function enqueue(spec: JobSpec): string {
  for (const e of entries.values()) {
    if (
      e.itemId === spec.itemId &&
      e.kind === spec.kind &&
      e.spec.scope === spec.scope &&
      isActive(e.status)
    ) {
      return e.id;
    }
  }
  ensureListener();
  seqCounter += 1;
  const id = newId();
  entries.set(id, {
    id,
    seq: seqCounter,
    spec,
    kind: spec.kind,
    itemId: spec.itemId,
    title: spec.title,
    cover: spec.cover,
    scope: spec.scope,
    status: "queued",
    received: 0,
    total: specTotal(spec),
    queuedAt: Date.now(),
    cancelRequested: false,
    samples: [],
  });
  publish();
  drain();
  return id;
}

/** Queued → drop it. Running → cancel just that task. Finished → no-op. */
export function cancelJob(jobId: string): void {
  const e = entries.get(jobId);
  if (!e) return;
  if (e.status === "queued") {
    entries.delete(jobId);
    publish();
    return;
  }
  if (e.status !== "running" || e.cancelRequested) return;
  e.cancelRequested = true;
  // Cancel by task id so the other running jobs keep going. A rejection here
  // (this job just finished) is harmless.
  void ipc.precacheCancel(`${TASK_PREFIX}${e.id}`).catch(() => {});
}

/** Drop all finished (done|failed|cancelled) entries. */
export function clearFinished(): void {
  let changed = false;
  for (const e of [...entries.values()]) {
    if (!isActive(e.status)) {
      entries.delete(e.id);
      changed = true;
    }
  }
  if (changed) publish();
}

/** Running or queued job for an item, else null (drives the card overlay). */
export function jobForItem(itemId: string): Job | null {
  let queued: Entry | null = null;
  for (const e of entries.values()) {
    if (e.itemId !== itemId) continue;
    if (e.status === "running") return toJob(e);
    if (e.status === "queued" && (queued === null || e.seq < queued.seq)) queued = e;
  }
  return queued === null ? null : toJob(queued);
}

/** running + queued count (drives the Activity button badge). */
export function activeCount(): number {
  let n = 0;
  for (const e of entries.values()) if (isActive(e.status)) n += 1;
  return n;
}

/** Rolling-window rate estimate for a running job; null when not yet reliable. */
export function estimateSecondsLeft(jobId: string): number | null {
  const e = entries.get(jobId);
  if (!e || e.status !== "running") return null;
  return secondsLeftFromSamples(e.samples, e.total);
}
