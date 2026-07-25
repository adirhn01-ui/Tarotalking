#!/usr/bin/env node
// Generates test fixtures: a small, valid EPUB (3 chapters, NCX toc, cover
// image) used by the in-app E2E harness and manual testing. Pure Node — a
// minimal ZIP writer with stored (uncompressed) entries; no dependencies.
//
//   node scripts/make-fixtures.mjs   → fixtures/fixture-book.epub

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "fixtures");
mkdirSync(outDir, { recursive: true });

/* ---- minimal ZIP writer (stored entries only) ---- */

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

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ---- fixture EPUB content ---- */

// 1x1 violet PNG for the cover.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+P//PwAF/gL+XJxUngAAAABJRU5ErkJggg==",
  "base64",
);

const chapter = (n, title, paras) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title></head>
<body>
  <h1>${title}</h1>
  ${paras.map((p) => `<p>${p}</p>`).join("\n  ")}
  ${n === 2 ? '<img src="images/cover.png" alt="figure"/>' : ""}
</body>
</html>`;

const ch1 = chapter(1, "The Beginning", [
  "It was a bright cold day in the fixture library, and the clocks were striking thirteen. Mr. Reed opened the small violet book and began to read aloud.",
  "The first sentence was short. The second sentence, by contrast, wandered along the shelf for a while before finding its way to a full stop.",
  "Reading aloud is a habit worth keeping. It slows the mind and warms the room.",
]);
const ch2 = chapter(2, "The Middle", [
  "Every middle chapter carries the weight of the story. This one carries three paragraphs and a picture.",
  "She said, “Keep the sentences varied. Some short. Some longer, with clauses that give a speech engine something to breathe with.”",
  "Numbers work too: 42 readers agreed, and 7 disagreed politely.",
]);
const ch3 = chapter(3, "The End", [
  "Endings should be brief. This one is.",
  "The violet book closed with a satisfying thump, and the room went quiet again.",
]);

const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>The Fixture Book</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:identifier id="uid">fixture-book-001</dc:identifier>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-img" href="images/cover.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>`;

const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="fixture-book-001"/></head>
  <docTitle><text>The Fixture Book</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>The Beginning</text></navLabel><content src="ch1.xhtml"/></navPoint>
    <navPoint id="n2" playOrder="2"><navLabel><text>The Middle</text></navLabel><content src="ch2.xhtml"/></navPoint>
    <navPoint id="n3" playOrder="3"><navLabel><text>The End</text></navLabel><content src="ch3.xhtml"/></navPoint>
  </navMap>
</ncx>`;

const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const epub = zip([
  ["mimetype", "application/epub+zip"], // must be first, stored
  ["META-INF/container.xml", container],
  ["OEBPS/content.opf", opf],
  ["OEBPS/toc.ncx", ncx],
  ["OEBPS/ch1.xhtml", ch1],
  ["OEBPS/ch2.xhtml", ch2],
  ["OEBPS/ch3.xhtml", ch3],
  ["OEBPS/images/cover.png", PNG_1PX],
]);

const out = path.join(outDir, "fixture-book.epub");
writeFileSync(out, epub);
console.log("fixture ready:", path.relative(root, out), `(${epub.length} bytes)`);

/* ---- minimal two-page PDF (uncompressed, byte-accurate xref) ---- */

function makePdf(pages) {
  // Objects: 1 catalog, 2 pages tree, then per page: page + contents stream.
  const objects = [];
  const pageRefs = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>\nendobj\n`,
  );
  pages.forEach((lines, i) => {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> ` +
        `/Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    let y = 720;
    let body = "BT\n";
    for (const [size, text] of lines) {
      body += `/F1 ${size} Tf 72 ${y} Td (${text.replace(/[\\()]/g, "\\$&")}) Tj\n`;
      y -= size * 1.6;
      body = body.replace(/Td \(/, "Td ("); // keep simple: absolute Td per line
      body += "ET\nBT\n";
    }
    body += "ET\n";
    objects.push(
      `${contentNum} 0 obj\n<< /Length ${body.length} >>\nstream\n${body}endstream\nendobj\n`,
    );
  });

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const pdfBuf = makePdf([
  [
    [24, "The Fixture Paper"],
    [12, "This is the first paragraph of the fixture PDF. It exists to prove"],
    [12, "that text extraction produces readable blocks for the reader."],
  ],
  [
    [18, "Second Section"],
    [12, "Page two carries a second heading and one more paragraph so the"],
    [12, "chapterizer has something to chew on."],
  ],
]);
const pdfOut = path.join(outDir, "fixture-doc.pdf");
writeFileSync(pdfOut, pdfBuf);
console.log("fixture ready:", path.relative(root, pdfOut), `(${pdfBuf.length} bytes)`);

/* ---------------- audiobook fixture: two tiny WAV tracks ---------------- */

/** A valid 16-bit mono PCM WAV holding `seconds` of a quiet sine tone.
 *  Real audio, not silence, so a player that decodes it has something to play. */
function makeWav(seconds, rate = 8000, freq = 220) {
  const frames = Math.max(1, Math.round(seconds * rate));
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 6000);
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

for (const [name, secs] of [["fixture-track-01.wav", 1.5], ["fixture-track-02.wav", 1.0]]) {
  writeFileSync(path.join(outDir, name), makeWav(secs));
}
