// Sidebar tree: registered roots → lazy subfolders and image files.
// Folder click opens it in a gallery; file click drives the global selection
// (Preview + inspector); drag files onto folders/galleries to move them.
import {
  api, state, on, emit, saveSettings, normKey, keyUnder, samePath, remapUnder, galleries,
  setGlobalSelection, registerItemLookup,
} from './state.js';
import { el, toast, toastError, showContextMenu, confirmDialog, basename, dirname, extname } from './ui.js';
import {
  DRAG_TYPE, draggedPaths, moveInto, startPathsDrag, checkFileName, renameFileTo, renameFolderTo, splitName,
} from './ops.js';

const PAGE = 500;
const $ = (id) => document.getElementById(id);

const expanded = new Set();   // normKey(folder)
const cache = new Map();      // normKey(folder) → {path, dirs, files}
const shown = new Map();      // normKey(folder) → number of files rendered
let sel = new Set();          // selected file paths
let anchor = null;            // file path for shift ranges
let focusPath = null;         // focused row (file or folder path)
let rows = [];                // flattened visible rows
let rowEls = new Map();       // path → row element
let tree;
let ctx;
let renaming = false;

const BADGE_COLORS = {
  '.jpg': '#c98a5a', '.jpeg': '#c98a5a', '.png': '#6fa8dc', '.apng': '#5fb3b3', '.gif': '#b48ead',
  '.webp': '#8fbf7f', '.avif': '#d08770', '.svg': '#e0b44f', '.bmp': '#8a8f98', '.ico': '#a3a3c2',
};

function showFiles() {
  return state.settings.showFiles !== false;
}

export function initSidebar(context) {
  ctx = context;
  tree = $('tree');
  $('btn-add-folder').addEventListener('click', addFoldersDialog);
  const toggle = $('show-files');
  toggle.checked = showFiles();
  toggle.addEventListener('change', () => {
    saveSettings({ showFiles: toggle.checked });
    renderTree();
  });

  registerItemLookup((p) => {
    const c = cache.get(normKey(dirname(p)));
    return c ? c.files.find((f) => f.path === p) || null : null;
  });

  const sidebar = $('sidebar');
  // Explorer → register folders
  sidebar.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes(DRAG_TYPE)) return; // handled per row
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    sidebar.classList.add('drop-files');
  });
  sidebar.addEventListener('dragleave', (e) => {
    if (!sidebar.contains(e.relatedTarget)) sidebar.classList.remove('drop-files');
  });
  sidebar.addEventListener('drop', async (e) => {
    sidebar.classList.remove('drop-files');
    if (e.dataTransfer.types.includes(DRAG_TYPE)) return;
    if (!e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => api.getPathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    try {
      const r = await api.addRoots(paths);
      setRoots(r.roots);
      if (r.added.length) toast(`${r.added.length}件のフォルダを追加しました。`, 'success');
      if (r.rejected.length) toast(`${r.rejected.length}件はフォルダではないため追加できませんでした。`, 'error');
      if (!r.added.length && !r.rejected.length) toast('既に登録されているフォルダです。');
    } catch (err) {
      toastError(err);
    }
  });

  tree.addEventListener('click', onClick);
  tree.addEventListener('dblclick', onDblClick);
  tree.addEventListener('contextmenu', onContextMenu);
  tree.addEventListener('dragstart', onDragStart);
  tree.addEventListener('dragover', onDragOver);
  tree.addEventListener('dragleave', (e) => {
    const row = e.target.closest && e.target.closest('.tree-row');
    if (row && !row.contains(e.relatedTarget)) row.classList.remove('drop-target');
  });
  tree.addEventListener('drop', onDrop);

  on('refresh-requested', () => refreshTree());
  on('fs-changed', (dirs) => reloadDirs(dirs));
  on('paths-renamed', (renames) => afterPathsChanged(renames));
  on('paths-moved', ({ moved, dest }) => afterPathsChanged(moved, [dest]));
  on('folder-renamed', ({ from, to }) => afterFolderRenamed(from, to));
  on('roots-changed', () => renderTree());
  on('layout-changed', () => paint());
  on('active-pane-changed', () => paint());
  on('global-selection', (s) => {
    if (s.origin && s.origin.kind === 'tree') {
      sel = new Set(s.paths);
      if (s.primary) { focusPath = s.primary; anchor = anchor && sel.has(anchor) ? anchor : s.primary; }
    } else {
      sel = new Set();
    }
    paint();
    if (s.origin && s.origin.kind === 'tree' && s.primary) scrollToRow(s.primary);
  });
}

