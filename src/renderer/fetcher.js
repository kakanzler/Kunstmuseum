// 画像取得サイドバー (Ctrl+]): a form for `uv run fotoget <url> --genre --title …`
// run in the fotoget project folder. The main process spawns the job; its
// output streams into the log below the form. One job at a time.
import { api, state, saveSettings } from './state.js';
import { el, toast, toastError } from './ui.js';
import { keyLabel } from './commands.js';

const MAX_LOG_LINES = 600;
const MAX_HISTORY = 30;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

let panel = null;
let layout = null;
let f = null;          // form elements
let job = null;        // { id } while running
let defaults = null;   // from main (cwd / out / minSize / numbered)
let logLines = [];
let partial = '';      // incomplete last line (no newline yet)

export function isFetchOpen() {
  return !!(layout && layout.classList.contains('fetch-open'));
}

/** For the smoke test. */
export function fetchPanelState() {
  return { open: isFetchOpen(), running: !!job, form: f, log: logLines.slice() };
}

function saved() {
  return state.settings.fetch || {};
}

function persist(extra = {}) {
  const s = saved();
  saveSettings({
    fetch: {
      ...s,
      open: isFetchOpen(),
      genre: f.genre.value.trim(),
      author: f.author.value.trim(),
      numbered: f.numbered.checked,
      minSize: f.minSize.value.trim(),
      out: f.out.value.trim(),
      cwd: f.cwd.value.trim(),
      ...extra,
    },
  });
}

function remember(list, value) {
  const v = (value || '').trim();
  if (!v) return list || [];
  return [v, ...(list || []).filter((x) => x !== v)].slice(0, MAX_HISTORY);
}

function fillDatalist(dl, values) {
  dl.replaceChildren(...(values || []).map((v) => el('option', { value: v })));
}

// ---------- log ----------
function renderLog() {
  f.log.textContent = [...logLines, partial].join('\n');
  f.log.scrollTop = f.log.scrollHeight;
}

function appendLog(text) {
  // ANSI escapes are dropped; "\r" (progress bars) rewrites the current line
  const clean = text.replace(ANSI, '').replace(/\r\n/g, '\n');
  for (const piece of clean.split(/(\n|\r)/)) {
    if (piece === '\n') { logLines.push(partial); partial = ''; } else if (piece === '\r') partial = '';
    else partial += piece;
  }
  if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
  renderLog();
}

function setStatus(text, kind = '') {
  f.status.textContent = text;
  f.status.className = `fetch-status ${kind}`;
}

function setRunning(running) {
  f.run.disabled = running;
  f.cancel.disabled = !running;
  panel.classList.toggle('running', running);
}

// ---------- form ----------
function formValues() {
  return {
    url: f.url.value.trim(),
    genre: f.genre.value.trim(),
    title: f.title.value.trim(),
    author: f.author.value.trim(),
    numbered: f.numbered.checked,
    minSize: f.minSize.value.trim(),
    out: f.out.value.trim(),
    cwd: f.cwd.value.trim(),
  };
}

