'use strict';
// Generates build/icon.ico (256/128/64/48/32/16) without extra dependencies:
// a gold picture frame around a classical museum facade on near-black,
// rasterised with 4×4 supersampling, each size stored as a PNG frame.
//
//   node scripts/make-icon.js

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [256, 128, 64, 48, 32, 16];
const BG = [14, 14, 15];
const GOLD = [200, 164, 90];
const OUT = path.join(__dirname, '..', 'build', 'icon.ico');

// ---------- shapes in normalised [0,1] coordinates ----------
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
function inTriangle(x, y, ax, ay, bx, by, cx, cy) {
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by);
  const d2 = s(x, y, bx, by, cx, cy);
  const d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** colour at a point: [r,g,b,a] with a in 0..1 */
function shade(x, y, size) {
  if (!inRoundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.2)) return [0, 0, 0, 0];
  // thicker strokes at tiny sizes so the motif survives
  const t = size <= 32 ? 0.09 : 0.065;
  const outer = inRoundRect(x, y, 0.11, 0.11, 0.89, 0.89, 0.05);
  const inner = inRoundRect(x, y, 0.11 + t, 0.11 + t, 0.89 - t, 0.89 - t, 0.02);
  if (outer && !inner) return [...GOLD, 1];
  if (size >= 48) {
    // museum facade: pediment, architrave, four columns, stylobate
    if (inTriangle(x, y, 0.5, 0.27, 0.27, 0.42, 0.73, 0.42)) return [...GOLD, 1];
    if (inRect(x, y, 0.27, 0.445, 0.73, 0.48)) return [...GOLD, 1];
    for (const cx of [0.335, 0.445, 0.555, 0.665]) {
      if (inRect(x, y, cx - 0.027, 0.5, cx + 0.027, 0.69)) return [...GOLD, 1];
    }
    if (inRect(x, y, 0.25, 0.71, 0.75, 0.745)) return [...GOLD, 1];
  } else if (inTriangle(x, y, 0.5, 0.3, 0.3, 0.48, 0.7, 0.48) || inRect(x, y, 0.33, 0.52, 0.67, 0.7)) {
    return [...GOLD, 1]; // simplified house silhouette for 16/32 px
  }
  return [...BG, 1];
}

function render(size) {
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, size);
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        px[o] = Math.round(r / a);
        px[o + 1] = Math.round(g / a);
        px[o + 2] = Math.round(b / a);
      }
      px[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return px;
}

// ---------- PNG / ICO encoding ----------
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0; // palette
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((im) => im.data)]);
}

const images = SIZES.map((size) => ({ size, data: png(size, render(size)) }));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, ico(images));
console.log(`wrote ${OUT} (${SIZES.join('/')} px, ${fs.statSync(OUT).size} bytes)`);
