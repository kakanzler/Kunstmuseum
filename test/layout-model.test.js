'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

let LayoutModel;
let MAX_GROUPS;
test.before(async () => {
  ({ LayoutModel, MAX_GROUPS } = await import('../src/renderer/layout-model.js'));
});

const kinds = (m) => m.groups.map((g) => g.tabs.map((t) => (t.kind === 'image' ? `image:${t.path}` : t.kind)));
const sizesOk = (m) => Math.abs(m.groups.reduce((s, g) => s + g.size, 0) - 1) < 1e-9;

test('default layout is gallery | preview with the gallery active', () => {
  const m = LayoutModel.createDefault({}, { source: { kind: 'folder', path: 'C:\\P' } });
  assert.deepEqual(kinds(m), [['gallery'], ['preview']]);
  assert.equal(m.activeTab().kind, 'gallery');
  assert.equal(m.activeTab().state.source.path, 'C:\\P');
  assert.ok(sizesOk(m));
});

test('splitting a gallery duplicates its state into a new group', () => {
  const m = LayoutModel.createDefault({}, { search: 'x' });
  const gal = m.activeTab();
  const dup = m.splitTab(gal.id, 'right', () => ({ search: 'live', sortKey: 'size' }));
  assert.deepEqual(kinds(m), [['gallery'], ['gallery'], ['preview']]);
  assert.notEqual(dup.id, gal.id);
  assert.deepEqual(dup.state, { search: 'live', sortKey: 'size' });
  assert.equal(m.activeTab().id, dup.id);
  assert.ok(sizesOk(m));
});

test('splitting a singleton moves it; splitting an image duplicates the path', () => {
  const m = LayoutModel.createDefault();
  const g1 = m.groups[0].id;
  const img = m.addTab(g1, { kind: 'image', path: 'C:\\a.png' });
  const preview = m.findSingleton('preview');
  m.splitTab(preview.id, 'left');
  assert.equal(m.groups.filter((g) => g.tabs.some((t) => t.kind === 'preview')).length, 1);
  const copy = m.splitTab(img.id, 'right');
  assert.notEqual(copy.id, img.id);
  assert.equal(copy.path, 'C:\\a.png');
  assert.notEqual(m.groupOf(copy.id).id, m.groupOf(img.id).id);
});

test('an image is only opened once per group', () => {
  const m = new LayoutModel({ caseInsensitive: true });
  const g = m.addGroup();
  const a = m.addTab(g.id, { kind: 'image', path: 'C:\\A.png' });
  const b = m.addTab(g.id, { kind: 'image', path: 'c:\\a.png' });
  assert.equal(a.id, b.id);
  assert.equal(m.groups[0].tabs.length, 1);
});

test('moving an image into a group that already shows it merges the tabs', () => {
  const m = new LayoutModel();
  const g1 = m.addGroup();
  const a = m.addTab(g1.id, { kind: 'image', path: 'p.png' });
  m.addTab(g1.id, { kind: 'gallery' });
  const g2 = m.addGroup(g1.id, 'right');
  const b = m.addTab(g2.id, { kind: 'image', path: 'p.png' });
  m.addTab(g2.id, { kind: 'graph' });
  const r = m.moveTab(a.id, g2.id);
  assert.equal(r.id, b.id);
  assert.equal(m.allTabs().filter((t) => t.kind === 'image').length, 1);
});

test('singletons are unique: adding again moves the existing tab', () => {
  const m = LayoutModel.createDefault();
  const before = m.findSingleton('preview');
  const again = m.addTab(m.groups[0].id, { kind: 'preview' });
  assert.equal(again.id, before.id);
  assert.deepEqual(kinds(m), [['gallery', 'preview']], 'the emptied group is removed');
});

test('closing the last tab removes the group and reassigns the active group', () => {
  const m = LayoutModel.createDefault();
  const preview = m.findSingleton('preview');
  m.activateTab(preview.id);
  m.closeTab(preview.id);
  assert.equal(m.groups.length, 1);
  assert.equal(m.activeGroupId, m.groups[0].id);
  assert.ok(sizesOk(m));
  m.closeTab(m.groups[0].tabs[0].id);
  assert.equal(m.groups.length, 0);
  assert.equal(m.activeGroupId, null);
  const t = m.addTab('nope', { kind: 'gallery' });
  assert.ok(t, 'adding into an empty layout creates a group');
  assert.equal(m.groups.length, 1);
});

