'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildArgs, displayCommand, genreOptions, listGenreDirs, FETCH_DEFAULTS } = require('../src/main/fetcher');

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

test('buildArgs list mode runs fotoget-list with --pages and no title', () => {
  assert.deepEqual(buildArgs({ ...base, title: '', mode: 'list', pages: ' 1-248 ', minSize: '200', out: 'D:\o' }), [
    'run', 'fotoget-list', '--pages=1-248', '--genre=g', '-n', '--out=D:\o', '--min-size=200', '--', 'https://example.com/a?b=1',
  ]);
  assert.ok(buildArgs({ ...base, mode: 'list' }).includes('--pages=1'));
  assert.ok(buildArgs({ ...base, mode: 'list', pages: '1-3,7' }).includes('--pages=1-3,7'));
  assert.throws(() => buildArgs({ ...base, mode: 'list', pages: '1-' }), /ページ/);
  assert.throws(() => buildArgs({ ...base, mode: 'list', pages: '--x' }), /ページ/);
  assert.throws(() => buildArgs({ ...base, mode: 'list', genre: '' }), /ジャンル/);
});

test('displayCommand quotes arguments with spaces', () => {
  assert.equal(displayCommand(['run', '--out=C:\a b']), 'uv run "--out=C:\a b"');
});

test('genreOptions: save-folder dirs + history, <genre>-<author> folded, sorted, unique', () => {
  assert.deepEqual(genreOptions(['百合', 'JK-山田', 'NTR', '9999---others'], ['JK', '百合'], ['山田']),
    ['9999---others', 'JK', 'NTR', '百合']);
  // an unknown author keeps the folder as its own genre
  assert.deepEqual(genreOptions(['JK-田中'], ['JK'], ['山田']), ['JK', 'JK-田中']);
  assert.deepEqual(genreOptions(null, undefined, 'x'), []);
  assert.deepEqual(genreOptions(['  ', 'a'], ['', ' a ']), ['a']);
});

test('listGenreDirs lists only folders, and [] for a missing folder', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(process.env.KM_TEST_TMP || os.tmpdir(), 'km-genres-'));
  try {
    fs.mkdirSync(path.join(dir, '百合'));
    fs.mkdirSync(path.join(dir, '.hidden'));
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
    assert.deepEqual(await listGenreDirs(dir), ['百合']);
    assert.deepEqual(await listGenreDirs(path.join(dir, 'nope')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
