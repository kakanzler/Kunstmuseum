// ★ お気に入り: Alt+V / context menu / inspector toggle a star on files.
// Stars live in library.json (store.favorites, main process); every gallery
// item carries `fav` from main and is updated in place here.
import { api, state, emit, galleries } from './state.js';
import { toast, toastError } from './ui.js';

/**
 * Star the files, or unstar them when every one is already starred.
 * Returns {on, paths} or null when nothing was done.
 */
export async function toggleFavorites(paths) {
  const ps = (paths || []).filter((p) => typeof p === 'string' && p);
  if (!ps.length) {
    toast('ファイルを選択してください', 'error');
    return null;
  }
  let res;
  try {
    res = await api.toggleFavorite(ps);
  } catch (e) {
    toastError(e, 'お気に入りを変更できませんでした。');
    return null;
  }
  for (const p of res.paths) {
    for (const g of galleries.values()) {
      const it = g.itemsByPath.get(p);
      if (it) it.fav = res.on;
    }
  }
  emit('favorites-changed', res);
  const n = res.paths.length;
  const what = n > 1 ? `${n}件を` : '';
  toast(res.on ? `★ ${what}お気に入りに追加しました。` : `${what}お気に入りから外しました。`, 'success', 1600);
  return res;
}

/** The current global selection. */
export function toggleSelectedFavorites() {
  return toggleFavorites(state.selection.paths);
}
