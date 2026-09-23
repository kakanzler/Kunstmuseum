'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fuzzy = require('../src/main/fuzzy');
const { FileIndex } = require('../src/main/file-index');
const { makeScratch, cleanupScratch, write } = require('./helpers');

const E = (name, rel = '', p = null) => ({ name, rel, path: p || `C:\\r\\${rel ? `${rel}\\` : ''}${name}` });

test('ranking: exact > prefix > contiguous > subsequence', () => {
  const entries = [
    E('xcatx.png'),      // contiguous (mid-word)
    E('c_a_t.png'),      // subsequence
    E('catalog.png'),    // prefix
    E('cat.png'),        // exact (stem)
    E('my cat.png'),     // contiguous at a word boundary
  ];
  const names = fuzzy.search(entries, 'cat').map((r) => r.name);
  assert.deepEqual(names, ['cat.png', 'catalog.png', 'my cat.png', 'xcatx.png', 'c_a_t.png']);
});

test('case-insensitive; extension included; highlight positions', () => {
  const [r] = fuzzy.search([E('Photo_2024.JPG')], 'jpg');
  assert.ok(r);
  assert.deepEqual(r.positions, [11, 12, 13]);
  assert.equal(fuzzy.search([E('Photo.png')], 'PHO')[0].name, 'Photo.png');
  assert.deepEqual(fuzzy.search([E('abcdef.png')], 'ace')[0].positions, [0, 2, 4]);
  assert.equal(fuzzy.search([E('abc.png')], 'xyz').length, 0);
});

test('ties: shorter names first, then natural order', () => {
  const names = fuzzy.search([E('img10.png'), E('img2.png'), E('img1.png'), E('img1-long.png')], 'img').map((r) => r.name);
  assert.deepEqual(names, ['img1.png', 'img2.png', 'img10.png', 'img1-long.png']);
});

test('space-separated terms are ANDed', () => {
  const entries = [E('red cat.png'), E('red dog.png'), E('blue cat.png')];
  assert.deepEqual(fuzzy.search(entries, 'cat red').map((r) => r.name), ['red cat.png']);
  assert.equal(fuzzy.search(entries, 'cat zebra').length, 0);
});

test('a term with "/" also matches the folder path', () => {
  const entries = [E('a.png', 'trips/kyoto'), E('a.png', 'work'), E('kyoto.png', 'misc')];
  const r = fuzzy.search(entries, 'kyoto/');
  assert.deepEqual(r.map((x) => x.rel), ['trips/kyoto']);
  assert.deepEqual(fuzzy.search(entries, 'trips/ a').map((x) => x.rel), ['trips/kyoto']);
  assert.deepEqual(fuzzy.search(entries, 'work/a.png').map((x) => x.rel), ['work']);
  assert.equal(fuzzy.search(entries, '').length, 0, 'empty query matches nothing');
});

test('limit is applied after sorting', () => {
  const entries = Array.from({ length: 50 }, (_, i) => E(`f${i}.png`));
  assert.equal(fuzzy.search(entries, 'f', 10).length, 10);
});

// ---------- FileIndex (real files in a scratch dir) ----------
let dir;
test.beforeEach(() => { dir = makeScratch('index'); });
test.afterEach(() => { cleanupScratch(dir); });

test('FileIndex: build, incremental directory updates, renames, root removal', async () => {
  const root = path.join(dir, 'root');
  write(path.join(root, 'a.png'));
  write(path.join(root, 'sub', 'b.jpg'));
  write(path.join(root, 'notes.txt'));
  const idx = new FileIndex();
  idx.setRoots([root]);
  await idx.build();
  assert.deepEqual(idx.search('b').results.map((r) => r.rel), ['sub']);
  assert.equal(idx.search('png').count, 2);

  // a new file and a moved-in folder: only the changed directory is re-listed
  write(path.join(root, 'sub', 'c.png'));
  write(path.join(root, 'newdir', 'deep', 'd.gif'));
  await idx.updateDirs([path.join(root, 'sub'), root]);
  assert.equal(idx.search('c.png').results.length, 1);
  assert.equal(idx.search('d.gif').results[0].rel, 'newdir/deep');

  // deletion of a file and of a whole folder
  fs.unlinkSync(path.join(root, 'sub', 'c.png'));
  fs.unlinkSync(path.join(root, 'newdir', 'deep', 'd.gif'));
  fs.rmdirSync(path.join(root, 'newdir', 'deep'));
  fs.rmdirSync(path.join(root, 'newdir'));
  await idx.updateDirs([path.join(root, 'sub'), root]);
  assert.equal(idx.search('c.png').results.length, 0);
  assert.equal(idx.search('d.gif').results.length, 0);

  // app-initiated rename / folder rename
  idx.renamePath(path.join(root, 'a.png'), path.join(root, 'z.png'));
  assert.equal(idx.search('z.png').results.length, 1);
  assert.equal(idx.search('a.png').results.length, 0);
  idx.renameDir(path.join(root, 'sub'), path.join(root, 'renamed'));
  assert.equal(idx.search('b.jpg').results[0].rel, 'renamed');

  idx.setRoots([]);
  assert.equal(idx.search('b').count, 0, 'entries of a removed root are dropped');
});
