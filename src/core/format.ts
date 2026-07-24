// Formatting helpers: durations, bytes, dates, time-left estimates.

import { READING_WPM, SPEAKING_WPM } from "./types";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Compact duration like 0:42, 3:07, 1:02:03 (seconds input). */
export function formatDuration(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const total = Math.round(t);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** Human time-left like "12 min left", "2 h 5 min left", "under a minute". */
export function formatTimeLeft(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) minutes = 0;
  if (minutes < 1) return "under a minute";
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h} h ${rem} min` : `${h} h`;
}

/** Estimated silent-reading minutes for a word count. */
export function readingMinutes(words: number): number {
  return words / READING_WPM;
}

/** Estimated listening minutes for a word count at a playback rate. */
export function listeningMinutes(words: number, rate: number): number {
  return words / (SPEAKING_WPM * Math.max(0.25, rate));
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let u = -1;
  do {
    v /= 1000;
    u++;
  } while (v >= 1000 && u < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** Last path segment ("C:\a\b.epub" → "b.epub"). */
export function fileName(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** File name without its extension. */
export function fileStem(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** File extension, lowercased, without the dot. */
export function fileExt(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** "just now", "5m ago", "3h ago", "yesterday", else a short date (ms input). */
export function formatRelative(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: day > 300 ? "numeric" : undefined,
  });
}

/** Percentage label: 0.0731 → "7%". Clamped 0..100. */
export function formatPct(p: number): string {
  if (!Number.isFinite(p)) p = 0;
  return `${Math.max(0, Math.min(100, Math.round(p * 100)))}%`;
}
