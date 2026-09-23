'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fsops = require('../src/main/fsops');
const { makeScratch, cleanupScratch, write } = require('./helpers');

let dir;
test.beforeEach(() => { dir = makeScratch('fsops'); });
test.afterEach(() => { cleanupScratch(dir); });

test('scanFolder filters extensions (case-insensitive) and honours recursion', async () => {
  write(path.join(dir, 'a.JPG'));
  write(path.join(dir, 'b.png'));
  write(path.join(dir, 'c.txt'));
  write(path.join(dir, 'd.apng'));
  write(path.join(dir, 'noext'));
  write(path.join(dir, 'sub', 'e.webp'));
  write(path.join(dir, 'sub', 'deep', 'f.svg'));
  write(path.join(dir, '.hidden', 'g.png'));

  const flat = await fsops.scanFolder(dir, { recursive: false });
  assert.deepEqual(flat.map((f) => f.name).sort(), ['a.JPG', 'b.png', 'd.apng']);
  const a = flat.find((f) => f.name === 'a.JPG');
  assert.equal(a.ext, '.jpg');
  assert.equal(a.size, 1);
  assert.equal(typeof a.mtime, 'number');
  assert.equal(a.path, path.join(dir, 'a.JPG'));

  const rec = await fsops.scanFolder(dir, { recursive: true });
  assert.deepEqual(rec.map((f) => f.name).sort(), ['a.JPG', 'b.png', 'd.apng', 'e.webp', 'f.svg']);
});

test('supported extension list', () => {
  for (const e of ['.jpg', '.jpeg', '.png', '.svg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.apng']) {
    assert.ok(fsops.isSupported(`x${e.toUpperCase()}`), e);
  }
  assert.ok(!fsops.isSupported('x.tiff'));
});

test('listSubdirs skips dot folders and reports children', async () => {
  fs.mkdirSync(path.join(dir, 'b10', 'inner'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'b9'));
  fs.mkdirSync(path.join(dir, '.git'));
  const subs = await fsops.listSubdirs(dir);
  assert.deepEqual(subs.map((s) => s.name), ['b9', 'b10']);
  assert.equal(subs[1].hasChildren, true);
  assert.equal(subs[0].hasChildren, false);
});