function setRoots(roots) {
  state.roots = roots;
  renderTree();
}

export async function addFoldersDialog() {
  try {
    const r = await api.addRootsDialog();
    setRoots(r.roots);
    if (r.added.length) {
      toast(`${r.added.length}件のフォルダを追加しました。`, 'success');
      ctx.openFolder(r.added[0]);
    } else if (r.rejected.length) {
      toast('フォルダを追加できませんでした。', 'error');
    }
  } catch (e) {
    toastError(e);
  }
}

export async function loadRoots() {
  state.roots = await api.listRoots();
  renderTree();
}

// ---------- data ----------
async function loadDir(p) {
  const key = normKey(p);
  try {
    const r = await api.listDir(p);
    cache.set(key, { path: p, dirs: r.dirs, files: r.files });
  } catch (e) {
    cache.set(key, { path: p, dirs: [], files: [] });
    toastError(e, 'フォルダを読み込めませんでした。');
  }
  return cache.get(key);
}

async function reloadDirs(dirs) {
  const keys = new Set(dirs.map((d) => normKey(d)));
  const todo = [...cache.values()].filter((c) => keys.has(normKey(c.path)));
  if (!todo.length) return;
  await Promise.all(todo.map((c) => loadDir(c.path)));
  renderTree();
}

async function afterPathsChanged(pairs, extraDirs = []) {
  const map = new Map(pairs.map((x) => [x.from, x.to]));
  if ([...sel].some((p) => map.has(p))) sel = new Set([...sel].map((p) => map.get(p) || p));
  if (focusPath && map.has(focusPath)) focusPath = map.get(focusPath);
  if (anchor && map.has(anchor)) anchor = map.get(anchor);
  const dirs = [...pairs.flatMap((x) => [dirname(x.from), dirname(x.to)]), ...extraDirs];
  await reloadDirs(dirs);
}

async function afterFolderRenamed(from, to) {
  const remapKey = (k) => {
    const n = remapUnder(k, normKey(from), normKey(to));
    return n ? normKey(n) : k;
  };
  for (const k of [...expanded]) {
    const n = remapKey(k);
    if (n !== k) { expanded.delete(k); expanded.add(n); }
  }
  for (const k of [...cache.keys()]) if (keyUnder(k, normKey(from))) cache.delete(k);
  sel = new Set([...sel].map((p) => remapUnder(p, from, to) || p));
  if (focusPath) focusPath = remapUnder(focusPath, from, to) || focusPath;
  await refreshTree();
}

/** Reload the listing of every expanded folder (top-down) and re-render. */
export async function refreshTree() {
  try {
    state.roots = await api.listRoots();
  } catch (e) {
    toastError(e);
  }
  const known = new Map(state.roots.map((r) => [normKey(r.path), r.path]));
  const keys = [...expanded].sort((a, b) => a.length - b.length);
  cache.clear();
  for (const k of keys) {
    const p = known.get(k);
    if (!p) { expanded.delete(k); continue; }
    const c = await loadDir(p);
    for (const d of c.dirs) known.set(normKey(d.path), d.path);
  }
  renderTree();
}

async function toggle(path, exists = true) {
  if (!exists) return;
  const key = normKey(path);
  if (expanded.has(key)) {
    expanded.delete(key);
  } else {
    if (!cache.has(key)) await loadDir(path);
    expanded.add(key);
  }
  renderTree();
}