test('closing the active tab activates the most recently used one in the group', () => {
  const m = new LayoutModel();
  const g = m.addGroup();
  const a = m.addTab(g.id, { kind: 'gallery' });
  const b = m.addTab(g.id, { kind: 'graph' });
  const c = m.addTab(g.id, { kind: 'preview' });
  m.activateTab(a.id);
  m.activateTab(c.id);
  m.closeTab(c.id);
  assert.equal(m.groups[0].activeTabId, a.id);
  assert.ok(b);
});

test('drop on left/right creates a new group, max 4 groups, then falls back to center', () => {
  const m = new LayoutModel();
  const g = m.addGroup();
  const tabs = [];
  for (let i = 0; i < 6; i++) tabs.push(m.addTab(g.id, { kind: 'gallery' }));
  m.dropTab(tabs[0].id, g.id, 'left');
  assert.equal(m.groups.length, 2);
  assert.equal(m.groups[0].tabs[0].id, tabs[0].id);
  m.dropTab(tabs[1].id, g.id, 'right');
  m.dropTab(tabs[2].id, g.id, 'right');
  assert.equal(m.groups.length, MAX_GROUPS);
  m.dropTab(tabs[3].id, m.groups[0].id, 'left');
  assert.equal(m.groups.length, MAX_GROUPS, 'no fifth group');
  assert.equal(m.groupOf(tabs[3].id).id, m.groups[0].id, 'treated as center');
  assert.ok(sizesOk(m));
});

test('dropping a group\'s only tab on its own side is a no-op', () => {
  const m = LayoutModel.createDefault();
  const preview = m.findSingleton('preview');
  const g = m.groupOf(preview.id);
  m.dropTab(preview.id, g.id, 'left');
  assert.deepEqual(kinds(m), [['gallery'], ['preview']]);
});

test('moving a tab to a new left group and closing it removes the empty group', () => {
  const m = LayoutModel.createDefault();
  const g1 = m.groups[0];
  const extra = m.addTab(g1.id, { kind: 'graph' });
  m.dropTab(extra.id, g1.id, 'left');
  assert.deepEqual(kinds(m), [['graph'], ['gallery'], ['preview']]);
  m.closeTab(extra.id);
  assert.deepEqual(kinds(m), [['gallery'], ['preview']]);
  assert.ok(sizesOk(m));
});

test('reorder within a group and move to neighbour groups', () => {
  const m = new LayoutModel();
  const g = m.addGroup();
  const a = m.addTab(g.id, { kind: 'gallery' });
  const b = m.addTab(g.id, { kind: 'graph' });
  const c = m.addTab(g.id, { kind: 'preview' });
  m.moveTab(c.id, g.id, 0);
  assert.deepEqual(m.groups[0].tabs.map((t) => t.id), [c.id, a.id, b.id]);
  m.moveTab(c.id, g.id, 3);
  assert.deepEqual(m.groups[0].tabs.map((t) => t.id), [a.id, b.id, c.id]);
  m.moveTab(a.id, g.id);
  assert.deepEqual(m.groups[0].tabs.map((t) => t.id), [b.id, c.id, a.id]);
  m.moveTabToNeighbor(b.id, 'right');
  assert.equal(m.groups.length, 2);
  assert.equal(m.groups[1].tabs[0].id, b.id);
  m.moveTabToNeighbor(b.id, 'left');
  assert.equal(m.groups.length, 1, 'moving the only tab back removes its group');
});

test('mruGallery tracks the most recently activated gallery', () => {
  const m = new LayoutModel();
  const g = m.addGroup();
  const a = m.addTab(g.id, { kind: 'gallery' });
  const b = m.addTab(g.id, { kind: 'gallery' });
  m.addTab(g.id, { kind: 'graph' });
  assert.equal(m.mruGallery().id, b.id);
  m.activateTab(a.id);
  assert.equal(m.mruGallery().id, a.id);
});

