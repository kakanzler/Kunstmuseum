// Folder mask: folders marked with Alt+M disappear from the sidebar tree and
// from the gallery's folder tiles while the mask is on (Ctrl+Alt+Shift+M);
// Ctrl+Shift+M shows everything again (marked folders are dimmed). Display only:
// nothing on disk changes. The marked folders are kept in settings
// (maskedFolders → library.json, untouched by reinstalls); on/off is per run
// and every launch starts masked.
import { state, saveSettings, emit, on, normKey, samePath, remapUnder, pathUnder } from './state.js';
import { isTrashed } from './ops.js';

function list() {
  return Array.isArray(state.settings.maskedFolders) ? state.settings.maskedFolders : [];
}

let enabled = true; // not persisted: the app always starts masked

export function maskEnabled() {
  return enabled;
}

/** The folder is marked (whether or not the mask is currently on). */
export function isMarked(p) {
  const k = normKey(p);
  return list().some((x) => normKey(x) === k);
}

/** The folder is hidden right now. */
export function isMasked(p) {
  return maskEnabled() && isMarked(p);
}

/** A file or folder inside (or equal to) a masked folder, while the mask is on. */
export function isHiddenPath(p) {
  return maskEnabled() && list().some((x) => pathUnder(p, x));
}

function store(next) {
  saveSettings({ maskedFolders: next });
  emit('mask-changed');
}

/** Mark the folder, or unmark it when it is already marked. Returns true when now marked. */
export function toggleMask(p) {
  const cur = list();
  if (isMarked(p)) {
    store(cur.filter((x) => !samePath(x, p)));
    return false;
  }
  store([...cur, p]);
  return true;
}

export function setMaskEnabled(v) {
  if (enabled === !!v) return;
  enabled = !!v;
  emit('mask-changed');
}

export function initMask() {
  on('folder-renamed', ({ from, to }) => {
    const cur = list();
    const next = cur.map((x) => remapUnder(x, from, to) || x);
    if (next.some((x, i) => x !== cur[i])) store(next);
  });
  on('paths-trashed', (trashed) => {
    const gone = isTrashed(trashed);
    const cur = list();
    const next = cur.filter((x) => !gone(x));
    if (next.length !== cur.length) store(next);
  });
}
