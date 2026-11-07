'use strict';
// 画像取得 (fotoget): runs `uv run fotoget …` (one page) or `uv run fotoget-list …`
// (every post of a paginated listing, mode 'list'; or the posts listed in the
// form, mode 'urls', fed through stdin) in the fotoget project folder and
// streams its output to the renderer. Arguments are passed as an argv array
// (no shell), so titles / URLs can never be interpreted as shell syntax.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const DEFAULTS = Object.freeze({
  cwd: 'D:\\Workspace\\010---dasFotoLandwirt',
  out: 'C:\\Users\\hakuu\\Documents\\304-illustration\\999---ref\\601---r18',
  minSize: 300,
  numbered: true,
});

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const MAX_WORKERS = 16; // fotoget-list --workers upper bound

/** Optional positive integer field: '' → fallback, otherwise an int in [1, max] or NaN. */
function posInt(v, fallback, max = 100000) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (s === '') return fallback;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : NaN;
}

function checkUrl(url, where = '') {
  let u;
  try { u = new URL(url); } catch { throw new Error(`${where}URL の形式が正しくありません。`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${where}URL は http:// か https:// で始めてください。`);
}

/**
 * 複数URL mode: one post per line, "URL" or "URL title"; blank lines and
 * "#" comments are skipped. Returns the normalized lines (throws on a bad one).
 */
function postLines(text) {
  const lines = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    checkUrl(line.split(/\s+/, 1)[0], `${i + 1} 行目: `);
    lines.push(line);
  });
  if (!lines.length) throw new Error('記事の URL を 1 行に 1 つずつ入力してください。');
  return lines;
}

/** Validated argv for `uv`; see buildJob. */
function buildArgs(opts) {
  return buildJob(opts).args;
}

/**
 * Validated `uv` argv (and, in 複数URL mode, the text fed to its stdin) from
 * the panel form. Throws a user-facing (Japanese) error for missing / invalid fields.
 */
function buildJob(opts) {
  const o = opts || {};
  const multi = o.mode === 'urls';
  const list = o.mode === 'list';
  const url = str(o.url);
  const genre = str(o.genre);
  const title = str(o.title);
  const author = str(o.author);
  const out = str(o.out) || DEFAULTS.out;
  const posts = multi ? postLines(o.urls) : null;
  if (!multi) {
    if (!url) throw new Error('URL を入力してください。');
    checkUrl(url);
  }
  if (!genre) throw new Error('ジャンルを入力してください。');
  let pages = '';
  let workers = 1;
  if (list || multi) {
    workers = posInt(o.workers, 1, MAX_WORKERS);
    if (Number.isNaN(workers)) throw new Error(`並列数は 1〜${MAX_WORKERS} の整数で指定してください。`);
  }
  if (list) {
    // 開始〜終了; an empty 終了 means "until a listing page has no posts" (fotoget-list "N-")
    const from = posInt(o.pageFrom, 1);
    const to = posInt(o.pageTo, null);
    if (Number.isNaN(from)) throw new Error('開始ページは 1 以上の整数で指定してください。');
    if (Number.isNaN(to)) throw new Error('終了ページは 1 以上の整数で指定してください（空欄なら最後まで）。');
    if (to !== null && to < from) throw new Error('終了ページは開始ページ以上にしてください。');
    pages = to === null ? `${from}-` : `${from}-${to}`;
  } else if (!multi && !title) throw new Error('タイトルを入力してください。');
  const minSize = o.minSize === undefined || o.minSize === '' ? DEFAULTS.minSize : Number(o.minSize);
  if (!Number.isInteger(minSize) || minSize < 0 || minSize > 100000) throw new Error('最小サイズは 0 以上の整数で指定してください。');
  // `--opt=value` keeps a value that starts with "-" from being read as an option
  let args;
  if (multi) args = ['run', 'fotoget-list', '--posts-file=-', `--workers=${workers}`, `--genre=${genre}`]; // URLs go via stdin
  else if (list) args = ['run', 'fotoget-list', `--pages=${pages}`, `--workers=${workers}`, `--genre=${genre}`]; // titles from each post's h1
  else args = ['run', 'fotoget', `--genre=${genre}`, `--title=${title}`];
  if (author) args.push(`--author=${author}`);
  if (o.numbered !== false) args.push('-n');
  args.push(`--out=${out}`, `--min-size=${minSize}`);
  if (!multi) args.push('--', url);
  return { args, stdin: multi ? `${posts.join('\n')}\n` : null, count: posts ? posts.length : 1 };
}