async function expand(path) {
  const key = normKey(path);
  if (expanded.has(key)) return;
  if (!cache.has(key)) await loadDir(path);
  expanded.add(key);
  renderTree();
}

/** Expand ancestors so `p` (folder) becomes visible. */
export async function revealPath(p) {
  const target = normKey(p);
  const root = state.roots.find((r) => keyUnder(target, normKey(r.path)));
  if (!root || !root.exists) return;
  let cur = root.path;
  for (let guard = 0; guard < 64 && normKey(cur) !== target; guard++) {
    const key = normKey(cur);
    const c = cache.get(key) || await loadDir(cur);
    expanded.add(key);
    const next = c.dirs.find((d) => keyUnder(target, normKey(d.path)));
    if (!next) break;
    cur = next.path;
  }
  renderTree();
}

// ---------- rendering ----------
export function renderTree() {
  if (!tree) return;
  rows = [];
  rowEls = new Map();
  const frag = document.createDocumentFragment();
  frag.append(rowEl({ type: 'special', name: '全フォルダ（タグ付き画像）', depth: 0 }));
  frag.append(el('div', { class: 'tree-sep' }));
  if (!state.roots.length) frag.append(el('div', { class: 'tree-empty' }, 'フォルダが登録されていません。'));
  for (const r of state.roots) appendFolder(frag, { path: r.path, name: r.name, isRoot: true, exists: r.exists }, 0);
  tree.replaceChildren(frag);
  paint();
}

function appendFolder(frag, node, depth) {
  const key = normKey(node.path);
  const c = cache.get(key);
  const open = expanded.has(key) && !!c;
  let leaf = false;
  if (c) leaf = !c.dirs.length && (!showFiles() || !c.files.length);
  else if (!node.isRoot) leaf = !node.hasChildren && (!showFiles() || !node.hasFiles);
  const row = { type: 'folder', ...node, depth, open, leaf };
  rows.push(row);
  frag.append(rowEl(row));
  if (!open) return;
  for (const d of c.dirs) appendFolder(frag, { ...d, isRoot: false, exists: true }, depth + 1);
  if (!showFiles()) return;
  const limit = shown.get(key) || PAGE;
  for (const f of c.files.slice(0, limit)) {
    const fr = { type: 'file', path: f.path, name: f.name, ext: f.ext, depth: depth + 1, parent: node.path };
    rows.push(fr);
    frag.append(rowEl(fr));
  }
  if (c.files.length > limit) {
    const mr = { type: 'more', path: `${node.path}\u0000more`, parent: node.path, depth: depth + 1, rest: c.files.length - limit };
    rows.push(mr);
    frag.append(rowEl(mr));
  }
}

function rowEl(r) {
  const pad = { paddingLeft: `${6 + r.depth * 14}px` };
  if (r.type === 'special') {
    return el('div', { class: 'tree-row special', style: pad, dataset: { type: 'special' }, title: '登録フォルダ内でタグが付いた画像をすべて表示' },
      el('span', { class: 'tree-caret leaf' }, ''), el('span', { class: 'tree-icon' }, '◆'), el('span', { class: 'tree-label' }, r.name));
  }
  if (r.type === 'more') {
    const e = el('div', { class: 'tree-row more', style: pad, dataset: { type: 'more', parent: r.parent } },
      el('span', { class: 'tree-caret leaf' }, ''), el('span', { class: 'tree-label' }, `さらに表示（残り${r.rest}件）`));
    rowEls.set(r.path, e);
    return e;
  }
  if (r.type === 'file') {
    const ext = (r.ext || extname(r.name)).toLowerCase();
    const e = el('div', {
      class: 'tree-row file', style: pad, draggable: 'true', title: r.path,
      dataset: { type: 'file', path: r.path, parent: r.parent },
    },
    el('span', { class: 'tree-caret leaf' }, ''),
    el('span', { class: 'ext-badge', style: { '--badge': BADGE_COLORS[ext] || '#888' } }, ext.slice(1).toUpperCase()),
    el('span', { class: 'tree-label' }, r.name));
    rowEls.set(r.path, e);
    return e;
  }
  const e = el('div', {
    class: `tree-row folder${r.exists === false ? ' missing' : ''}`,
    style: pad, title: r.path,
    dataset: { type: 'folder', path: r.path, root: r.isRoot ? '1' : '', exists: r.exists === false ? '0' : '1' },
  },
  el('span', { class: `tree-caret${r.leaf ? ' leaf' : ''}` }, r.open ? '▼' : '▶'),
  el('span', { class: 'tree-icon' }, r.isRoot ? '▣' : '▢'),
  el('span', { class: 'tree-label' }, r.name + (r.exists === false ? '（見つかりません）' : '')));
  rowEls.set(r.path, e);
  return e;
}

