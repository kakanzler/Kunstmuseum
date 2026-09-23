// Right-hand inspector: preview, metadata and tags for the current selection.
import { api, state, on, tagById, lookupItem } from './state.js';
import { el, toast, toastError, formatBytes, formatDate, thumbUrl, basename } from './ui.js';
import { tagChip, createTagInput, addTagsToPaths, removeTagsFromPaths, sortedTags } from './tags.js';

const $ = (id) => document.getElementById(id);
let panel;
let token = 0;
let ctx = null;
const statCache = new Map();

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

async function render() {
  const my = ++token;
  const paths = state.selection.paths;
  if (!paths.length) {
    panel.replaceChildren(el('div', { class: 'insp-empty' }, '画像を選択すると', el('br'), '詳細とタグが表示されます。'));
    return;
  }
  let items;
  let tagMap;
  try {
    items = await Promise.all(paths.slice(0, 2000).map((p) => itemFor(p).catch(() => null)));
    tagMap = await tagsFor(paths);
  } catch (e) {
    if (my === token) panel.replaceChildren(el('div', { class: 'insp-empty' }, '情報を取得できませんでした。'));
    return;
  }
  if (my !== token) return;
  const valid = items.filter(Boolean);
  const frag = document.createDocumentFragment();

  if (paths.length === 1) {
    const it = valid[0];
    if (!it) {
      panel.replaceChildren(el('div', { class: 'insp-empty' }, 'ファイルが見つかりません。'));
      return;
    }
    const pimg = el('img', { src: thumbUrl(it), alt: '' });
    const preview = el('div', { class: 'insp-preview', title: 'ダブルクリックで表示' }, pimg);
    preview.addEventListener('dblclick', () => openFromInspector(it));
    const dims = el('td', {}, '…');
    const probe = new Image();
    probe.onload = () => { dims.textContent = probe.naturalWidth ? `${probe.naturalWidth} × ${probe.naturalHeight} px` : '—'; };
    probe.onerror = () => { dims.textContent = '—'; };
    probe.src = `kmimg://file/${encodeURIComponent(it.path)}?v=${Math.round(it.mtime || 0)}`;
    frag.append(
      preview,
      el('div', { class: 'insp-name' }, it.name),
      el('table', { class: 'insp-table' },
        el('tr', {}, el('th', {}, '寸法'), dims),
        el('tr', {}, el('th', {}, 'サイズ'), el('td', {}, formatBytes(it.size))),
        el('tr', {}, el('th', {}, '更新日時'), el('td', {}, formatDate(it.mtime))),
        el('tr', {}, el('th', {}, 'パス'), el('td', {}, it.path))),
      el('div', { class: 'insp-actions' },
        el('button', { class: 'btn small', onclick: () => openFromInspector(it) }, '表示'),
        el('button', { class: 'btn small', onclick: () => api.showItem(it.path).catch(toastError) }, 'エクスプローラーで表示'),
        el('button', {
          class: 'btn small',
          onclick: () => api.copyText(it.path).then(() => toast('パスをコピーしました。', 'success', 1800)).catch(toastError),
        }, 'パスをコピー')),
    );
  } else {
    const total = valid.reduce((s, it) => s + (it.size || 0), 0);
    frag.append(
      el('div', { class: 'insp-name' }, `${paths.length}枚の画像を選択中`),
      el('table', { class: 'insp-table' },
        el('tr', {}, el('th', {}, '合計サイズ'), el('td', {}, formatBytes(total))),
        el('tr', {}, el('th', {}, '先頭'), el('td', {}, basename(paths[0])))),
    );
  }

  // tags
  const counts = new Map();
  for (const p of paths) for (const id of tagMap[p] || []) counts.set(id, (counts.get(id) || 0) + 1);
  const present = sortedTags(state.lib.tags.filter((t) => counts.has(t.id)));
  const chips = el('div', { class: 'chips insp-tags' });
  for (const t of present) {
    const n = counts.get(t.id);
    const partial = n < paths.length;
    chips.append(tagChip(t, {
      partial,
      title: partial ? `${paths.length}枚中${n}枚に付いています（クリックで全てに追加）` : undefined,
      onClick: partial ? () => apply(() => addTagsToPaths(paths, [t.id])) : undefined,
      onRemove: () => apply(() => removeTagsFromPaths(paths, [t.id])),
    }));
  }
  if (!present.length) chips.append(el('span', { class: 'muted small' }, 'タグはありません'));
  const input = createTagInput({
    onPick: (id) => apply(() => addTagsToPaths(paths, [id]), true),
    exclude: () => new Set(present.filter((t) => counts.get(t.id) === paths.length).map((t) => t.id)),
  });
  frag.append(el('div', { class: 'insp-section' },
    el('h3', {}, paths.length > 1 ? `タグ（${paths.length}枚に適用）` : 'タグ'),
    chips,
    input.element));

  panel.replaceChildren(frag);
}

async function apply(fn, refocus = false) {
  try {
    await fn();
    if (refocus) requestAnimationFrame(() => {
      const inp = panel.querySelector('.tag-input-row .input');
      if (inp) inp.focus();
    });
  } catch (e) {
    toastError(e, 'タグを更新できませんでした。');
  }
}

function openFromInspector(it) {
  if (ctx) ctx.openImage(it.path, {});
}

export function inspectorTagCount() {
  return panel ? panel.querySelectorAll('.insp-tags .chip').length : 0;
}

export { tagById };
