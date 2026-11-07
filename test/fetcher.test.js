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

test('buildArgs list mode runs fotoget-list with from-to pages, workers and no title', () => {
  assert.deepEqual(buildArgs({ ...base, title: '', mode: 'list', pageFrom: ' 1 ', pageTo: '248', workers: '4', minSize: '200', out: 'D:\o' }), [
    'run', 'fotoget-list', '--pages=1-248', '--workers=4', '--genre=g', '-n', '--out=D:\o', '--min-size=200', '--', 'https://example.com/a?b=1',
  ]);
  const a = buildArgs({ ...base, mode: 'list' }); // empty from / to / workers
  assert.ok(a.includes('--pages=1-') && a.includes('--workers=1'), 'empty 終了 runs until the last page');
  assert.ok(buildArgs({ ...base, mode: 'list', pageFrom: '5', pageTo: '5' }).includes('--pages=5-5'));
  assert.ok(buildArgs({ ...base, mode: 'list', pageFrom: '7' }).includes('--pages=7-'));
  assert.throws(() => buildArgs({ ...base, mode: 'list', pageFrom: '0' }), /開始ページ/);
  assert.throws(() => buildArgs({ ...base, mode: 'list', pageFrom: '1.5' }), /開始ページ/);
  assert.throws(() => buildArgs({ ...base, mode: 'list', pageTo: '-3' }), /終了ページ/);
  assert.throws(() => buildArgs({ ...base, mode: 'list', pageFrom: '10', pageTo: '3' }), /開始ページ以上/);
  assert.throws(() => buildArgs({ ...base, mode: 'list', workers: '0' }), /並列数/);
  assert.throws(() => buildArgs({ ...base, mode: 'list', workers: '17' }), /並列数/);
  assert.throws(() => buildArgs({ ...base, mode: 'list', genre: '' }), /ジャンル/);
});

test('buildJob 複数URL mode feeds the post list to fotoget-list via stdin', () => {
  const { buildJob, postLines } = require('../src/main/fetcher');
  const urls = '# memo\r\n https://x/a.html \n\nhttps://x/b.html  手動 タイトル\n';
  const job = buildJob({ mode: 'urls', urls, genre: 'g', workers: '3', minSize: '200', out: 'D:\\o', url: 'ignored' });
  assert.deepEqual(job.args, ['run', 'fotoget-list', '--posts-file=-', '--workers=3', '--genre=g', '-n', '--out=D:\\o', '--min-size=200']);
  assert.equal(job.stdin, 'https://x/a.html\nhttps://x/b.html  手動 タイトル\n');
  assert.equal(job.count, 2);
  assert.equal(buildJob(base).stdin, null);
  assert.throws(() => postLines('https://x/a.html\nftp://x/b'), /2 行目/);
  assert.throws(() => postLines('\n# only a comment\n'), /1 行に 1 つ/);
  assert.throws(() => buildJob({ mode: 'urls', urls: 'https://x/a', genre: '' }), /ジャンル/);
  assert.throws(() => buildJob({ mode: 'urls', urls: 'https://x/a', genre: 'g', workers: '99' }), /並列数/);
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
