#!/usr/bin/env node
// Generates the Tarotalking app icon: an accent-violet (#8a7cff, matches the
// --accent token) rounded square with a bold white "T" plus two sound-wave
// arcs — the reading sibling of Taroting's plain "T". Pure Node (zlib PNG
// encoder, per-pixel math, 2x2 supersampling); no dependencies, no ffmpeg.
//
//   node scripts/make-icon.mjs
//   npx tauri icon src-tauri/icon-src-1024.png
//
// Output: src-tauri/icon-src-1024.png (source for `npx tauri icon`).

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "src-tauri", "icon-src-1024.png");

const S = 1024;
const R = 180; // corner radius
const BG = [0x8a, 0x7c, 0xff]; // --accent (dark theme)
const FG = [0xff, 0xff, 0xff];

/* ---- geometry ---- */

// Rounded-square coverage: 1 inside, 0 outside.
function inRoundedSquare(x, y) {
  const dx = Math.max(0, R - x, x - (S - 1 - R));
  const dy = Math.max(0, R - y, y - (S - 1 - R));
  return Math.hypot(dx, dy) <= R;
}

// The "T as an open book": the crossbar is the two open pages (slanting
// gently down toward the center, the way page tops dip into the spine) and
// the stem is the book's spine. Page-edge accents under each arm suggest the
// page stack. Reads as a bold T at a glance, as an open book on a look.
// The app's own bookOpen glyph, scaled up: an OUTLINE open book whose center
// spine descends below the pages — reading as a "T". Drawn as round-capped
// strokes (distance-to-segment test), matching the in-app icon style.
const STROKE_HALF = 30; // stroke width 60 at 1024

// Each entry is a polyline; round caps/joins come free from distance math.
const LEFT_PAGE = [
  [245, 300], [412, 300], [496, 332], // top edge, bending into the spine
];
const LEFT_SIDE = [
  [245, 300], [245, 686], // outer edge
];
const LEFT_BOTTOM = [
  [245, 686], [412, 686], [496, 718], // bottom edge, bending into the spine
];
const SPINE = [
  [512, 332], [512, 772], // the "T" stem, dropping below the page bottoms
];

function mirror(poly) {
  return poly.map(([x, y]) => [1024 - x, y]);
}

const POLYLINES = [
  LEFT_PAGE, LEFT_SIDE, LEFT_BOTTOM,
  mirror(LEFT_PAGE), mirror(LEFT_SIDE), mirror(LEFT_BOTTOM),
  SPINE,
];

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inGlyph(x, y) {
  for (const poly of POLYLINES) {
    for (let i = 0; i + 1 < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[i + 1];
      if (distToSegment(x, y, ax, ay, bx, by) <= STROKE_HALF) return true;
    }
  }
  return false;
}

/* ---- render with 2x2 supersampling ---- */

const raw = Buffer.alloc(S * (S * 4 + 1)); // +1 filter byte per scanline
const offsets = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
];

for (let y = 0; y < S; y++) {
  const row = y * (S * 4 + 1);
  raw[row] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    let cover = 0; // rounded-square coverage
    let glyph = 0; // white-glyph coverage
    for (const [ox, oy] of offsets) {
      const sx = x + ox;
      const sy = y + oy;
      if (inRoundedSquare(sx, sy)) {
        cover++;
        if (inGlyph(sx, sy)) glyph++;
      }
    }
    const a = (cover / 4) * 255;
    const g = glyph / Math.max(1, cover);
    const px = row + 1 + x * 4;
    raw[px] = Math.round(BG[0] + (FG[0] - BG[0]) * g);
    raw[px + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * g);
    raw[px + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * g);
    raw[px + 3] = Math.round(a);
  }
}

/* ---- minimal PNG encoder ---- */

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(out, png);
console.log("icon source ready:", path.relative(root, out));
console.log("next: npx tauri icon", path.relative(root, out));
