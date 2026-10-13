// Folder mask: folders marked with Alt+M disappear from the sidebar tree and
// from the gallery's folder tiles while the mask is on (Ctrl+Alt+Shift+M);
// Ctrl+Alt+M shows everything again (marked folders are dimmed). Display only:
// nothing on disk changes. Stored in settings (maskedFolders, maskEnabled).
import { state, saveSettings, emit, on, normKey, samePath, remapUnder } from './state.js';
import { isTrashed } from './ops.js';

function list() {
  return Array.isArray(state.settings.maskedFolders) ? state.settings.maskedFolders : [];
}

export function maskEnabled() {
  return state.settings.maskEnabled !== false;
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
  if (maskEnabled() === !!v) return;
  saveSettings({ maskEnabled: !!v });
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
