'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

let Playlist;
let shuffle;
test.before(async () => {
  ({ Playlist, shuffle } = await import('../src/renderer/playlist.js'));
});

const items = (...names) => names.map((n) => ({ name: n, path: `C:\\p\\${n}` }));
const names = (list) => list.map((x) => x.name);

/** deterministic PRNG (mulberry32) */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('name order is natural', () => {
  const p = new Playlist(items('img10.png', 'img2.png', 'img1.png'));
  assert.deepEqual(names(p.order), ['img1.png', 'img2.png', 'img10.png']);
  assert.equal(p.current.name, 'img1.png');
});

test('next/prev with loop wrap around', () => {
  const p = new Playlist(items('a', 'b', 'c'), { loop: true });
  assert.equal(p.next().name, 'b');
  assert.equal(p.next().name, 'c');
  assert.equal(p.peekNext().name, 'a');
  assert.equal(p.next().name, 'a');
  assert.equal(p.pass, 1);
  assert.equal(p.prev().name, 'c', 'prev from the first item wraps to the last');
  assert.equal(p.prev().name, 'b');
});

test('without loop the list stops on the last item', () => {
  const p = new Playlist(items('a', 'b'), { loop: false });
  assert.equal(p.atEnd, false);
  assert.equal(p.next().name, 'b');
  assert.equal(p.atEnd, true);
  assert.equal(p.peekNext(), null);
  assert.equal(p.next(), null);
  assert.equal(p.current.name, 'b', 'stays on the last image');
  p.prev();
  p.prev();
  assert.equal(p.current.name, 'a', 'prev stops at the first image');
});

test('random order reshuffles on each pass and peekNext agrees with next', () => {
  const list = items('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
  const p = new Playlist(list, { order: 'random', loop: true, random: rng(42) });
  const passes = [];
  for (let pass = 0; pass < 4; pass++) {
    const seen = [p.current];
    for (let i = 1; i < list.length; i++) seen.push(p.next());
    passes.push(names(seen));
    assert.deepEqual([...names(seen)].sort(), names(list), 'each pass is a permutation');
    const peek = p.peekNext();
    const nxt = p.next();
    assert.equal(nxt, peek, 'preloaded item is the one shown next');
    assert.notEqual(nxt, seen[seen.length - 1], 'no immediate repeat across passes');
  }
  assert.ok(new Set(passes.map((x) => x.join())).size > 1, 'orders differ between passes');
});

test('shuffle is a permutation', () => {
  const a = [1, 2, 3, 4, 5];
  assert.deepEqual(shuffle(a, rng(1)).sort(), a);
});

test('remove skips broken items and keeps the position sane', () => {
  const p = new Playlist(items('a', 'b', 'c'), { loop: true });
  p.next(); // b
  p.remove(p.current);
  assert.equal(p.current.name, 'c');
  assert.equal(p.length, 2);
  p.remove(p.current);
  assert.equal(p.current.name, 'a', 'removing the last wraps when looping');
  p.remove(p.current);
  assert.equal(p.length, 0);
  assert.equal(p.current, null);
  assert.equal(p.next(), null);
});
