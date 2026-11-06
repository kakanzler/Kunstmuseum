// 画像取得サイドバー (Ctrl+]): a form for `uv run fotoget <url> --genre --title …`
// run in the fotoget project folder. 一覧モード (type "list" at the start of the
// URL field, or pick it in the pulldown) runs `fotoget-list --pages …` instead,
// which follows every post of a paginated listing and titles each by its h1. The main process spawns the job; its
// output streams into the log below the form. One job at a time.
import { api, state, saveSettings } from './state.js';
import { el, toast, toastError } from './ui.js';
import { keyLabel } from './commands.js';

const MAX_LOG_LINES = 600;
const MAX_HISTORY = 30;
const NEW_GENRE = '__new_genre__'; // pulldown entry that reveals the text field
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
// "list" / "page" typed at the start of the URL field switches the mode
const MODE_PREFIX = /^\s*(list|page)(?=\s|$|https?:)\s*/i;

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
      mode: f.mode.value,
      pages: f.pages.value.trim(),
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

// ---------- ジャンル pulldown ----------
let genreNames = [];
let genreToken = 0;

/** Re-read the choices (save folder's subfolders + history) and re-fill the pulldown. */
async function refreshGenres() {
  const my = ++genreToken;
  const s = saved();
  let names = s.genres || [];
  try { names = await api.fetchGenres(f.out.value.trim(), s.genres || [], s.authors || []); } catch { /* history only */ }
  if (my !== genreToken) return;
  genreNames = names;
  const opt = (value, label) => el('option', { value }, label);
  f.genreSelect.replaceChildren(
    opt('', names.length ? '（ジャンルを選択）' : '（保存先にフォルダがありません）'),
    ...names.map((n) => opt(n, n)),
    opt(NEW_GENRE, '＋ 新しいジャンルを入力…'),
  );
  syncGenreSelect();
}

/** Pulldown shows the current genre; an unlisted genre is edited in the text field. */
function syncGenreSelect() {
  const v = f.genre.value.trim();
  const listed = !v || genreNames.includes(v);
  f.genreSelect.value = listed ? v : NEW_GENRE;
  f.genreRow.hidden = listed;
}

function onGenrePicked() {
  const v = f.genreSelect.value;
  if (v === NEW_GENRE) {
    f.genre.value = '';
    f.genreRow.hidden = false;
    f.genre.focus();
  } else {
    f.genre.value = v;
    f.genreRow.hidden = true;
  }
  previewCommand();
  persist();
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

// ---------- mode ----------
const isList = () => f.mode.value === 'list';

function setMode(mode) {
  f.mode.value = mode === 'list' ? 'list' : 'page';
  f.titleRow.hidden = isList();
  f.pagesRow.hidden = !isList();
  f.run.textContent = isList() ? '一覧を実行' : '実行';
  panel.classList.toggle('list-mode', isList());
  previewCommand();
}

/** "list https://…" in the URL field → 一覧モード, the prefix itself is removed. */
function onUrlInput() {
  const m = f.url.value.match(MODE_PREFIX);
  if (m) {
    f.url.value = f.url.value.slice(m[0].length);
    setMode(m[1].toLowerCase());
    persist();
    setStatus(isList() ? '一覧モード: 一覧ページのURLとページ範囲を入れてください。' : '1ページモード');
  }
  previewCommand();
}

// ---------- form ----------
function formValues() {
  return {
    mode: f.mode.value,
    pages: f.pages.value.trim(),
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
  const parts = v.mode === 'list'
    ? ['uv run fotoget-list', q(v.url || '{url}'), '--pages', q(v.pages || '1'), '--genre', q(v.genre || '{genre}')]
    : ['uv run fotoget', q(v.url || '{url}'), '--genre', q(v.genre || '{genre}'), '--title', q(v.title || '{title}')];
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
  job = { id: res.id, title: v.mode === 'list' ? `一覧 ${v.pages || '1'} ページ` : v.title };
  logLines = [];
  partial = '';
  appendLog(`> ${res.command}\n  (${res.cwd})\n`);
  setRunning(true);
  setStatus('取得中…', 'busy');
  const s = saved();
  persist({ genres: remember(s.genres, v.genre), authors: remember(s.authors, v.author) });
  fillDatalist(f.genreList, saved().genres);
  fillDatalist(f.authorList, saved().authors);
  refreshGenres();
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
    previewCommand(); // mode and page range stay for the next listing
    refreshGenres(); // a new genre folder may have been created
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
    url: input('fetch-url', { placeholder: 'https://…（先頭に list で一覧モード）', type: 'url' }),
    mode: el('select', { class: 'input fetch-mode', title: '1ページ: そのページの画像 / 一覧: 一覧ページの各記事（URL 欄に list と入れても切替）' },
      el('option', { value: 'page' }, '1ページ（fotoget）'),
      el('option', { value: 'list' }, '一覧の各記事（fotoget-list）')),
    pages: input('fetch-pages', { placeholder: '1-248 / 1-3,7' }),
    title: input('fetch-title', { placeholder: '保存フォルダ名' }),
    genre: input('fetch-genre', { list: 'fetch-genres', placeholder: '新しいジャンル（フォルダ名）' }),
    genreSelect: el('select', { class: 'input fetch-genre-select', title: '保存先にあるフォルダと、これまでに使ったジャンル' }),
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
  f.pages.value = s.pages || '1';
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

  for (const k of ['url', 'title', 'pages', 'genre', 'author', 'minSize', 'out', 'cwd']) {
    f[k].addEventListener('input', k === 'url' ? onUrlInput : previewCommand);
    f[k].addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); run(); }
    });
  }
  for (const k of ['pages', 'genre', 'author', 'minSize', 'out', 'cwd']) f[k].addEventListener('change', () => persist());
  f.mode.addEventListener('change', () => { setMode(f.mode.value); persist(); });
  f.numbered.addEventListener('change', () => { previewCommand(); persist(); });
  f.genreSelect.addEventListener('change', onGenrePicked);
  f.out.addEventListener('change', refreshGenres);
  f.genreRow = field('', f.genre);
  f.genreRow.classList.add('fetch-genre-new');

  panel.replaceChildren(
    el('div', { class: 'fetch-head' }, el('h3', {}, '画像取得（fotoget）'), close),
    el('div', { class: 'fetch-form' },
      field('モード', f.mode),
      field('URL', f.url),
      f.titleRow = field('タイトル', f.title),
      f.pagesRow = field('ページ', f.pages, el('span', { class: 'muted small' }, '一覧')),
      field('ジャンル', f.genreSelect),
      f.genreRow,
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
  setMode(s.mode);
  syncGenreSelect();
  refreshGenres();
}

/** Show / hide the right sidebar (no argument: toggle). */
export function toggleFetchPanel(force) {
  if (!panel) return;
  const open = force === undefined ? !isFetchOpen() : !!force;
  layout.classList.toggle('fetch-open', open);
  persist();
  if (open) refreshGenres();
  if (open) requestAnimationFrame(() => (f.url.value && !isList() ? f.title : f.url).focus());
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
