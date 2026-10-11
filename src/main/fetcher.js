'use strict';
// 画像取得 (fotoget): runs `uv run fotoget …` in the fotoget project folder and
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

/**
 * Validated argv for `uv` from the panel form. Throws a user-facing (Japanese)
 * error for missing / invalid fields.
 */
function buildArgs(opts) {
  const o = opts || {};
  const url = str(o.url);
  const genre = str(o.genre);
  const title = str(o.title);
  const author = str(o.author);
  const out = str(o.out) || DEFAULTS.out;
  if (!url) throw new Error('URL を入力してください。');
  let u;
  try { u = new URL(url); } catch { throw new Error('URL の形式が正しくありません。'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('URL は http:// か https:// で始めてください。');
  if (!genre) throw new Error('ジャンルを入力してください。');
  if (!title) throw new Error('タイトルを入力してください。');
  const minSize = o.minSize === undefined || o.minSize === '' ? DEFAULTS.minSize : Number(o.minSize);
  if (!Number.isInteger(minSize) || minSize < 0 || minSize > 100000) throw new Error('最小サイズは 0 以上の整数で指定してください。');
  // `--opt=value` keeps a value that starts with "-" from being read as an option
  const args = ['run', 'fotoget', `--genre=${genre}`, `--title=${title}`];
  if (author) args.push(`--author=${author}`);
  if (o.numbered !== false) args.push('-n');
  args.push(`--out=${out}`, `--min-size=${minSize}`, '--', url);
  return args;
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
    const args = buildArgs(opts);
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
    return { id, command: displayCommand(args), cwd };
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

module.exports = { FetchRunner, buildArgs, displayCommand, FETCH_DEFAULTS: DEFAULTS };
