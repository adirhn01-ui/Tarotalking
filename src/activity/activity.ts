// Activity screen — a full page for audio jobs: audiobook exports and
// prepared-audio runs. What is running now, what is waiting behind it, and
// what recently finished. Progress lives on its own screen instead of floating
// over the app, so a long export never covers what is being read.
//
// Rendering budget: exactly one subscription to jobsStore, no timers and no
// polling. The two lists are rebuilt only when the set of rows or a row's
// status changes; an ordinary progress tick patches that row's bar width and
// metrics text in place. The ETA is refreshed on those same progress events —
// it never counts down on its own.

import "./activity.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import { escapeHtml, formatPct, formatTimeLeft } from "../core/format";
import { describeError, ipc } from "../core/ipc";
import { cancelJob, clearFinished, estimateSecondsLeft, jobsStore, type Job } from "../core/jobs";
import { navigate } from "../core/nav";
import { icon } from "../ui/icons";
import { toast } from "../ui/toast";

export interface ActivityView {
  dispose(): void;
}

/* ================= pure helpers ================= */

/** Running or queued — the rows that still have work ahead of them. */
export function isActive(job: Job): boolean {
  return job.status === "running" || job.status === "queued";
}

/** Progress as 0..1; 0 while the total is still unknown. */
export function progressFraction(job: Job): number {
  if (!Number.isFinite(job.total) || job.total <= 0) return 0;
  return Math.max(0, Math.min(1, job.received / job.total));
}

/** What a row's units are called. An export counts one unit per stitched
 *  chapter on top of its sentences, so "sentences" would misname the number. */
export function unitWord(kind: Job["kind"]): string {
  return kind === "export" ? "steps" : "sentences";
}

/** The one-line description of what a row is doing. */
export function actionLabel(job: Job): string {
  switch (job.status) {
    case "queued":
      return "Queued";
    case "running":
      return job.kind === "export" ? "Exporting audiobook" : "Preparing audio";
    case "done":
      return job.kind === "export" ? "Exported" : "Audio ready";
    case "cancelled":
      return "Cancelled";
    default:
      return "Failed";
  }
}

/** Never a raw seconds countdown — that jitters on every tick. */
export function etaLabel(secondsLeft: number | null): string {
  if (secondsLeft === null) return "estimating time left";
  if (secondsLeft < 60) return "under a minute left";
  return `about ${formatTimeLeft(secondsLeft / 60)} left`;
}

/** "took 4 min" for a finished run; empty when the timestamps are missing. */
export function durationLabel(job: Job): string {
  const { startedAt, endedAt } = job;
  if (startedAt === undefined || endedAt === undefined || endedAt < startedAt) return "";
  return `took ${formatTimeLeft((endedAt - startedAt) / 60_000)}`;
}

