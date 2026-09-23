// File operations shared by galleries, tree and image tabs. Every successful
// operation is broadcast so all views (galleries, tabs, Preview, tree,
// inspector) can follow the new paths.
import { api, state, emit, setGlobalSelection, samePath, remapUnder } from './state.js';
import { toast, toastError, confirmDialog, promptDialog, validateName, basename, extname } from './ui.js';

export const DRAG_TYPE = 'application/x-kunstmuseum-paths';
/** marker type carrying the drag source (pane id or "tree") in its name */
export const DRAG_SRC_PREFIX = 'application/x-km-src-';

/** Index of the extension dot (for preselecting the basename). */
export function splitName(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? i : name.length;
}

/** Validates a new file name; asks before an extension change. Returns error text or null. */
export async function checkFileName(oldName, newName) {
  const err = validateName(newName);
  if (err) return err;
  const exts = state.info.exts || [];
  const newExt = extname(newName);
  if (!exts.includes(newExt)) return `拡張子は対応形式のままにしてください（${exts.join(' ')}）。`;
  if (newExt !== extname(oldName)) {
    const ok = await confirmDialog(`拡張子を「${extname(oldName)}」から「${newExt}」に変更します。\nファイルの形式は変換されません。よろしいですか？`, { okLabel: '変更する' });
    if (!ok) return '拡張子の変更を取り消しました。';
  }
  return null;
}

function remapSelection(mapFn) {
  const s = state.selection;
  if (!s.paths.length) return;
  let changed = false;
  const paths = s.paths.map((p) => {
    const n = mapFn(p);
    if (n && n !== p) { changed = true; return n; }
    return p;
  });
  if (!changed) return;
  const primary = s.primary ? (mapFn(s.primary) || s.primary) : null;
  let origin = s.origin;
  if (origin && origin.list) {
    origin = { ...origin, list: origin.list.map((it) => {
      const n = mapFn(it.path);
      return n ? { ...it, path: n, name: basename(n) } : it;
    }) };
  }
  setGlobalSelection({ paths, primary, origin });
}

/** Rename one file. Returns the new path, or null on failure (toast shown). */
export async function renameFileTo(path, newName) {
  if (newName === basename(path)) return path;
  try {
    const r = await api.renameFile(path, newName);
    const renames = [{ from: r.from, to: r.to }];
    remapSelection((p) => (samePath(p, r.from) ? r.to : null));
    emit('paths-renamed', renames);
    return r.to;
  } catch (e) {
    toastError(e, '名前を変更できませんでした。');
    return null;
  }
}

/** Modal rename (viewer tabs, fallbacks). */
export async function renameFileWithDialog(path) {
  const name = basename(path);
  const next = await promptDialog({
    title: '名前の変更',
    value: name,
    selectEnd: splitName(name),
    validate: (v) => (v === name ? null : checkFileName(name, v)),
    okLabel: '変更',
  });
  if (next == null || next === name) return null;
  return renameFileTo(path, next);
}

/** Rename a folder. Returns the result or null. */
export async function renameFolderTo(path, newName) {
  if (newName === basename(path)) return null;
  const err = validateName(newName);
  if (err) { toast(err, 'error'); return null; }
  try {
    const r = await api.renameDir(path, newName);
    state.roots = r.roots;
    remapSelection((p) => remapUnder(p, r.from, r.to));
    emit('folder-renamed', { from: r.from, to: r.to });
    emit('roots-changed', r.roots);
    toast(`「${basename(r.from)}」を「${basename(r.to)}」に変更しました。`, 'success');
    return r;
  } catch (e) {
    toastError(e, 'フォルダ名を変更できませんでした。');
    return null;
  }
}

export async function renameFolderWithDialog(path) {
  const name = basename(path);
  const next = await promptDialog({ title: 'フォルダ名の変更', value: name, validate: (v) => validateName(v), okLabel: '変更' });
  if (next == null || next === name) return null;
  return renameFolderTo(path, next);
}

/**
 * Move files into `dest` (conflicts are skipped, never overwritten).
 * `quietUnchanged`: a drop where nothing needed moving shows no toast.
 */
export async function moveInto(paths, dest, { quietUnchanged = false } = {}) {
  try {
    const r = await api.move(paths, dest);
    const parts = [];
    if (r.moved.length) parts.push(`${r.moved.length}件移動しました`);
    if (r.skipped.length) parts.push(`${r.skipped.length}件は同名ファイルが存在するためスキップ`);
    if (r.unchanged.length && !r.moved.length && !r.skipped.length && !quietUnchanged) parts.push('同じフォルダのため移動しませんでした');
    if (parts.length) toast(parts.join(' / '), r.skipped.length ? 'info' : 'success', 5000);
    if (r.errors.length) {
      toast(`${r.errors.length}件を移動できませんでした:\n${r.errors.slice(0, 3).map((x) => `${basename(x.path)}: ${x.message}`).join('\n')}`, 'error');
    }
    if (r.moved.length) {
      const map = new Map(r.moved.map((m) => [m.from, m.to]));
      remapSelection((p) => {
        for (const [f, t] of map) if (samePath(p, f)) return t;
        return null;
      });
      emit('paths-moved', { moved: r.moved, dest });
    }
    return r;
  } catch (e) {
    toastError(e, '移動できませんでした。');
    return null;
  }
}

/** Read dragged paths from a drop event (null when it is not our drag). */
export function draggedPaths(e) {
  if (!e.dataTransfer || !e.dataTransfer.types.includes(DRAG_TYPE)) return null;
  try {
    const v = JSON.parse(e.dataTransfer.getData(DRAG_TYPE));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function dragSource(e) {
  const t = e.dataTransfer && [...e.dataTransfer.types].find((x) => x.startsWith(DRAG_SRC_PREFIX));
  return t ? t.slice(DRAG_SRC_PREFIX.length) : null;
}

/** Start a drag of image paths with a count ghost. `src` = pane id or 'tree'. */
export function startPathsDrag(e, paths, src) {
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
  e.dataTransfer.setData(DRAG_SRC_PREFIX + String(src).toLowerCase(), '1');
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.textContent = paths.length === 1 ? basename(paths[0]) : `${paths.length}枚の画像`;
  document.body.append(ghost);
  e.dataTransfer.setDragImage(ghost, 12, 12);
  setTimeout(() => ghost.remove(), 0);
}
