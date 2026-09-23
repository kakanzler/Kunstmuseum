'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/main/store');
const { makeScratch, cleanupScratch, write } = require('./helpers');

let dir;
let file;
const stores = [];
test.beforeEach(() => {
  dir = makeScratch('store');
  file = path.join(dir, 'library.json');
});
test.afterEach(() => {
  while (stores.length) stores.pop().dispose();
  cleanupScratch(dir);
});

const mk = (opts = {}) => {
  const s = new Store(file, { debounceMs: 5, ...opts });
  stores.push(s);
  return s;
};

test('seeds default tag types', () => {
  const s = mk();
  assert.deepEqual(s.listTagTypes().map((t) => t.name), ['カテゴリ', 'ジャンル']);
  assert.equal(s.data.version, 1);
});

test('tag type CRUD', () => {
  const s = mk();
  const t = s.addTagType({ name: '作者', color: '#ff0000' });
  assert.throws(() => s.addTagType({ name: '作者' }));
  s.updateTagType(t.id, { name: '作家', color: '#00ff00' });
  assert.equal(s.listTagTypes().find((x) => x.id === t.id).name, '作家');
  const tag = s.addTag({ name: 'モネ', typeId: t.id });
  const first = s.listTagTypes()[0].id;
  s.deleteTagType(t.id);
  assert.equal(s.listTagTypes().length, 2);
  assert.equal(s.getTag(tag.id).typeId, first);
  const [a, b] = s.listTagTypes();
  s.deleteTagType(a.id);
  assert.throws(() => s.deleteTagType(b.id));
});

test('tag CRUD, merge and delete', () => {
  const s = mk();
  const type = s.listTagTypes()[0].id;
  const t1 = s.addTag({ name: '風景', typeId: type });
  assert.equal(s.addTag({ name: '風景', typeId: type }).id, t1.id, 'dedupes by name+type');
  const t2 = s.addTag({ name: '夜景', typeId: type });
  const t3 = s.addTag({ name: '人物', typeId: type });
  assert.throws(() => s.updateTag(t2.id, { name: '風景' }));
  s.updateTag(t3.id, { name: 'ポートレート' });
  assert.equal(s.getTag(t3.id).name, 'ポートレート');

  const img1 = path.join(dir, 'a.png');
  const img2 = path.join(dir, 'b.png');
  s.addTagsToImages([img1, img2], [t1.id]);
  s.addTagsToImages([img2], [t2.id]);
  assert.deepEqual(s.tagUsage(), { [t1.id]: 2, [t2.id]: 1, [t3.id]: 0 });

  s.mergeTags(t2.id, t1.id);
  assert.equal(s.getTag(t2.id), undefined);
  assert.deepEqual(s.getImageTags(img2), [t1.id]);

  s.deleteTag(t1.id);
  assert.deepEqual(s.getImageTags(img1), []);
  assert.deepEqual(s.listTaggedImages(), [], 'untagged entries are dropped');
});

test('add/remove tags on multiple images', () => {
  const s = mk();
  const t = s.addTag({ name: 'x' });
  const u = s.addTag({ name: 'y' });
  const a = path.join(dir, 'a.png');
  const b = path.join(dir, 'b.png');
  s.addTagsToImages([a, b], [t.id, u.id]);
  const res = s.removeTagsFromImages([a], [t.id]);
  assert.deepEqual(res[a], [u.id]);
  assert.deepEqual(s.getImageTags(b), [t.id, u.id]);
});

test('case-insensitive keys on win32', () => {
  const s = mk({ platform: 'win32' });
  const t = s.addTag({ name: 'x' });
  s.addTagsToImages(['C:\\Pics\\Photo.PNG'], [t.id]);
  assert.deepEqual(s.getImageTags('c:\\pics\\photo.png'), [t.id]);
  s.addTagsToImages(['c:\\PICS\\photo.png'], [t.id]);
  assert.equal(s.listTaggedImages().length, 1);
});

test('renameImageKey moves tags to the new path', () => {
  const s = mk();
  const t = s.addTag({ name: 'x' });
  const a = path.join(dir, 'a.png');
  const b = path.join(dir, 'b.png');
  s.addTagsToImages([a], [t.id]);
  assert.ok(s.renameImageKey(a, b));
  assert.deepEqual(s.getImageTags(a), []);
  assert.deepEqual(s.getImageTags(b), [t.id]);
  assert.equal(s.renameImageKey(path.join(dir, 'none.png'), a), false);
});

