'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

let tt;
test.before(async () => {
  tt = await import('../src/renderer/tag-tree.js');
});

const T = (id, name, parentId = null, typeId = 'cat') => ({ id, name, typeId, parentId });
const tags = [
  T('animal', '動物'),
  T('dog', '犬', 'animal'),
  T('shiba', '柴犬', 'dog'),
  T('cat', '猫', 'animal'),
  T('pet', 'ペット'),
  T('petdog', '犬', 'pet'),
  T('genre1', '風景', null, 'genre'),
];

test('pathLabel and ancestors', () => {
  assert.equal(tt.pathLabel(tags, 'shiba'), '動物 > 犬 > 柴犬');
  assert.equal(tt.pathLabel(tags, 'petdog'), 'ペット > 犬');
  assert.equal(tt.pathLabel(tags, 'animal'), '動物');
  assert.deepEqual(tt.ancestorsOf(tags, 'shiba').map((t) => t.id), ['animal', 'dog']);
  assert.equal(tt.pathLabel(tags, 'nope'), '');
});

test('descendants and expansion', () => {
  assert.deepEqual([...tt.descendantsOf(tags, 'animal')].sort(), ['cat', 'dog', 'shiba']);
  assert.deepEqual([...tt.descendantsOf(tags, 'shiba')], []);
  assert.deepEqual([...tt.expandWithDescendants(tags, ['dog', 'pet'])].sort(), ['dog', 'pet', 'petdog', 'shiba']);
});

test('tree building and flattening (sorted, per type)', () => {
  const flat = tt.flattenTree(tags, 'cat');
  assert.deepEqual(flat.map((n) => `${'-'.repeat(n.depth)}${n.tag.name}`), ['ペット', '-犬', '動物', '-犬', '--柴犬', '-猫']);
  assert.equal(tt.buildTree(tags, 'genre').length, 1);
  assert.equal(flat.find((n) => n.tag.id === 'dog').hasChildren, true);
});

test('cycle refusal and cycle-safe walks', () => {
  assert.equal(tt.wouldCycle(tags, 'animal', 'shiba'), true, 'descendant as parent');
  assert.equal(tt.wouldCycle(tags, 'dog', 'dog'), true, 'self');
  assert.equal(tt.wouldCycle(tags, 'shiba', 'cat'), false);
  assert.equal(tt.wouldCycle(tags, 'dog', null), false);
  const cyclic = [T('a', 'A', 'b'), T('b', 'B', 'a')];
  assert.deepEqual([...tt.descendantsOf(cyclic, 'a')], ['b']);
  assert.equal(tt.pathLabel(cyclic, 'a'), 'B > A');
  assert.equal(tt.flattenTree(cyclic).length, 2, 'every tag appears once');
});

test('filter semantics: a parent matches images tagged with descendants', () => {
  assert.equal(tt.matchesFilter(tags, ['shiba'], ['animal']), true);
  assert.equal(tt.matchesFilter(tags, ['shiba'], ['dog']), true);
  assert.equal(tt.matchesFilter(tags, ['shiba'], ['cat']), false);
  assert.equal(tt.matchesFilter(tags, ['dog'], ['shiba']), false, 'a child filter does not match the parent');
  assert.equal(tt.matchesFilter(tags, ['shiba', 'genre1'], ['animal', 'genre1']), true, 'AND');
  assert.equal(tt.matchesFilter(tags, ['shiba'], ['animal', 'genre1']), false);
  assert.equal(tt.matchesFilter(tags, [], []), true);
  const m = tt.filterMatcher(tags, ['animal']);
  assert.equal(m(['cat']), true);
  assert.equal(m(['petdog']), false);
});

test('bulk edit: direct counts, states, cycling actions, plan and apply', () => {
  const map = { a: ['dog', 'x'], b: ['dog'], c: ['shiba'] };
  const counts = tt.directCounts(['a', 'b', 'c'], map);
  assert.equal(counts.get('dog'), 2);
  assert.equal(counts.get('animal'), undefined, 'direct assignments only (no ancestor roll-up)');
  assert.equal(tt.stateOf(2, 3), 'some');
  assert.equal(tt.stateOf(3, 3), 'all');
  assert.equal(tt.stateOf(0, 3), 'none');
  assert.equal(tt.nextAction(null), 'add');
  assert.equal(tt.nextAction('add'), 'remove');
  assert.equal(tt.nextAction('remove'), null);
  const plan = tt.planFromActions(new Map([['cat', 'add'], ['dog', 'remove'], ['animal', null]]));
  assert.deepEqual(plan, { add: ['cat'], remove: ['dog'] });
  const after = tt.applyPlan(map, plan);
  assert.deepEqual(after, { a: ['x', 'cat'], b: ['cat'], c: ['shiba', 'cat'] });
  assert.deepEqual(tt.applyPlan(after, { add: ['animal'], remove: ['shiba'] }).c, ['cat', 'animal'], 'ancestor add + descendant remove are independent');
});
