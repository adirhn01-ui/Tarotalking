#!/usr/bin/env node
// Generates the Tarotalking app icon: the app's own bookOpen glyph (the open
// book whose spine descends below the pages — reading as a "T") in white on
// the accent-violet rounded tile. Rendered from real SVG via resvg, so the
// icon is pixel-faithful to the in-app icon set (same path data).
//
//   node scripts/make-icon.mjs
//   npx tauri icon src-tauri/icon-src-1024.png
//
// Output: src-tauri/icon-src-1024.png (source for `npx tauri icon`).

import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "src-tauri", "icon-src-1024.png");

const S = 1024;
const CORNER = 180; // tile corner radius
const ACCENT = "#8a7cff"; // --accent (dark theme)

// The bookOpen path from src/ui/icons.ts, verbatim (24 viewBox).
const BOOK_OPEN =
  "M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z";

// Scale the 24-box glyph (content x:2..22, y:4..21) into the tile.
const SCALE = 30; // glyph width 20u → 600px
const TX = (S - 20 * SCALE) / 2 - 2 * SCALE; // center x (content starts at x=2)
const TY = (S - 17 * SCALE) / 2 - 4 * SCALE; // center y (content starts at y=4)

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" rx="${CORNER}" fill="${ACCENT}"/>
  <g transform="translate(${TX} ${TY}) scale(${SCALE})">
    <path d="${BOOK_OPEN}" fill="none" stroke="#ffffff" stroke-width="1.9"
          stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: "width", value: S } }).render().asPng();
writeFileSync(out, png);
console.log("icon source ready:", path.relative(root, out), `(${png.length} bytes)`);
console.log("next: npx tauri icon", path.relative(root, out));
