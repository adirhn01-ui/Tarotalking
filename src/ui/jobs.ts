// Global audio-job progress chip — a floating, expandable indicator that
// surfaces export / prepare-audio progress from any screen, with a stable
// time-left estimate and a shared cancel. It self-creates a layer on the first
// job event and removes it entirely when no job is running: nothing in the DOM
// and zero work at idle.

import { ipc, onDownloadProgress, type DownloadProgress } from "../core/ipc";
import { formatPct, formatTimeLeft } from "../core/format";

/** Only the two single-slot audio jobs; voice installs have their own UI. */
const AUDIO_JOB = /^(export-item|precache-item)-/;

const WINDOW_MS = 20_000;
const MAX_SAMPLES = 50;
const MIN_SPAN_MS = 1_500;
const TERMINAL_MS = 1_200;

const RING_R = 9;
const RING_C = 2 * Math.PI * RING_R;

export interface JobSample {
  /** Event timestamp in ms (Date.now()). */
  t: number;
  /** Units completed so far (sentences + stitched chapters). */
  received: number;
}

/**
 * Honest, jitter-resistant seconds-left estimate over a rolling sample window.
 * Pure: prunes the given samples to the last 20s (max 50 most recent), then
 * extrapolates a positive completion rate. Returns null whenever there isn't
 * enough trustworthy signal, so callers render an "estimating" state instead of
 * a number that would jump around.
 */
