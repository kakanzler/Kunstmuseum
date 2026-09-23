'use strict';
// Smoke launch: builds a fixture folder (in KM_SCRATCH or the OS temp dir),
// launches Electron with KM_SMOKE=1 and an isolated userData directory, relays
// the exit code, then removes only what this script created.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const electronPath = require('electron');

// ---------- tiny image encoders ----------
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function makePng(w, h, color) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const shade = ((x >> 3) + (y >> 3)) % 2 ? 1 : 0.7;
      raw[row + 1 + x * 3] = Math.round(color[0] * shade);
      raw[row + 2 + x * 3] = Math.round(color[1] * shade);
      raw[row + 3 + x * 3] = Math.round(color[2] * shade);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeBmp(w, h, color) {
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + rowSize * h;
  const b = Buffer.alloc(size);
  b.write('BM', 0, 'ascii');
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(rowSize * h, 34);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = 54 + y * rowSize + x * 3;
      b[o] = color[2];
      b[o + 1] = color[1];
      b[o + 2] = color[0];
    }
  }
  return b;
}

function makeIco(pngBuf, size) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // icon
  head.writeUInt16LE(1, 4); // count
  head[6] = size >= 256 ? 0 : size;
  head[7] = size >= 256 ? 0 : size;
  head.writeUInt16LE(1, 10); // planes
  head.writeUInt16LE(32, 12); // bpp
  head.writeUInt32LE(pngBuf.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, pngBuf]);
}

/**
 * Minimal animated GIF encoder (4-colour palette). LZW stream emits a CLEAR
 * code before every pixel so the code size stays fixed at 3 bits.
 */
function makeGif(w, h, frames, palette) {
  const parts = [];
  const hdr = Buffer.alloc(13);
  hdr.write('GIF89a', 0, 'ascii');
  hdr.writeUInt16LE(w, 6);
  hdr.writeUInt16LE(h, 8);
  hdr[10] = 0x80 | 0x01; // global colour table, 4 entries (2^(1+1))
  parts.push(hdr, Buffer.from(palette.flat()));
  // NETSCAPE2.0 loop forever
  parts.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0x00, 0x00, 0x00]));
  for (const px of frames) {
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 50, 0x00, 0x00, 0x00])); // 0.5s delay
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(w, 5);
    desc.writeUInt16LE(h, 7);
    parts.push(desc);
    const CLEAR = 4;
    const END = 5;
    let bits = 0;
    let nbits = 0;
    const bytes = [];
    const emit = (code) => {
      bits |= code << nbits;
      nbits += 3;
      while (nbits >= 8) { bytes.push(bits & 0xff); bits >>= 8; nbits -= 8; }
    };
    for (const p of px) { emit(CLEAR); emit(p); }
    emit(END);
    if (nbits > 0) bytes.push(bits & 0xff);
    const sub = [2]; // LZW minimum code size
    for (let i = 0; i < bytes.length; i += 255) {
      const chunk = bytes.slice(i, i + 255);
      sub.push(chunk.length, ...chunk);
    }
    sub.push(0);
    parts.push(Buffer.from(sub));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

const GIF = makeGif(8, 8, [new Array(64).fill(1), new Array(64).fill(2)], [[0, 0, 0], [220, 60, 60], [60, 90, 220], [255, 255, 255]]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">'
  + '<rect width="240" height="160" fill="#1d2b3a"/><circle cx="120" cy="80" r="50" fill="#c8a45a"/></svg>';

// ---------- fixture management ----------
const base = process.env.KM_SCRATCH || os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const work = fs.mkdtempSync(path.join(base, 'km-smoke-'));
const pics = path.join(work, 'Pics');
const userData = path.join(work, 'userdata');
const created = [];
const put = (rel, data) => {
  const f = path.join(work, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  created.push(f);
};

put('Pics/01 赤.png', makePng(640, 400, [200, 60, 50]));
put('Pics/2 green.bmp', makeBmp(120, 90, [60, 170, 80]));
put('Pics/10 vector.svg', SVG);
put('Pics/anim.gif', GIF);
put('Pics/icon.ico', makeIco(makePng(32, 32, [90, 120, 220]), 32));
put('Pics/Sub フォルダ/deep.PNG', makePng(300, 900, [80, 80, 200]));
put('Pics/notes.txt', 'not an image');
put('outside.png', makePng(16, 16, [255, 255, 255]));
const BULK = Number(process.env.KM_SMOKE_BULK || 0); // optional scale test
if (BULK) {
  const small = makePng(96, 64, [120, 110, 100]);
  for (let i = 0; i < BULK; i++) put(`Pics/bulk/img_${String(i).padStart(5, '0')}.png`, small);
}
const EXPECT = 6 + BULK;

function cleanup() {
  if (process.env.KM_SMOKE_KEEP === '1') {
    console.log(`[smoke] keeping fixtures at ${work}`);
    return;
  }
  // Everything below `work` was created by this run (fixtures + Electron's
  // userData). Remove files by exact path, then the now-empty directories.
  const dirs = [];
  const walk = (d) => {
    dirs.push(d);
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else fs.unlinkSync(p);
    }
  };
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      dirs.length = 0;
      walk(work);
      for (const d of dirs.reverse()) fs.rmdirSync(d);
      return;
    } catch (e) {
      if (attempt === 9) console.warn(`[smoke] cleanup incomplete (${e.code}): ${work}`);
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); // Electron may still hold locks
    }
  }
}

const env = {
  ...process.env,
  KM_SMOKE: '1',
  KM_SMOKE_DIR: pics,
  KM_SMOKE_USERDATA: userData,
  KM_SMOKE_EXPECT: String(EXPECT),
  KM_SMOKE_OUTSIDE: path.join(work, 'outside.png'),
};
delete env.ELECTRON_RUN_AS_NODE;

console.log(`[smoke] fixtures: ${created.length} files in ${work}`);

function launch(phase) {
  return new Promise((resolve) => {
    const child = spawn(electronPath, ['.'], {
      cwd: path.join(__dirname, '..'),
      env: { ...env, KM_SMOKE_PHASE: String(phase) },
      stdio: 'inherit',
      windowsHide: false,
    });
    child.on('exit', (code, signal) => {
      console.log(`[smoke] phase ${phase}: electron exited with ${code == null ? `signal ${signal}` : `code ${code}`}`);
      resolve(code == null ? 1 : code);
    });
  });
}

function countFiles(d) {
  let n = 0;
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    if (ent.isDirectory()) n += countFiles(path.join(d, ent.name));
    else n++;
  }
  return n;
}

(async () => {
  // phase 1: fresh userData; phase 2: second launch restoring the saved layout
  let rc = await launch(1);
  if (rc === 0) rc = await launch(2);
  // renames/moves must never lose or duplicate files
  const expectedFiles = created.filter((f) => f.startsWith(pics + path.sep)).length;
  const count = countFiles(pics);
  if (count !== expectedFiles) {
    console.error(`[smoke] FAIL fixture file count changed: ${count} != ${expectedFiles}`);
    rc = 1;
  }
  cleanup();
  console.log(`[smoke] overall: ${rc === 0 ? 'PASS' : 'FAIL'}`);
  process.exit(rc);
})();