function paint() {
  if (!tree) return;
  const s = ctx && ctx.model ? ctx.activePane() : null;
  const cur = s && s.kind === 'gallery' && s.source ? s.source : null;
  for (const [p, e] of rowEls) {
    const type = e.dataset.type;
    e.classList.toggle('selected', type === 'file' ? sel.has(p) : false);
    e.classList.toggle('current', type === 'folder' && !!cur && cur.kind === 'folder' && samePath(cur.path, p));
    e.classList.toggle('focused', focusPath != null && p === focusPath);
  }
  const special = tree.querySelector('.tree-row.special');
  if (special) special.classList.toggle('current', !!cur && cur.kind === 'tagged');
}

export function paintCurrent() {
  paint();
}

function scrollToRow(p) {
  const e = rowEls.get(p);
  if (e) e.scrollIntoView({ block: 'nearest' });
}

// ---------- selection ----------
function rowAt(target) {
  return target && target.closest ? target.closest('.tree-row') : null;
}

function filesOf(parent) {
  const c = cache.get(normKey(parent));
  return c ? c.files : [];
}

/** Select tree files and publish them as the global selection. */
export function selectFiles(paths, primary, { parent } = {}) {
  sel = new Set(paths);
  focusPath = primary;
  const dir = parent || dirname(primary);
  setGlobalSelection({ paths, primary, origin: { kind: 'tree', dir, list: filesOf(dir) } });
  // mirror into galleries that show these files
  for (const g of galleries.values()) {
    const present = paths.filter((p) => g.itemsByPath.has(p));
    if (present.length) g.selectPaths(present, { emit: false, scroll: true });
  }
}

function fileRows() {
  return rows.filter((r) => r.type === 'file');
}

function clickFile(path, parent, e) {
  let next;
  if (e.shiftKey && anchor) {
    const fr = fileRows();
    const a = fr.findIndex((r) => r.path === anchor);
    const b = fr.findIndex((r) => r.path === path);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      next = fr.slice(lo, hi + 1).map((r) => r.path);
      if (e.ctrlKey) next = [...new Set([...sel, ...next])];
    }
  }
  if (!next && (e.ctrlKey || e.metaKey)) {
    const s = new Set(sel);
    if (s.has(path)) s.delete(path); else s.add(path);
    next = [...s];
    anchor = path;
  }
  if (!next) {
    next = [path];
    anchor = path;
  }
  const order = new Map(fileRows().map((r, i) => [r.path, i]));
  next.sort((x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0));
  const primary = next.includes(path) ? path : next[next.length - 1];
  if (primary) selectFiles(next, primary, { parent });
  else { sel = new Set(); paint(); }
}

function onClick(e) {
  const row = rowAt(e.target);
  if (!row || renaming) return;
  tree.focus({ preventScroll: true });
  const type = row.dataset.type;
  if (type === 'special') { ctx.openTagged(); return; }
  if (type === 'more') {
    const k = normKey(row.dataset.parent);
    shown.set(k, (shown.get(k) || PAGE) + PAGE);
    renderTree();
    return;
  }
  if (type === 'file') { clickFile(row.dataset.path, row.dataset.parent, e); return; }
  const path = row.dataset.path;
  focusPath = path;
  if (e.target.closest('.tree-caret')) { toggle(path, row.dataset.exists !== '0'); return; }
  if (row.dataset.exists === '0') { toast('フォルダが見つかりません。移動または削除された可能性があります。', 'error'); return; }
  ctx.openFolder(path, { newTab: e.ctrlKey || e.metaKey }).then(() => paint());
}