export function estimateSecondsLeft(samples: JobSample[], total: number): number | null {
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

/** "42% · about 3 min left" tail — never a raw seconds countdown that jitters. */
function etaLabel(secondsLeft: number | null): string {
  if (secondsLeft === null) return "estimating time left";
  if (secondsLeft < 60) return "under a minute left";
  return `about ${formatTimeLeft(secondsLeft / 60)} left`;
}

type Kind = "export" | "precache";

interface JobState {
  taskId: string;
  kind: Kind;
  label: string;
  received: number;
  total: number | null;
  samples: JobSample[];
}

interface ChipEls {
  root: HTMLElement;
  header: HTMLButtonElement;
  ringFill: SVGCircleElement;
  label: HTMLElement;
  title: HTMLElement;
  barFill: HTMLElement;
  eta: HTMLElement;
  cancel: HTMLButtonElement;
  onDocPointer: (e: Event) => void;
  onDocKey: (e: KeyboardEvent) => void;
}

let layer: ChipEls | null = null;
let job: JobState | null = null;
let expanded = false;
let cancelling = false;
let terminalTimer: number | null = null;
let started = false;

function ensureLayer(): ChipEls {
  if (layer && layer.root.isConnected) return layer;

  const root = document.createElement("div");
  root.className = "jobs-chip";
  root.innerHTML = `
    <button class="jobs-chip__header" type="button" aria-expanded="false" title="Audio job progress">
      <svg class="jobs-chip__ring" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <circle class="jobs-chip__ring-track" cx="12" cy="12" r="${RING_R}" fill="none" stroke-width="2.5"></circle>
        <circle class="jobs-chip__ring-fill" cx="12" cy="12" r="${RING_R}" fill="none" stroke-width="2.5"
          stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}"></circle>
      </svg>
      <span class="jobs-chip__label"></span>
    </button>
    <div class="jobs-chip__panel">
      <div class="jobs-chip__title"></div>
      <div class="jobs-chip__bar"><span></span></div>
      <div class="jobs-chip__eta"></div>
      <button class="btn btn--sm jobs-chip__cancel" type="button">Cancel</button>
    </div>`;
  document.body.appendChild(root);

  const els: ChipEls = {
    root,
    header: root.querySelector(".jobs-chip__header")!,
    ringFill: root.querySelector(".jobs-chip__ring-fill")!,
    label: root.querySelector(".jobs-chip__label")!,
    title: root.querySelector(".jobs-chip__title")!,
    barFill: root.querySelector(".jobs-chip__bar > span")!,
    eta: root.querySelector(".jobs-chip__eta")!,
    cancel: root.querySelector(".jobs-chip__cancel")!,
    onDocPointer: () => {},
    onDocKey: () => {},
  };

  els.header.addEventListener("click", () => toggle());
  els.cancel.addEventListener("click", () => doCancel());

  // Collapse on an outside click or Esc — only while expanded, so the reader's
  // own Esc handling is untouched the rest of the time.
  els.onDocPointer = (e) => {
    if (expanded && !root.contains(e.target as Node)) collapse();
  };
  els.onDocKey = (e) => {
    if (expanded && e.key === "Escape") {
      e.stopPropagation();
      collapse();
      els.header.focus();
    }
  };
  document.addEventListener("pointerdown", els.onDocPointer, true);
  document.addEventListener("keydown", els.onDocKey, true);

  layer = els;
  return els;
}

function removeLayer(): void {
  if (!layer) return;
  document.removeEventListener("pointerdown", layer.onDocPointer, true);
  document.removeEventListener("keydown", layer.onDocKey, true);
  layer.root.remove();
  layer = null;
  expanded = false;
  cancelling = false;
}

function toggle(): void {
  if (!job) return;
  expanded = !expanded;
  render();
}

function collapse(): void {
  if (!expanded) return;
  expanded = false;
  render();
}

function doCancel(): void {
  if (cancelling) return;
  cancelling = true;
  if (layer) {
    layer.cancel.disabled = true;
    layer.cancel.textContent = "Cancelling";
  }
  // Shared one-slot cancel for both job kinds; a rejection here is harmless.
  void ipc.precacheCancel().catch(() => {});
}

function render(): void {
  if (!layer || !job) return;
  const els = layer;
  const j = job;

  els.root.classList.toggle("jobs-chip--expanded", expanded);
  els.header.setAttribute("aria-expanded", String(expanded));

  const frac = j.total && j.total > 0 ? Math.min(1, j.received / j.total) : null;
  const pctText = frac === null ? "" : formatPct(frac);
  const kindWord = j.kind === "export" ? "Exporting" : "Preparing";

  els.ringFill.style.strokeDashoffset = String(RING_C * (1 - (frac ?? 0)));

  // Collapsed pill stays minimal ("Exporting · 42%"); the expanded header names
  // the job kind in full, with the numbers moving down into the panel.
  els.label.textContent = expanded
    ? j.kind === "export"
      ? "Exporting audiobook"
      : "Preparing audio"
    : pctText
      ? `${kindWord} · ${pctText}`
      : kindWord;

  els.title.textContent = j.label;
  els.barFill.style.width = `${(frac ?? 0) * 100}%`;
  const secs = estimateSecondsLeft(j.samples, j.total ?? 0);
  els.eta.textContent = pctText ? `${pctText} · ${etaLabel(secs)}` : etaLabel(secs);
}

function showTerminal(p: DownloadProgress): void {
  if (!layer) return;
  const els = layer;

  // A dangling Cancel makes no sense once the job is over — settle to a clean
  // final pill regardless of whether the panel was open.
  expanded = false;
  els.root.classList.remove("jobs-chip--expanded", "jobs-chip--error");
  els.header.setAttribute("aria-expanded", "false");

  let word: string;
  if (p.error === "Cancelled") {
    word = "Cancelled";
    els.root.classList.add("jobs-chip--error");
  } else if (p.error) {
    word = "Failed";
    els.root.classList.add("jobs-chip--error");
  } else {
    word = "Done";
    els.ringFill.style.strokeDashoffset = "0";
  }
  els.label.textContent = word;

  terminalTimer = window.setTimeout(() => {
    terminalTimer = null;
    job = null;
    removeLayer();
  }, TERMINAL_MS);
}

function handleProgress(p: DownloadProgress): void {
  if (!AUDIO_JOB.test(p.taskId)) return;
  const kind: Kind = p.taskId.startsWith("export-item") ? "export" : "precache";

  if (!job || job.taskId !== p.taskId) {
    // A fresh job supersedes any lingering terminal display.
    if (terminalTimer !== null) {
      clearTimeout(terminalTimer);
      terminalTimer = null;
    }
    job = { taskId: p.taskId, kind, label: p.label, received: p.received, total: p.total, samples: [] };
    expanded = false;
    cancelling = false;
    const els = ensureLayer();
    els.cancel.disabled = false;
    els.cancel.textContent = "Cancel";
  } else {
    job.label = p.label;
    job.received = p.received;
    job.total = p.total;
    ensureLayer();
  }

  if (!p.done) {
    // A live update cancels any pending removal (e.g. a new job right after one
    // finished) and feeds the rolling ETA window.
    if (terminalTimer !== null) {
      clearTimeout(terminalTimer);
      terminalTimer = null;
    }
    const now = Date.now();
    job.samples.push({ t: now, received: p.received });
    const cutoff = now - WINDOW_MS;
    while (job.samples.length > 0 && (job.samples[0]!.t < cutoff || job.samples.length > MAX_SAMPLES)) {
      job.samples.shift();
    }
  }

  render();
  if (p.done) showTerminal(p);
}

/** Register the app-wide job listener once. Renders nothing until a job runs. */
export function initJobsChip(): void {
  if (started) return;
  started = true;
  void onDownloadProgress(handleProgress);
}
