'use strict';
// Store: tag hierarchy (parentId), deep usage, bulk apply / undo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/main/store');
const { makeScratch, cleanupScratch } = require('./helpers');

let dir;
let file;
const stores = [];
test.beforeEach(() => {
  dir = makeScratch('hier');
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

test('legacy library without parentId loads unchanged (all roots) and saves parentId: null', () => {
  const legacy = {
    version: 1,
    roots: [],
    settings: {},
    tagTypes: [{ id: 'tt1', name: 'カテゴリ', color: '#111111' }],
    tags: [{ id: 'a', name: '動物', typeId: 'tt1' }, { id: 'b', name: '犬', typeId: 'tt1' }],
    images: { [path.join(dir, 'x.png')]: { tags: ['a', 'b'] } },
  };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const s = mk();
  assert.deepEqual(s.listTags(), [
    { id: 'a', name: '動物', typeId: 'tt1', parentId: null },
    { id: 'b', name: '犬', typeId: 'tt1', parentId: null },
  ]);
  assert.deepEqual(s.getImageTags(path.join(dir, 'x.png')), ['a', 'b']);
  s.flush();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(raw.tags.map((t) => t.parentId), [null, null]);
});

test('sanitize: missing, cross-type and self parents become root; cycles are cut', () => {
  fs.writeFileSync(file, JSON.stringify({
    tagTypes: [{ id: 'c', name: 'カテゴリ' }, { id: 'g', name: 'ジャンル' }],
    tags: [
      { id: 'p', name: 'P', typeId: 'c', parentId: null },
      { id: 'k', name: 'K', typeId: 'c', parentId: 'p' },
      { id: 'ghost', name: 'G', typeId: 'c', parentId: 'nope' },
      { id: 'cross', name: 'X', typeId: 'g', parentId: 'p' },
      { id: 'self', name: 'S', typeId: 'c', parentId: 'self' },
      { id: 'c1', name: 'C1', typeId: 'c', parentId: 'c2' },
      { id: 'c2', name: 'C2', typeId: 'c', parentId: 'c1' },
    ],
  }));
  const s = mk();
  const p = (id) => s.getTag(id).parentId;
  assert.equal(p('k'), 'p');
  assert.equal(p('ghost'), null);
  assert.equal(p('cross'), null);
  assert.equal(p('self'), null);
  assert.ok(p('c1') === null || p('c2') === null, 'cycle cut');
});

test('same name allowed under different parents, deduped under the same parent', () => {
  const s = mk();
  const [type, genre] = s.listTagTypes().map((t) => t.id);
  const animal = s.addTag({ name: '動物', typeId: type });
  const pet = s.addTag({ name: 'ペット', typeId: type });
  const d1 = s.addTag({ name: '犬', parentId: animal.id });
  const d2 = s.addTag({ name: '犬', parentId: pet.id });
  assert.notEqual(d1.id, d2.id);
  assert.equal(d1.typeId, type, 'the parent implies the type');
  assert.equal(s.addTag({ name: '犬', parentId: animal.id }).id, d1.id);
  assert.throws(() => s.updateTag(d2.id, { parentId: animal.id }), /同じ階層/);
  assert.throws(() => s.addTag({ name: 'x', typeId: genre, parentId: animal.id }), /同じ種類/);
});

test('parent changes refuse cycles; a type change moves the whole subtree', () => {
  const s = mk();
  const [c, g] = s.listTagTypes().map((t) => t.id);
  const a = s.addTag({ name: 'A', typeId: c });
  const b = s.addTag({ name: 'B', parentId: a.id });
  const x = s.addTag({ name: 'X', parentId: b.id });
  assert.throws(() => s.updateTag(a.id, { parentId: x.id }), /子孫/);
  assert.throws(() => s.updateTag(a.id, { parentId: a.id }));
  s.updateTag(x.id, { parentId: null });
  assert.equal(s.getTag(x.id).parentId, null);
  const y = s.addTag({ name: 'Y', parentId: a.id });
  const z = s.addTag({ name: 'Z', parentId: y.id });
  s.updateTag(a.id, { typeId: g });
  assert.deepEqual([a, b, y, z].map((t) => s.getTag(t.id).typeId), [g, g, g, g], 'subtree moved');
  assert.equal(s.getTag(a.id).parentId, null);
  assert.equal(s.getTag(z.id).parentId, y.id, 'structure kept');
  assert.equal(s.getTag(x.id).typeId, c, 'detached tag stays');
  s.updateTag(y.id, { typeId: c });
  assert.equal(s.getTag(y.id).parentId, null, 'moving one branch to another type makes it a root there');
  assert.equal(s.getTag(z.id).typeId, c);
});

test('deleteTag re-parents children to the parent of the deleted tag', () => {
  const s = mk();
  const a = s.addTag({ name: 'A' });
  const b = s.addTag({ name: 'B', parentId: a.id });
  const c1 = s.addTag({ name: 'C1', parentId: b.id });
  const c2 = s.addTag({ name: 'C2', parentId: b.id });
  assert.equal(s.childCount(b.id), 2);
  s.deleteTag(b.id);
  assert.equal(s.getTag(c1.id).parentId, a.id);
  assert.equal(s.getTag(c2.id).parentId, a.id);
  s.deleteTag(a.id);
  assert.equal(s.getTag(c1.id).parentId, null);
});

test('mergeTags moves the children of the source under the target', () => {
  const s = mk();
  const [c, g] = s.listTagTypes().map((t) => t.id);
  const src = s.addTag({ name: 'S', typeId: c });
  const kid = s.addTag({ name: 'K', parentId: src.id });
  const grand = s.addTag({ name: 'GK', parentId: kid.id });
  const tgt = s.addTag({ name: 'T', typeId: g });
  const img = path.join(dir, 'm.png');
  s.addTagsToImages([img], [src.id]);
  s.mergeTags(src.id, tgt.id);
  assert.equal(s.getTag(src.id), undefined);
  assert.equal(s.getTag(kid.id).parentId, tgt.id);
  assert.equal(s.getTag(kid.id).typeId, g, 'children follow the target type');
  assert.equal(s.getTag(grand.id).typeId, g);
  assert.deepEqual(s.getImageTags(img), [tgt.id]);
  // merging a parent into its own child lifts the child into the parent's place
  const p = s.addTag({ name: 'P', typeId: c });
  const ch = s.addTag({ name: 'CH', parentId: p.id });
  const sib = s.addTag({ name: 'SIB', parentId: p.id });
  s.mergeTags(p.id, ch.id);
  assert.equal(s.getTag(ch.id).parentId, null);
  assert.equal(s.getTag(sib.id).parentId, ch.id);
});

test('tagUsageDeep counts each image once per ancestor', () => {
  const s = mk();
  const a = s.addTag({ name: 'A' });
  const b = s.addTag({ name: 'B', parentId: a.id });
  const c = s.addTag({ name: 'C', parentId: b.id });
  s.addTagsToImages([path.join(dir, '1.png')], [c.id, b.id]);
  s.addTagsToImages([path.join(dir, '2.png')], [a.id]);
  assert.deepEqual(s.tagUsage(), { [a.id]: 1, [b.id]: 1, [c.id]: 1 });
  assert.deepEqual(s.tagUsageDeep(), { [a.id]: 2, [b.id]: 1, [c.id]: 1 });
});

test('bulkApply adds/removes on every path; restoreTags undoes it exactly', () => {
  const s = mk();
  const x = s.addTag({ name: 'X' });
  const y = s.addTag({ name: 'Y' });
  const z = s.addTag({ name: 'Z' });
  const p1 = path.join(dir, 'b1.png');
  const p2 = path.join(dir, 'b2.png');
  const p3 = path.join(dir, 'b3.png');
  s.addTagsToImages([p1], [x.id, y.id]);
  s.addTagsToImages([p2], [y.id]);
  const before = s.bulkApply([p1, p2, p3], [z.id], [y.id]);
  assert.deepEqual(before, { [p1]: [x.id, y.id], [p2]: [y.id], [p3]: [] });
  assert.deepEqual(s.getTagsFor([p1, p2, p3]), { [p1]: [x.id, z.id], [p2]: [z.id], [p3]: [z.id] });
  s.restoreTags(before);
  assert.deepEqual(s.getTagsFor([p1, p2, p3]), before);
  assert.equal(s.listTaggedImages().length, 2, 'untagged entries are dropped again');
});

test('hierarchy survives a save/load roundtrip', () => {
  const s = mk();
  const a = s.addTag({ name: '動物' });
  const b = s.addTag({ name: '犬', parentId: a.id });
  s.flush();
  const s2 = mk();
  assert.equal(s2.getTag(b.id).parentId, a.id);
});