/**
 * ジャンル pulldown choices: the folders already in the save folder plus the
 * genres used before. fotoget names a folder <genre>-<author> when an author
 * is given, so such a folder counts as its genre when both parts are known.
 */
function genreOptions(dirNames, history = [], authors = []) {
  const clean = (xs) => (Array.isArray(xs) ? xs : []).map(str).filter(Boolean);
  const dirs = clean(dirNames);
  const hist = clean(history);
  const auth = clean(authors);
  const known = new Set([...dirs, ...hist]);
  const out = new Set(hist);
  for (const d of dirs) {
    const g = [...known].find((k) => k !== d && auth.some((a) => d === `${k}-${a}`));
    out.add(g || d);
  }
  return [...out].sort((a, b) => a.localeCompare(b, 'ja'));
}

/** Folder names directly inside `out` (an unreadable / missing folder → []). */
async function listGenreDirs(out) {
  const dir = str(out) || DEFAULTS.out;
  try {
    const ents = await fs.promises.readdir(dir, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Display form of a command line (for the panel; not executed). */
function displayCommand(args) {
  return ['uv', ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
}

class FetchRunner {
  /** @param {(channel: string, payload: object) => void} send */
  constructor(send) {
    this.send = send;
    this.job = null;
    this.seq = 0;
  }

  get running() {
    return !!this.job;
  }

  run(opts) {
    if (this.job) throw new Error('取得を実行中です。完了するか中止してから実行してください。');
    const { args, stdin, count } = buildJob(opts);
    const cwd = str(opts && opts.cwd) || DEFAULTS.cwd;
    if (!fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
      throw new Error(`実行フォルダに pyproject.toml がありません: ${cwd}`);
    }
    const id = ++this.seq;
    const child = spawn('uv', args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', NO_COLOR: '1', TERM: 'dumb', PYTHONUNBUFFERED: '1', COLUMNS: '46' }, // rich: fit the sidebar log
    });
    this.job = { id, child, cancelled: false };
    child.stdin.on('error', () => {}); // the process may exit before reading it all
    child.stdin.end(stdin === null ? undefined : Buffer.from(stdin, 'utf8')); // 複数URL: the post list
    const forward = (stream) => (chunk) => this.send('fetch:output', { id, stream, text: chunk.toString('utf8') });
    child.stdout.on('data', forward('stdout'));
    child.stderr.on('data', forward('stderr'));
    let finished = false;
    const finish = (code, error) => {
      if (finished) return;
      finished = true;
      const cancelled = this.job && this.job.id === id && this.job.cancelled;
      if (this.job && this.job.id === id) this.job = null;
      this.send('fetch:done', { id, code, cancelled, error: error || null });
    };
    child.on('error', (e) => finish(null, e.code === 'ENOENT' ? 'uv が見つかりません（PATH を確認してください）。' : e.message));
    child.on('close', (code) => finish(code));
    return { id, command: displayCommand(args) + (stdin === null ? '' : ` < (記事URL ${count} 件)`), cwd, count };
  }

  /** Stop the running job, including the Python process uv started. */
  cancel() {
    const job = this.job;
    if (!job) return false;
    job.cancelled = true;
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(job.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      job.child.kill('SIGTERM');
    }
    return true;
  }
}

module.exports = { FetchRunner, buildArgs, buildJob, postLines, displayCommand, genreOptions, listGenreDirs, FETCH_DEFAULTS: DEFAULTS, MAX_WORKERS };
