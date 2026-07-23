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

// Bold "T": horizontal bar + stem, sized against the 1024 canvas.
const BAR = { x0: 190, x1: 580, y0: 300, y1: 420 };
const STEM = { x0: 325, x1: 445, y0: 300, y1: 780 };

function inT(x, y) {
  if (x >= BAR.x0 && x < BAR.x1 && y >= BAR.y0 && y < BAR.y1) return true;
  if (x >= STEM.x0 && x < STEM.x1 && y >= STEM.y0 && y < STEM.y1) return true;
  return false;
}

// Two speaker arcs to the right of the T, rounded caps.
const ARC = { cx: 610, cy: 540, radii: [130, 215], half: 29, angle: (55 * Math.PI) / 180 };

function inArcs(x, y) {
  const dx = x - ARC.cx;
  const dy = y - ARC.cy;
  const d = Math.hypot(dx, dy);
  const a = Math.atan2(dy, dx); // 0 = pointing right
  for (const r of ARC.radii) {
    if (Math.abs(d - r) <= ARC.half && Math.abs(a) <= ARC.angle) return true;
    // rounded caps at the angular ends
    for (const sgn of [-1, 1]) {
      const ex = ARC.cx + r * Math.cos(sgn * ARC.angle);
      const ey = ARC.cy + r * Math.sin(sgn * ARC.angle);
      if (Math.hypot(x - ex, y - ey) <= ARC.half) return true;
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
        if (inT(sx, sy) || inArcs(sx, sy)) glyph++;
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