test('serialize/restore roundtrip', () => {
  const m = LayoutModel.createDefault({}, { source: { kind: 'tagged' }, tagFilter: ['t1'] });
  const g1 = m.groups[0].id;
  m.addTab(g1, { kind: 'image', path: 'C:\\x.png' });
  m.splitTab(m.groups[0].tabs[0].id, 'right', (t) => t.state);
  m.addTab(m.groups[2].id, { kind: 'graph' });
  m.setGroupSizes([0.5, 0.2, 0.3]);
  const data = m.serialize();
  const json = JSON.parse(JSON.stringify(data));
  const r = LayoutModel.restore(json);
  assert.deepEqual(r.serialize(), data);
  // ids keep being unique after restore
  const t = r.addTab(r.groups[0].id, { kind: 'gallery' });
  assert.ok(!data.groups.some((g) => g.tabs.some((x) => x.id === t.id)));
});

test('restore drops missing images, duplicate singletons, bad tabs and empty groups', () => {
  const data = {
    seq: 9,
    activeGroupId: 'gX',
    mru: ['t1', 'zzz'],
    groups: [
      { id: 'g1', size: 1, activeTabId: 't3', tabs: [
        { id: 't1', kind: 'gallery', state: { a: 1 } },
        { id: 't2', kind: 'preview' },
        { id: 't3', kind: 'image', path: 'gone.png' },
        { id: 't4', kind: 'bogus' },
      ] },
      { id: 'g2', size: 1, tabs: [{ id: 't5', kind: 'image', path: 'gone.png' }] },
      { id: 'g3', size: 2, tabs: [{ id: 't6', kind: 'preview' }, { id: 't7', kind: 'image', path: 'ok.png' }] },
    ],
  };
  const r = LayoutModel.restore(data, {}, { pathOk: (p) => p !== 'gone.png' });
  assert.deepEqual(kinds(r), [['gallery', 'preview'], ['image:ok.png']]);
  assert.equal(r.groups[0].activeTabId, 't1');
  assert.equal(r.activeGroupId, 'g1');
  assert.deepEqual(r.mru, ['t1']);
  assert.ok(sizesOk(r));
  assert.equal(LayoutModel.restore(null), null);
});

test('remapPaths and cycleTab', () => {
  const m = new LayoutModel();
  const g = m.addGroup();
  const a = m.addTab(g.id, { kind: 'image', path: 'd/a.png' });
  const b = m.addTab(g.id, { kind: 'image', path: 'd/b.png' });
  assert.ok(m.remapPaths((p) => (p.startsWith('d/') ? `e/${p.slice(2)}` : null)));
  assert.equal(m.tab(a.id).path, 'e/a.png');
  m.activateTab(b.id);
  assert.equal(m.cycleTab(1).id, a.id);
  assert.equal(m.cycleTab(-1).id, b.id);
});

// ---------- Alt+P: showPreviewRight ----------
const where = (m, kind = 'preview') => m.groupIndex(m.groupOf(m.findSingleton(kind).id).id);

test('showPreviewRight case 1: no Preview → new group right of the rightmost active group', () => {
  const m = new LayoutModel();
  const a = m.addGroup();
  const gal = m.addTab(a.id, { kind: 'gallery' });
  const t = m.showPreviewRight(a.id);
  assert.equal(t.kind, 'preview');
  assert.deepEqual(kinds(m), [['gallery'], ['preview']]);
  assert.equal(m.groups[1].activeTabId, t.id, 'Preview is the active tab of its group');
  assert.equal(m.activeGroupId, a.id, 'focus stays on A');
  assert.equal(m.activeTab().id, gal.id);
  assert.ok(sizesOk(m));
});

test('showPreviewRight case 1: no Preview → the existing group immediately right of A', () => {
  const m = new LayoutModel();
  const a = m.addGroup();
  m.addTab(a.id, { kind: 'gallery' });
  const b = m.addGroup(a.id, 'right');
  const img = m.addTab(b.id, { kind: 'image', path: 'x.png' });
  m.addGroup(b.id, 'right');
  m.addTab(m.groups[2].id, { kind: 'graph' });
  m.activateGroup(a.id);
  m.showPreviewRight(a.id);
  assert.deepEqual(kinds(m), [['gallery'], ['image:x.png', 'preview'], ['graph']]);
  assert.equal(m.group(b.id).activeTabId, m.findSingleton('preview').id);
  assert.notEqual(m.group(b.id).activeTabId, img.id);
  assert.equal(m.activeGroupId, a.id);
});