/** Keep both ends of a long path readable: "C:\Users\me\M…\Books\Dune". */
export function middleTruncate(s: string, max = 52): string {
  if (max < 2 || s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${s.slice(0, head)}…${tail > 0 ? s.slice(s.length - tail) : ""}`;
}

/** The metrics line: percent, counts, then either the estimate or the run time. */
export function metricsText(job: Job): string {
  const parts: string[] = [];
  if (job.status === "done" && job.kind === "export" && job.chaptersWritten) {
    parts.push(job.chaptersWritten === 1 ? "1 chapter" : `${job.chaptersWritten} chapters`);
  } else if (Number.isFinite(job.total) && job.total > 0) {
    parts.push(formatPct(progressFraction(job)));
    parts.push(`${job.received} of ${job.total} ${unitWord(job.kind)}`);
  }
  if (job.status === "running") {
    parts.push(etaLabel(estimateSecondsLeft(job.id)));
  } else if (!isActive(job)) {
    const took = durationLabel(job);
    if (took) parts.push(took);
  }
  return parts.join(" · ");
}

/** First words of a title, for the placeholder cover. */
function firstWords(s: string, n: number): string {
  return s.split(/\s+/).filter(Boolean).slice(0, n).join(" ");
}

/* ================= row markup ================= */

function coverHtml(job: Job): string {
  if (job.cover) {
    return `<img class="act-row__img" src="${escapeHtml(convertFileSrc(job.cover))}" alt="" loading="lazy" />`;
  }
  return `<div class="act-row__blank"><span>${escapeHtml(firstWords(job.title, 2))}</span></div>`;
}

function rowHtml(job: Job, cancelling: boolean): string {
  const active = isActive(job);
  const pct = Math.round(progressFraction(job) * 100);

  const bar = active
    ? `<div class="act-row__bar" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
         <span class="act-row__bar-fill" style="width: ${pct}%"></span>
       </div>`
    : "";

  const dest =
    job.status === "done" && job.kind === "export" && job.resultDir
      ? `<div class="act-row__dest">
           <span class="act-row__path" title="${escapeHtml(job.resultDir)}">${escapeHtml(middleTruncate(job.resultDir))}</span>
           <button type="button" class="btn btn--sm" data-act="folder">${icon.folder}Show in folder</button>
         </div>`
      : "";

  const failure =
    job.status === "failed" && job.error
      ? `<div class="act-row__error">${escapeHtml(job.error)}</div>`
      : "";

  const cancel = active
    ? `<div class="act-row__aside">
         <button type="button" class="btn btn--sm" data-act="cancel"${cancelling ? " disabled" : ""}>${
           cancelling ? "Cancelling" : "Cancel"
         }</button>
       </div>`
    : "";

  return `<article class="card act-row act-row--${job.status}" data-job-id="${escapeHtml(job.id)}">
      <div class="act-row__cover">${coverHtml(job)}</div>
      <div class="act-row__main">
        <div class="act-row__title">${escapeHtml(job.title)}</div>
        <div class="act-row__action">${escapeHtml(actionLabel(job))}</div>
        ${bar}
        <div class="act-row__metrics">${escapeHtml(metricsText(job))}</div>
        ${dest}
        ${failure}
      </div>
      ${cancel}
    </article>`;
}

function shellHtml(): string {
  return `
    <header class="act__topbar">
      <button type="button" class="btn btn--icon btn--ghost" id="act-back" title="Back to library" aria-label="Back to library">${icon.back}</button>
      <div class="act__topbar-title">Activity</div>
      <div class="act__spacer"></div>
      <button type="button" class="btn btn--ghost btn--sm" id="act-clear" hidden>Clear finished</button>
    </header>
    <div class="act__body">
      <div class="act__inner">
        <section class="act__section" id="act-active" hidden aria-labelledby="act-active-head">
          <h2 class="act__section-head" id="act-active-head">In progress</h2>
          <div class="act__list" id="act-active-list"></div>
        </section>
        <section class="act__section" id="act-recent" hidden aria-labelledby="act-recent-head">
          <h2 class="act__section-head" id="act-recent-head">Recent</h2>
          <div class="act__list" id="act-recent-list"></div>
        </section>
        <div class="empty-state act__empty" id="act-empty" hidden>
          ${icon.headphones}
          <div class="act__empty-title">Nothing in progress</div>
          <div class="act__empty-sub">Audiobook exports and prepared audio report their progress here. Start one from a book's menu in the library, or from a chapter in its contents.</div>
          <button type="button" class="btn" data-act="library">Back to library</button>
        </div>
      </div>
    </div>`;
}

/* ================= view ================= */

export function mountActivity(el: HTMLElement): ActivityView {
  const root = document.createElement("div");
  root.className = "act no-select";
  root.innerHTML = shellHtml();
  el.appendChild(root);

  const activeSec = root.querySelector<HTMLElement>("#act-active")!;
  const activeList = root.querySelector<HTMLElement>("#act-active-list")!;
  const recentSec = root.querySelector<HTMLElement>("#act-recent")!;
  const recentList = root.querySelector<HTMLElement>("#act-recent-list")!;
  const emptyEl = root.querySelector<HTMLElement>("#act-empty")!;
  const clearBtn = root.querySelector<HTMLButtonElement>("#act-clear")!;

  root
    .querySelector<HTMLButtonElement>("#act-back")!
    .addEventListener("click", () => navigate({ view: "library" }));
  clearBtn.addEventListener("click", () => clearFinished());

  // Ids of jobs whose Cancel was pressed but which are still finishing, so a
  // rebuild does not resurrect a live "Cancel" button.
  const cancelling = new Set<string>();
  // Destination folders by job id — the path stays out of the DOM's data
  // attributes and is read straight from state when the button is used.
  const resultDirs = new Map<string, string>();
  // What each rendered row currently shows, so a tick can skip untouched rows.
  const shown = new Map<string, { received: number; total: number }>();
  // null, not "": an empty job list also keys to "", and starting equal to it
  // would skip the very first render and leave the page blank.
  let signature: string | null = null;

  // Rows are replaced wholesale whenever the list changes shape, so per-row
  // listeners would need rebinding every time: one delegated handler instead.
  const onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    const btn = target?.closest<HTMLElement>("[data-act]");
    if (!btn || !root.contains(btn)) return;
    const act = btn.dataset.act;

    if (act === "library") {
      navigate({ view: "library" });
      return;
    }

    const id = btn.closest<HTMLElement>("[data-job-id]")?.dataset.jobId;
    if (!id) return;

    if (act === "cancel") {
      cancelling.add(id);
      const b = btn as HTMLButtonElement;
      b.disabled = true;
      b.textContent = "Cancelling";
      cancelJob(id);
    } else if (act === "folder") {
      const dir = resultDirs.get(id);
      if (dir) void ipc.showInFolder(dir).catch((err) => toast.error(describeError(err)));
    }
  };
  root.addEventListener("click", onClick);

  /** Identity + status of every row: the only things a full rebuild is for. */
  function structureKey(jobs: readonly Job[]): string {
    let key = "";
    for (const j of jobs) key += `${j.id}\u0000${j.status}\u0001`;
    return key;
  }

  function renderAll(jobs: readonly Job[]): void {
    const active: Job[] = [];
    const recent: Job[] = [];
    for (const j of jobs) (isActive(j) ? active : recent).push(j);

    // A pending cancel means nothing once its job has left the active list.
    if (cancelling.size > 0) {
      const live = new Set(active.map((j) => j.id));
      for (const id of [...cancelling]) if (!live.has(id)) cancelling.delete(id);
    }

    resultDirs.clear();
    shown.clear();
    for (const j of jobs) {
      if (j.resultDir) resultDirs.set(j.id, j.resultDir);
      shown.set(j.id, { received: j.received, total: j.total });
    }

    activeList.innerHTML = active.map((j) => rowHtml(j, cancelling.has(j.id))).join("");
    recentList.innerHTML = recent.map((j) => rowHtml(j, false)).join("");

    activeSec.hidden = active.length === 0;
    recentSec.hidden = recent.length === 0;
    clearBtn.hidden = recent.length === 0;
    emptyEl.hidden = jobs.length > 0;
  }

  /** A plain progress tick: bar width + metrics text, nothing else touched. */
  function patchRow(job: Job): void {
    const row = root.querySelector<HTMLElement>(`[data-job-id="${CSS.escape(job.id)}"]`);
    if (!row) return;
    const pct = Math.round(progressFraction(job) * 100);
    const bar = row.querySelector<HTMLElement>(".act-row__bar");
    if (bar) {
      bar.setAttribute("aria-valuenow", String(pct));
      const fill = bar.firstElementChild as HTMLElement | null;
      if (fill) fill.style.width = `${pct}%`;
    }
    const metrics = row.querySelector<HTMLElement>(".act-row__metrics");
    if (metrics) metrics.textContent = metricsText(job);
  }

  function sync(jobs: readonly Job[]): void {
    const key = structureKey(jobs);
    if (key !== signature) {
      signature = key;
      renderAll(jobs);
      return;
    }
    for (const j of jobs) {
      const prev = shown.get(j.id);
      if (!prev || (prev.received === j.received && prev.total === j.total)) continue;
      prev.received = j.received;
      prev.total = j.total;
      patchRow(j);
    }
  }

  sync(jobsStore.get().jobs);
  const unsubscribe = jobsStore.subscribe((s) => sync(s.jobs));

  return {
    dispose() {
      unsubscribe();
      root.removeEventListener("click", onClick);
      root.remove();
    },
  };
}