/** Command preview, mirroring main/fetcher.js buildArgs (display only). */
function previewCommand() {
  const v = formValues();
  const q = (s) => (/[\s"]/.test(s) || !s ? `"${s}"` : s);
  const parts = ['uv run fotoget', q(v.url || '{url}'), '--genre', q(v.genre || '{genre}'), '--title', q(v.title || '{title}')];
  if (v.author) parts.push('--author', q(v.author));
  if (v.numbered) parts.push('-n');
  parts.push('--out', q(v.out || defaults.out), '--min-size', v.minSize || String(defaults.minSize));
  f.preview.textContent = parts.join(' ');
}

async function run() {
  if (job) return;
  const v = formValues();
  setStatus('');
  let res;
  try {
    res = await api.fetchRun(v);
  } catch (e) {
    setStatus(e.message, 'error');
    return;
  }
  job = { id: res.id, title: v.title };
  logLines = [];
  partial = '';
  appendLog(`> ${res.command}\n  (${res.cwd})\n`);
  setRunning(true);
  setStatus('取得中…', 'busy');
  const s = saved();
  persist({ genres: remember(s.genres, v.genre), authors: remember(s.authors, v.author) });
  fillDatalist(f.genreList, saved().genres);
  fillDatalist(f.authorList, saved().authors);
}

function onDone(m) {
  if (!job || m.id !== job.id) return;
  const title = job.title;
  job = null;
  setRunning(false);
  if (partial) { logLines.push(partial); partial = ''; }
  if (m.cancelled) {
    appendLog('\n[中止しました]\n');
    setStatus('中止しました。', 'error');
  } else if (m.error || m.code !== 0) {
    const why = m.error || `終了コード ${m.code}`;
    appendLog(`\n[失敗: ${why}]\n`);
    setStatus(`失敗しました（${why}）。ログを確認してください。`, 'error');
    toast(`画像取得に失敗しました: ${title}`, 'error');
  } else {
    appendLog('\n[完了]\n');
    setStatus(`完了: ${title}`, 'ok');
    toast(`画像を取得しました: ${title}`);
    // ready for the next page: keep genre / author, clear the per-page fields
    f.url.value = '';
    f.title.value = '';
    previewCommand();
    if (isFetchOpen()) f.url.focus();
  }
}

// ---------- panel ----------
function field(label, input, extra = null) {
  return el('label', { class: 'fetch-field' }, el('span', { class: 'fetch-label' }, label), input, extra);
}

function build() {
  const s = saved();
  const input = (cls, attrs = {}) => el('input', { class: `input ${cls}`, spellcheck: 'false', ...attrs });
  f = {
    url: input('fetch-url', { placeholder: 'https://…', type: 'url' }),
    title: input('fetch-title', { placeholder: '保存フォルダ名' }),
    genre: input('fetch-genre', { list: 'fetch-genres', placeholder: 'ジャンル（フォルダ名）' }),
    author: input('fetch-author', { list: 'fetch-authors', placeholder: '任意（<genre>-<author>）' }),
    numbered: el('input', { type: 'checkbox', class: 'fetch-numbered' }),
    minSize: input('fetch-min', { type: 'number', min: '0', step: '1' }),
    out: input('fetch-out'),
    cwd: input('fetch-cwd'),
    genreList: el('datalist', { id: 'fetch-genres' }),
    authorList: el('datalist', { id: 'fetch-authors' }),
    run: el('button', { class: 'btn primary fetch-run', type: 'button' }, '実行'),
    cancel: el('button', { class: 'btn fetch-cancel', type: 'button', disabled: true }, '中止'),
    openOut: el('button', { class: 'btn subtle small fetch-open-out', type: 'button', title: '保存先フォルダを開く' }, '開く'),
    preview: el('div', { class: 'fetch-preview' }),
    status: el('div', { class: 'fetch-status' }),
    log: el('pre', { class: 'fetch-log' }),
  };
  f.genre.value = s.genre || '';
  f.author.value = s.author || '';
  f.numbered.checked = s.numbered !== undefined ? s.numbered !== false : defaults.numbered;
  f.minSize.value = s.minSize || String(defaults.minSize);
  f.out.value = s.out || defaults.out;
  f.cwd.value = s.cwd || defaults.cwd;
  fillDatalist(f.genreList, s.genres);
  fillDatalist(f.authorList, s.authors);

  const close = el('button', { class: 'btn subtle small fetch-close', type: 'button', title: `閉じる (${keyLabel('fetch.toggle')})` }, '×');
  close.addEventListener('click', () => toggleFetchPanel(false));
  f.run.addEventListener('click', run);
  f.cancel.addEventListener('click', () => api.fetchCancel().catch((e) => toastError(e)));
  f.openOut.addEventListener('click', () => api.fetchOpenOut(f.out.value.trim()).catch((e) => toastError(e)));

  for (const k of ['url', 'title', 'genre', 'author', 'minSize', 'out', 'cwd']) {
    f[k].addEventListener('input', previewCommand);
    f[k].addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); run(); }
    });
  }
  for (const k of ['genre', 'author', 'minSize', 'out', 'cwd']) f[k].addEventListener('change', () => persist());
  f.numbered.addEventListener('change', () => { previewCommand(); persist(); });

  panel.replaceChildren(
    el('div', { class: 'fetch-head' }, el('h3', {}, '画像取得（fotoget）'), close),
    el('div', { class: 'fetch-form' },
      field('URL', f.url),
      field('タイトル', f.title),
      field('ジャンル', f.genre),
      field('作者', f.author),
      el('label', { class: 'toggle fetch-check' }, f.numbered, '通し番号を付ける（-n）'),
      field('最小サイズ', f.minSize, el('span', { class: 'muted small' }, 'px')),
      el('details', { class: 'fetch-more' },
        el('summary', {}, '保存先・実行フォルダ'),
        field('保存先', f.out, f.openOut),
        field('実行フォルダ', f.cwd)),
      f.preview,
      el('div', { class: 'fetch-actions' }, f.run, f.cancel),
      f.status),
    f.log,
    f.genreList, f.authorList,
  );
  previewCommand();
}

/** Show / hide the right sidebar (no argument: toggle). */
export function toggleFetchPanel(force) {
  if (!panel) return;
  const open = force === undefined ? !isFetchOpen() : !!force;
  layout.classList.toggle('fetch-open', open);
  persist();
  if (open) requestAnimationFrame(() => (f.url.value ? f.title : f.url).focus());
  else if (panel.contains(document.activeElement)) document.activeElement.blur();
}

export async function initFetchPanel() {
  layout = document.getElementById('layout');
  panel = document.getElementById('fetcher');
  try {
    defaults = await api.fetchDefaults();
  } catch {
    defaults = { cwd: '', out: '', minSize: 300, numbered: true };
  }
  build();
  api.onFetchOutput((m) => { if (job && m.id === job.id) appendLog(m.text); });
  api.onFetchDone(onDone);
  if (saved().open) layout.classList.add('fetch-open');
}