test('showPreviewRight case 1 at 4 groups with A rightmost → rightmost group other than A', () => {
  const m = new LayoutModel();
  const g = [m.addGroup()];
  for (let i = 0; i < 3; i++) g.push(m.addGroup(g[i].id, 'right'));
  g.forEach((x) => m.addTab(x.id, { kind: 'gallery' }));
  m.activateGroup(g[3].id);
  m.showPreviewRight(g[3].id);
  assert.equal(m.groups.length, 4);
  assert.equal(where(m), 2);
  assert.equal(m.activeGroupId, g[3].id);
});

test('showPreviewRight case 2: Preview already to the right → only activated, nothing moves', () => {
  const m = new LayoutModel();
  const a = m.addGroup();
  m.addTab(a.id, { kind: 'gallery' });
  const b = m.addGroup(a.id, 'right');
  const c = m.addGroup(b.id, 'right');
  m.addTab(b.id, { kind: 'graph' });
  const p = m.addTab(c.id, { kind: 'preview' });
  const img = m.addTab(c.id, { kind: 'image', path: 'y.png' });
  m.activateGroup(a.id);
  const before = kinds(m);
  m.showPreviewRight(a.id);
  assert.deepEqual(kinds(m), before, 'not moved (even though it is not adjacent)');
  assert.equal(m.group(c.id).activeTabId, p.id);
  assert.ok(img);
  assert.equal(m.activeGroupId, a.id);
  const again = JSON.stringify(m.serialize());
  m.showPreviewRight(a.id);
  assert.equal(JSON.stringify(m.serialize()), again, 'idempotent');
});

test('showPreviewRight case 3: Preview left of A moves right of A; the emptied group is removed', () => {
  const m = new LayoutModel();
  const left = m.addGroup();
  m.addTab(left.id, { kind: 'preview' });
  const a = m.addGroup(left.id, 'right');
  const gal = m.addTab(a.id, { kind: 'gallery' });
  m.activateTab(gal.id);
  m.showPreviewRight(a.id);
  assert.deepEqual(kinds(m), [['gallery'], ['preview']]);
  assert.equal(m.activeGroupId, a.id);
  assert.equal(m.activeTab().id, gal.id);
  assert.ok(sizesOk(m));
});

test('showPreviewRight case 3: Preview inside A moves out to the right group', () => {
  const m = new LayoutModel();
  const a = m.addGroup();
  const gal = m.addTab(a.id, { kind: 'gallery' });
  const p = m.addTab(a.id, { kind: 'preview' });
  const b = m.addGroup(a.id, 'right');
  m.addTab(b.id, { kind: 'graph' });
  m.activateTab(p.id);
  m.showPreviewRight(a.id);
  assert.deepEqual(kinds(m), [['gallery'], ['graph', 'preview']]);
  assert.equal(m.group(a.id).activeTabId, gal.id, 'A shows its remaining tab');
  assert.equal(m.group(b.id).activeTabId, p.id);
  assert.equal(m.activeGroupId, a.id);
});

test('showPreviewRight case 3 at 4 groups: from the left into the rightmost group other than A', () => {
  const m = new LayoutModel();
  const g = [m.addGroup()];
  for (let i = 0; i < 3; i++) g.push(m.addGroup(g[i].id, 'right'));
  m.addTab(g[0].id, { kind: 'preview' });
  m.addTab(g[0].id, { kind: 'graph' });
  g.slice(1).forEach((x) => m.addTab(x.id, { kind: 'gallery' }));
  m.activateGroup(g[3].id);
  m.showPreviewRight(g[3].id);
  assert.equal(m.groups.length, 4);
  assert.equal(where(m), 2);
  assert.equal(m.activeGroupId, g[3].id);
});

test('showPreviewRight: Preview as the only tab of A stays put (A is not dissolved)', () => {
  const m = new LayoutModel();
  const a = m.addGroup();
  m.addTab(a.id, { kind: 'preview' });
  m.showPreviewRight(a.id);
  assert.deepEqual(kinds(m), [['preview']]);
  assert.equal(m.activeGroupId, a.id);
});