function onDblClick(e) {
  const row = rowAt(e.target);
  if (!row || renaming) return;
  if (row.dataset.type === 'file') {
    const parent = row.dataset.parent;
    ctx.openImage(row.dataset.path, { list: filesOf(parent) });
  } else if (row.dataset.type === 'folder' && !e.target.closest('.tree-caret')) {
    toggle(row.dataset.path, row.dataset.exists !== '0');
  }
}

// ---------- context menu ----------
function onContextMenu(e) {
  const row = rowAt(e.target);
  if (!row) return;
  e.preventDefault();
  const type = row.dataset.type;
  const path = row.dataset.path;
  if (type === 'file') {
    if (!sel.has(path)) clickFile(path, row.dataset.parent, {});
    const paths = [...sel];
    showContextMenu(e.clientX, e.clientY, [
      { label: '名前の変更', disabled: paths.length > 1, action: () => startRename(path) },
      { label: '新しいタブで開く', action: () => ctx.openImage(path, { list: filesOf(row.dataset.parent) }) },
      { separator: true },
      { label: 'エクスプローラーで表示', action: () => api.showItem(path) },
      {
        label: paths.length > 1 ? `パスをコピー（${paths.length}件）` : 'パスをコピー',
        action: async () => { await api.copyText(paths.join('\r\n')); toast('パスをコピーしました。', 'success', 1800); },
      },
    ]);
    return;
  }
  if (type !== 'folder') return;
  const exists = row.dataset.exists !== '0';
  const items = [];
  if (exists) {
    items.push({ label: '新しいギャラリータブで開く', action: () => ctx.openFolder(path, { newTab: true }) });
    items.push({ label: '名前の変更', action: () => startRename(path) });
    items.push({ label: 'エクスプローラーで表示', action: () => api.openPath(path) });
  }
  if (row.dataset.root === '1') {
    if (items.length) items.push({ separator: true });
    items.push({ label: '一覧から外す', action: () => removeRoot(path) });
  }
  showContextMenu(e.clientX, e.clientY, items);
}

async function removeRoot(path) {
  const ok = await confirmDialog(`「${basename(path)}」を一覧から外します。\nディスク上のフォルダやファイルは変更されません。`, { okLabel: '一覧から外す' });
  if (!ok) return;
  try {
    state.roots = await api.removeRoot(path);
    const key = normKey(path);
    for (const k of [...expanded]) if (keyUnder(k, key)) expanded.delete(k);
    for (const k of [...cache.keys()]) if (keyUnder(k, key)) cache.delete(k);
    renderTree();
    emit('roots-changed', state.roots);
    toast('一覧から外しました。');
  } catch (err) {
    toastError(err);
  }
}