test('renameFolderPrefix rewrites keys, roots and lastFolder but not siblings', () => {
  const s = mk();
  const t = s.addTag({ name: 'x' });
  const old = path.join(dir, 'Old');
  const inside = path.join(old, 'Sub', 'Pic.png');
  const sibling = path.join(dir, 'Older', 'p.png');
  s.addTagsToImages([inside, sibling], [t.id]);
  s.addRoot(old);
  s.setSettings({ lastFolder: path.join(old, 'Sub') });
  const n = s.renameFolderPrefix(old, path.join(dir, 'New'));
  assert.equal(n, 1);
  assert.deepEqual(s.getImageTags(path.join(dir, 'New', 'Sub', 'Pic.png')), [t.id]);
  assert.ok(s.listTaggedImages().some((e) => e.path === path.join(dir, 'New', 'Sub', 'Pic.png')), 'sub-path case preserved');
  assert.deepEqual(s.getImageTags(sibling), [t.id]);
  assert.deepEqual(s.getRoots(), [path.join(dir, 'New')]);
  assert.equal(s.getSettings().lastFolder, path.join(dir, 'New', 'Sub'));
});

test('renameFolderPrefix is case-insensitive on win32', () => {
  const s = mk({ platform: 'win32' });
  const t = s.addTag({ name: 'x' });
  s.addTagsToImages(['C:\\Art\\Sub\\a.png'], [t.id]);
  s.renameFolderPrefix('c:\\art', 'C:\\Kunst');
  assert.deepEqual(s.getImageTags('C:\\Kunst\\Sub\\a.png'), [t.id]);
  assert.ok(s.listTaggedImages()[0].path === 'C:\\Kunst\\Sub\\a.png');
});

test('pruneMissing drops entries whose file is gone', () => {
  const s = mk();
  const t = s.addTag({ name: 'x' });
  const keep = write(path.join(dir, 'keep.png'));
  const gone = path.join(dir, 'gone.png');
  s.addTagsToImages([keep, gone], [t.id]);
  assert.equal(s.pruneMissing(), 1);
  assert.deepEqual(s.listTaggedImages().map((e) => e.path), [keep]);
});

test('pruneMissing keeps entries on an unavailable volume', () => {
  const s = mk({ existsSync: () => false });
  const t = s.addTag({ name: 'x' });
  s.addTagsToImages([path.join(dir, 'a.png')], [t.id]);
  assert.equal(s.pruneMissing(), 0);
});

test('roots are deduped case-insensitively on win32 and removal never touches disk', () => {
  const s = mk({ platform: 'win32' });
  assert.ok(s.addRoot('C:\\Pics'));
  assert.ok(!s.addRoot('c:\\pics'));
  assert.ok(s.removeRoot('C:\\PICS'));
  assert.deepEqual(s.getRoots(), []);
});

test('atomic save/load roundtrip', async () => {
  const s = mk();
  const tt = s.addTagType({ name: '場所', color: '#123456' });
  const t = s.addTag({ name: '京都', typeId: tt.id });
  const img = path.join(dir, 'k.png');
  s.addTagsToImages([img], [t.id]);
  s.addRoot(dir);
  s.setSettings({ thumbSize: 222, bogus: 1 });
  s.flush();
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), [], 'no tmp leftovers');

  const s2 = mk();
  assert.deepEqual(s2.data, s.data);
  assert.equal(s2.getSettings().thumbSize, 222);
  assert.equal(s2.getSettings().bogus, undefined);
  assert.deepEqual(s2.getImageTags(img), [t.id]);
});

test('debounced save writes eventually', async () => {
  const s = mk();
  s.addTag({ name: 'later' });
  await new Promise((r) => setTimeout(r, 60));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.tags[0].name, 'later');
});

test('corrupt library is backed up and replaced by defaults', () => {
  fs.writeFileSync(file, '{not json');
  const s = mk();
  assert.ok(s.loadWarning);
  assert.equal(s.listTagTypes().length, 2);
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith('library.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{not json');
});
