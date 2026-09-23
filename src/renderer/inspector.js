// Right-hand inspector: preview, metadata and tags for the global selection.
// The DOM is built once per mode and updated in place (no rebuild on every
// selection); the preview image is swapped only after the next thumbnail has
// been decoded offscreen, so it never blinks.
import { api, state, on, lookupItem } from './state.js';
import { el, toast, toastError, formatBytes, formatDate, thumbUrl, fileUrl, basename } from './ui.js';
import { tagChip, createTagInput, addTagsToPaths, removeTagsFromPaths, sortedTags } from './tags.js';

const $ = (id) => document.getElementById(id);
let panel;
let token = 0;
let ctx = null;
let mode = null;          // 'empty' | 'single' | 'multi' | 'error'
let current = [];         // paths currently shown
let single = null;        // persistent single-selection elements
let multi = null;
let tagsSection = null;   // persistent tag section
let dimsToken = 0;
const statCache = new Map();
const dimsCache = new Map(); // path|mtime → "w × h px"

export function initInspector(context) {
  ctx = context;
  panel = $('inspector');
  on('global-selection', render);
  on('lib-changed', render);
  on('image-tags-changed', (map) => {
    if (state.selection.paths.some((p) => map && p in map)) render();
  });
  on('paths-renamed', (renames) => renames.forEach((r) => statCache.delete(r.from)));
  render();
}

async function itemFor(p) {
  const known = lookupItem(p);
  if (known && known.size != null) return known;
  if (statCache.has(p)) return statCache.get(p);
  const st = await api.stat(p);
  statCache.set(p, st);
  if (statCache.size > 200) statCache.delete(statCache.keys().next().value);
  return st;
}

async function tagsFor(paths) {
  const out = {};
  const missing = [];
  for (const p of paths) {
    const it = lookupItem(p);
    if (it && it.tags) out[p] = it.tags;
    else missing.push(p);
  }
  if (missing.length) Object.assign(out, await api.getImageTags(missing));
  return out;
}

// ---------- persistent structure ----------
function setMode(m, head) {
  if (mode === m) return;
  mode = m;
  if (!tagsSection) buildTags();
  if (m === 'empty' || m === 'error') panel.replaceChildren(head);
  else panel.replaceChildren(head, tagsSection.root);
}

function buildSingle() {
  const img = el('img', { alt: '', draggable: 'false' });
  const preview = el('div', { class: 'insp-preview', title: 'ダブルクリックで開く' }, img);
  preview.addEventListener('dblclick', () => { if (single.path) ctx && ctx.openImage(single.path, {}); });
  const td = () => el('td');
  const dims = td();
  const size = td();
  const mtime = td();
  const pathEl = td();
  const name = el('div', { class: 'insp-name' });
  const root = el('div', {},
    preview, name,
    el('table', { class: 'insp-table' },
      el('tr', {}, el('th', {}, '寸法'), dims),
      el('tr', {}, el('th', {}, 'サイズ'), size),
      el('tr', {}, el('th', {}, '更新日時'), mtime),
      el('tr', {}, el('th', {}, 'パス'), pathEl)),
    el('div', { class: 'insp-actions' },
      el('button', { class: 'btn small', onclick: () => single.path && ctx && ctx.openImage(single.path, {}) }, '表示'),
      el('button', { class: 'btn small', onclick: () => single.path && api.showItem(single.path).catch(toastError) }, 'エクスプローラーで表示'),
      el('button', {
        class: 'btn small',
        onclick: () => single.path && api.copyText(single.path).then(() => toast('パスをコピーしました。', 'success', 1800)).catch(toastError),
      }, 'パスをコピー')));
  single = { root, img, preview, name, dims, size, mtime, pathEl, path: null, url: null, swapToken: 0 };
}

function buildMulti() {
  const name = el('div', { class: 'insp-name' });
  const total = el('td');
  const first = el('td');
  const root = el('div', {}, name, el('table', { class: 'insp-table' },
    el('tr', {}, el('th', {}, '合計サイズ'), total),
    el('tr', {}, el('th', {}, '先頭'), first)));
  multi = { root, name, total, first };
}