// ---------- inline rename ----------
export function startRename(path) {
  const row = rowEls.get(path);
  if (!row || renaming) return;
  const isFile = row.dataset.type === 'file';
  const label = row.querySelector('.tree-label');
  const name = basename(path);
  const input = el('input', { class: 'input tree-input', value: name, spellcheck: 'false' });
  label.replaceChildren(input);
  row.draggable = false;
  renaming = true;
  input.focus();
  input.setSelectionRange(0, isFile ? splitName(name) : name.length);
  let finished = false;
  const done = () => {
    renaming = false;
    tree.focus({ preventScroll: true });
  };
  const finish = async (commit) => {
    if (finished) return;
    finished = true;
    const v = input.value;
    if (!commit || v === name) {
      label.textContent = name;
      row.draggable = isFile;
      done();
      return;
    }
    if (isFile) {
      const err = await checkFileName(name, v);
      if (err) { toast(err, 'error'); finished = false; input.focus(); return; }
      done();
      const to = await renameFileTo(path, v);
      if (to) { focusPath = to; } else { label.textContent = name; }
    } else {
      done();
      const r = await renameFolderTo(path, v);
      if (r) focusPath = r.to; else label.textContent = name;
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => { if (!finished) finish(true); });
  for (const t of ['mousedown', 'click', 'dblclick']) input.addEventListener(t, (e) => e.stopPropagation());
}

// ---------- drag & drop ----------
function onDragStart(e) {
  const row = rowAt(e.target);
  if (!row || row.dataset.type !== 'file' || renaming) { e.preventDefault(); return; }
  const p = row.dataset.path;
  if (!sel.has(p)) clickFile(p, row.dataset.parent, {});
  startPathsDrag(e, [...sel], 'tree');
}

function onDragOver(e) {
  const row = rowAt(e.target);
  if (!row || row.dataset.type !== 'folder' || row.dataset.exists === '0') return;
  if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  row.classList.add('drop-target');
}

async function onDrop(e) {
  const row = rowAt(e.target);
  if (row) row.classList.remove('drop-target');
  if (!row || row.dataset.type !== 'folder') return;
  const paths = draggedPaths(e);
  if (!paths) return;
  e.preventDefault();
  e.stopPropagation();
  if (paths.length) await moveInto(paths, row.dataset.path);
}

// ---------- keyboard ----------
export function hasFocus() {
  return !!tree && tree.contains(document.activeElement);
}

function navRows() {
  return rows.filter((r) => r.type === 'folder' || r.type === 'file' || r.type === 'more');
}

export function handleKey(e) {
  if (renaming) return false;
  const list = navRows();
  if (!list.length) return false;
  let i = list.findIndex((r) => r.path === focusPath);
  const cur = list[i];
  const focusRow = (r, extend = false) => {
    focusPath = r.path;
    if (r.type === 'file') {
      if (extend) clickFile(r.path, r.parent, { shiftKey: true });
      else clickFile(r.path, r.parent, {});
    } else {
      paint();
    }
    scrollToRow(r.path);
  };
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      focusRow(list[Math.min(list.length - 1, i + 1)], e.shiftKey);
      return true;
    case 'ArrowUp':
      e.preventDefault();
      focusRow(list[Math.max(0, i < 0 ? 0 : i - 1)], e.shiftKey);
      return true;
    case 'Home': e.preventDefault(); focusRow(list[0]); return true;
    case 'End': e.preventDefault(); focusRow(list[list.length - 1]); return true;
    case 'ArrowRight':
      e.preventDefault();
      if (cur && cur.type === 'folder') {
        if (!cur.open && !cur.leaf) expand(cur.path);
        else if (cur.open && list[i + 1] && list[i + 1].depth > cur.depth) focusRow(list[i + 1]);
      }
      return true;
    case 'ArrowLeft': {
      e.preventDefault();
      if (!cur) return true;
      if (cur.type === 'folder' && cur.open) { toggle(cur.path); return true; }
      for (let k = i - 1; k >= 0; k--) {
        if (list[k].type === 'folder' && list[k].depth < cur.depth) { focusRow(list[k]); break; }
      }
      return true;
    }
    case 'Enter':
      e.preventDefault();
      if (!cur) return true;
      if (cur.type === 'file') ctx.openImage(cur.path, { list: filesOf(cur.parent) });
      else if (cur.type === 'folder') ctx.openFolder(cur.path).then(() => paint());
      else if (cur.type === 'more') {
        const k = normKey(cur.parent);
        shown.set(k, (shown.get(k) || PAGE) + PAGE);
        renderTree();
      }
      return true;
    case 'F2':
      e.preventDefault();
      if (cur && (cur.type === 'file' || cur.type === 'folder') && cur.exists !== false) startRename(cur.path);
      return true;
    default:
      return false;
  }
}

// ---------- testing hooks ----------
export function visibleFileRows() {
  return fileRows().map((r) => ({ path: r.path, name: r.name, label: rowEls.get(r.path)?.querySelector('.tree-label')?.textContent }));
}
export { expand as expandFolder, clickFile as clickTreeFile };
