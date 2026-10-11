'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildArgs, displayCommand, FETCH_DEFAULTS } = require('../src/main/fetcher');

const base = { url: 'https://example.com/a?b=1', genre: 'g', title: 't' };

test('buildArgs maps the form to uv run fotoget argv', () => {
  assert.deepEqual(buildArgs({ ...base, author: 'au', numbered: true, minSize: '300', out: 'C:\out dir' }), [
    'run', 'fotoget', '--genre=g', '--title=t', '--author=au', '-n', '--out=C:\out dir', '--min-size=300', '--', 'https://example.com/a?b=1',
  ]);
});

test('buildArgs defaults: -n on, default out and min size, no author', () => {
  const a = buildArgs(base);
  assert.ok(a.includes('-n'));
  assert.ok(a.includes(`--out=${FETCH_DEFAULTS.out}`));
  assert.ok(a.includes(`--min-size=${FETCH_DEFAULTS.minSize}`));
  assert.ok(!a.some((x) => x.startsWith('--author')));
  assert.ok(!buildArgs({ ...base, numbered: false }).includes('-n'));
});

test('buildArgs keeps option-like values as values and trims', () => {
  const a = buildArgs({ ...base, title: '  -n weird & "x"  ' });
  assert.ok(a.includes('--title=-n weird & "x"'));
  assert.equal(a.filter((x) => x === '-n').length, 1);
});

test('buildArgs rejects missing or invalid input', () => {
  assert.throws(() => buildArgs({ ...base, url: '' }), /URL を入力/);
  assert.throws(() => buildArgs({ ...base, url: 'file:///C:/x' }), /http/);
  assert.throws(() => buildArgs({ ...base, url: 'not a url' }), /形式/);
  assert.throws(() => buildArgs({ ...base, genre: ' ' }), /ジャンル/);
  assert.throws(() => buildArgs({ ...base, title: '' }), /タイトル/);
  assert.throws(() => buildArgs({ ...base, minSize: '-1' }), /最小サイズ/);
  assert.throws(() => buildArgs({ ...base, minSize: '1.5' }), /最小サイズ/);
});

test('displayCommand quotes arguments with spaces', () => {
  assert.equal(displayCommand(['run', '--out=C:\a b']), 'uv run "--out=C:\a b"');
});
