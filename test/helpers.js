'use strict';
// Test fixture helpers. Fixtures live in a unique directory created by this
// process under KM_TEST_TMP (or the OS temp dir). Cleanup removes only what
// the test created: files by exact path, then the (now empty) directories.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function makeScratch(label) {
  const base = process.env.KM_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `km-${label}-`));
}

/** Remove a directory created by makeScratch: files one by one, then empty dirs. */
function cleanupScratch(dir) {
  if (!dir || !path.basename(dir).startsWith('km-')) throw new Error(`refusing to clean ${dir}`);
  if (!fs.existsSync(dir)) return;
  const dirs = [];
  const walk = (d) => {
    dirs.push(d);
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else fs.unlinkSync(p);
    }
  };
  walk(dir);
  for (const d of dirs.reverse()) fs.rmdirSync(d);
}

function write(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

module.exports = { makeScratch, cleanupScratch, write };