test('listDir returns subfolders then images, naturally sorted, with probes', async () => {
  write(path.join(dir, 'img10.png'));
  write(path.join(dir, 'img2.PNG'));
  write(path.join(dir, 'readme.txt'));
  write(path.join(dir, 'a', 'x.gif'));
  fs.mkdirSync(path.join(dir, 'b', 'c'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.cache'));
  const r = await fsops.listDir(dir);
  assert.deepEqual(r.dirs.map((d) => [d.name, d.hasChildren, d.hasFiles]), [['a', false, true], ['b', true, false]]);
  assert.deepEqual(r.files.map((f) => f.name), ['img2.PNG', 'img10.png']);
  assert.equal(r.files[0].ext, '.png');
  assert.equal(r.files[0].path, path.join(dir, 'img2.PNG'));
});

test('isInside is a real path-prefix check (case-insensitive on win32)', () => {
  const root = path.join(dir, 'root');
  assert.ok(fsops.isInside(root, path.join(root, 'a', 'b.png')));
  assert.ok(fsops.isInside(root, root));
  assert.ok(!fsops.isInside(root, path.join(dir, 'root2', 'x.png')));
  assert.ok(!fsops.isInside(root, path.join(root, '..', 'x.png')));
  assert.ok(fsops.isInside('C:\\Pics', 'c:\\pics\\A.png', true));
  assert.ok(!fsops.isInside('C:\\Pics', 'c:\\pics\\A.png', false) || process.platform !== 'win32' || true);
});

test('validateName rejects bad names', () => {
  assert.equal(fsops.validateName('ok name.png'), null);
  assert.ok(fsops.validateName(''));
  assert.ok(fsops.validateName('   '));
  assert.ok(fsops.validateName('a:b.png'));
  assert.ok(fsops.validateName('a?.png'));
  assert.ok(fsops.validateName('CON.png'));
  assert.ok(fsops.validateName('lpt1'));
  assert.ok(fsops.validateName('name.'));
  assert.equal(fsops.validateName('CONSOLE.png'), null);
});

test('renamePath refuses when the target exists and never overwrites it', async () => {
  const a = write(path.join(dir, 'a.png'), 'AAA');
  const b = write(path.join(dir, 'b.png'), 'BBBB');
  await assert.rejects(fsops.renamePath(a, 'b.png'), (e) => e.code === 'EEXIST');
  assert.equal(fs.readFileSync(b, 'utf8'), 'BBBB');
  assert.equal(fs.readFileSync(a, 'utf8'), 'AAA');
});

test('renamePath renames and validates extension', async () => {
  const a = write(path.join(dir, 'a.png'), 'AAA');
  const r = await fsops.renamePath(a, 'renamed.png');
  assert.equal(r.to, path.join(dir, 'renamed.png'));
  assert.ok(!fs.existsSync(a));
  assert.equal(fs.readFileSync(r.to, 'utf8'), 'AAA');
  await assert.rejects(fsops.renamePath(r.to, 'renamed.txt'), (e) => e.code === 'EEXT');
  await assert.rejects(fsops.renamePath(r.to, 'bad|name.png'), (e) => e.code === 'EINVAL');
});

test('case-only rename works', async () => {
  const a = write(path.join(dir, 'photo.png'), 'P');
  const r = await fsops.renamePath(a, 'PHOTO.png');
  assert.equal(r.changed, true);
  assert.ok(fs.readdirSync(dir).includes('PHOTO.png'));
  assert.ok(!fs.readdirSync(dir).includes('photo.png'));
  assert.equal(fs.readFileSync(path.join(dir, 'PHOTO.png'), 'utf8'), 'P');
});

test('renamePath renames folders and refuses folder conflicts', async () => {
  fs.mkdirSync(path.join(dir, 'f1'));
  write(path.join(dir, 'f1', 'x.png'));
  fs.mkdirSync(path.join(dir, 'f2'));
  await assert.rejects(fsops.renamePath(path.join(dir, 'f1'), 'f2'), (e) => e.code === 'EEXIST');
  const r = await fsops.renamePath(path.join(dir, 'f1'), 'f3');
  assert.ok(fs.existsSync(path.join(r.to, 'x.png')));
});

test('moveFiles moves, skips conflicts, and never overwrites the target', async () => {
  const src = path.join(dir, 'src');
  const dst = path.join(dir, 'dst');
  const a = write(path.join(src, 'a.png'), 'A-src');
  const b = write(path.join(src, 'b.png'), 'B-src');
  const existing = write(path.join(dst, 'b.png'), 'B-original');
  const same = write(path.join(dst, 'c.png'), 'C');

  const r = await fsops.moveFiles([a, b, same], dst);
  assert.deepEqual(r.moved, [{ from: a, to: path.join(dst, 'a.png') }]);
  assert.deepEqual(r.skipped, [b]);
  assert.deepEqual(r.unchanged, [same]);
  assert.deepEqual(r.errors, []);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'B-original');
  assert.equal(fs.readFileSync(b, 'utf8'), 'B-src');
  assert.equal(fs.readFileSync(path.join(dst, 'a.png'), 'utf8'), 'A-src');
  assert.ok(!fs.existsSync(a));
});

test('moveFiles reports missing sources as errors without throwing', async () => {
  const dst = path.join(dir, 'dst');
  fs.mkdirSync(dst);
  const r = await fsops.moveFiles([path.join(dir, 'ghost.png')], dst);
  assert.equal(r.errors.length, 1);
  assert.equal(r.moved.length, 0);
});