function buildTags() {
  const title = el('h3');
  const chips = el('div', { class: 'chips insp-tags' });
  const input = createTagInput({
    onPick: (id) => apply(() => addTagsToPaths(current, [id]), true),
    exclude: () => tagsSection.fullTags,
  });
  const root = el('div', { class: 'insp-section' }, title, chips, input.element);
  tagsSection = { root, title, chips, input, fullTags: new Set() };
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

/** Swap the preview only after the new thumbnail is decoded offscreen. */
function swapPreview(url) {
  if (single.url === url) return;
  single.url = url;
  const my = ++single.swapToken;
  const probe = new Image();
  probe.decoding = 'async';
  probe.src = url;
  probe.decode().then(() => {
    if (my === single.swapToken) single.img.src = url;
  }, () => {
    if (my === single.swapToken) single.img.removeAttribute('src');
  });
}

function loadDims(it) {
  const key = `${it.path}|${it.mtime || 0}`;
  if (dimsCache.has(key)) { setText(single.dims, dimsCache.get(key)); return; }
  setText(single.dims, '…');
  const my = ++dimsToken;
  const probe = new Image();
  probe.onload = () => {
    const v = probe.naturalWidth ? `${probe.naturalWidth} × ${probe.naturalHeight} px` : '—';
    dimsCache.set(key, v);
    if (dimsCache.size > 500) dimsCache.delete(dimsCache.keys().next().value);
    if (my === dimsToken) setText(single.dims, v);
  };
  probe.onerror = () => { if (my === dimsToken) setText(single.dims, '—'); };
  probe.src = fileUrl(it);
}

// ---------- render ----------
async function render() {
  const my = ++token;
  const paths = [...state.selection.paths];
  if (!paths.length) {
    current = [];
    setMode('empty', el('div', { class: 'insp-empty' }, '画像を選択すると', el('br'), '詳細とタグが表示されます。'));
    return;
  }
  let items;
  let tagMap;
  try {
    items = await Promise.all(paths.slice(0, 2000).map((p) => itemFor(p).catch(() => null)));
    tagMap = await tagsFor(paths);
  } catch {
    if (my === token) {
      mode = null;
      setMode('error', el('div', { class: 'insp-empty' }, '情報を取得できませんでした。'));
    }
    return;
  }
  if (my !== token) return;
  const valid = items.filter(Boolean);
  current = paths;

  if (paths.length === 1) {
    const it = valid[0];
    if (!it) {
      mode = null;
      setMode('error', el('div', { class: 'insp-empty' }, 'ファイルが見つかりません。'));
      return;
    }
    if (!single) buildSingle();
    setMode('single', single.root);
    const changed = single.path !== it.path;
    single.path = it.path;
    swapPreview(thumbUrl(it));
    setText(single.name, it.name);
    setText(single.size, formatBytes(it.size));
    setText(single.mtime, formatDate(it.mtime));
    setText(single.pathEl, it.path);
    if (changed || single.dims.textContent === '') loadDims(it);
  } else {
    if (!multi) buildMulti();
    setMode('multi', multi.root);
    setText(multi.name, `${paths.length}枚の画像を選択中`);
    setText(multi.total, formatBytes(valid.reduce((s, x) => s + (x.size || 0), 0)));
    setText(multi.first, basename(paths[0]));
  }
  renderTags(paths, tagMap);
}

function renderTags(paths, tagMap) {
  const counts = new Map();
  for (const p of paths) for (const id of tagMap[p] || []) counts.set(id, (counts.get(id) || 0) + 1);
  const present = sortedTags(state.lib.tags.filter((t) => counts.has(t.id)));
  tagsSection.fullTags = new Set(present.filter((t) => counts.get(t.id) === paths.length).map((t) => t.id));
  setText(tagsSection.title, paths.length > 1 ? `タグ（${paths.length}枚に適用）` : 'タグ');
  const chips = present.map((t) => {
    const n = counts.get(t.id);
    const partial = n < paths.length;
    return tagChip(t, {
      partial,
      title: partial ? `${paths.length}枚中${n}枚に付いています（クリックで全てに追加）` : undefined,
      onClick: partial ? () => apply(() => addTagsToPaths(paths, [t.id])) : undefined,
      onRemove: () => apply(() => removeTagsFromPaths(paths, [t.id])),
    });
  });
  if (!chips.length) chips.push(el('span', { class: 'muted small' }, 'タグはありません'));
  tagsSection.chips.replaceChildren(...chips);
  tagsSection.input.refreshTypes();
}

async function apply(fn, refocus = false) {
  try {
    await fn();
    if (refocus) requestAnimationFrame(() => tagsSection.input.focus());
  } catch (e) {
    toastError(e, 'タグを更新できませんでした。');
  }
}

/** For the smoke test: the persistent preview <img> (null outside single mode). */
export function inspectorPreviewImg() {
  return mode === 'single' && single ? single.img : null;
}
