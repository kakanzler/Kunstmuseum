// Shared renderer state, event bus, global selection and pane registry.
export const api = window.api;

export const state = {
  info: { platform: api.platform, smoke: false, exts: [] },
  settings: {},
  roots: [],
  lib: { tagTypes: [], tags: [], usage: {} },
  /**
   * Global selection (drives Preview + inspector).
   * origin: {kind:'gallery', paneId} | {kind:'tree', dir, list} | {kind:'graph', list}
   */
  selection: { paths: [], primary: null, origin: null },
};

const bus = new EventTarget();
export function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}
/** Subscribe; returns an unsubscribe function. */
export function on(name, fn) {
  const h = (e) => fn(e.detail);
  bus.addEventListener(name, h);
  return () => bus.removeEventListener(name, h);
}

export function isWin() {
  return state.info.platform === 'win32';
}
export function normKey(p) {
  return isWin() ? String(p).toLowerCase() : String(p);
}
export function sep() {
  return isWin() ? '\\' : '/';
}
/** normalized key `k` equals or lies below normalized key `parent` */
export function keyUnder(k, parent) {
  if (k === parent) return true;
  const s = sep();
  return k.startsWith(parent.endsWith(s) ? parent : parent + s);
}
export function pathUnder(p, dir) {
  return keyUnder(normKey(p), normKey(dir));
}
/** If `p` is `from` or below it, return the same path below `to`; else null. */
export function remapUnder(p, from, to) {
  if (!pathUnder(p, from)) return null;
  const rest = String(p).slice(String(from).replace(/[\\/]+$/, '').length);
  return to.replace(/[\\/]+$/, '') + rest;
}
export function samePath(a, b) {
  return a != null && b != null && normKey(a) === normKey(b);
}

// ---------- tags ----------
export function tagById(id) {
  return state.lib.tags.find((t) => t.id === id);
}
export function typeById(id) {
  return state.lib.tagTypes.find((t) => t.id === id);
}
export function tagColor(tag) {
  const t = tag && typeById(tag.typeId);
  return (t && t.color) || '#888888';
}
export function setLib(lib) {
  if (!lib) return;
  state.lib = lib;
  emit('lib-changed', lib);
}

// ---------- pane registry & item lookup ----------
/** gallery panes by pane id (= tab id) */
export const galleries = new Map();
const itemLookups = [];
export function registerItemLookup(fn) {
  itemLookups.push(fn);
}
/** Best known item record ({path,name,size,mtime,ext,tags?}) for a path, or null. */
export function lookupItem(p) {
  for (const g of galleries.values()) {
    const it = g.itemsByPath.get(p);
    if (it) return it;
  }
  for (const fn of itemLookups) {
    const it = fn(p);
    if (it) return it;
  }
  return null;
}

/** Apply a {path: tagIds} map returned by main to every known item. */
export function applyImageTags(map) {
  for (const [p, tags] of Object.entries(map || {})) {
    for (const g of galleries.values()) {
      const it = g.itemsByPath.get(p);
      if (it) it.tags = tags;
    }
  }
  emit('image-tags-changed', map);
}

// ---------- global selection ----------
export function setGlobalSelection({ paths, primary, origin }) {
  const ps = [...(paths || [])];
  state.selection = {
    paths: ps,
    primary: primary && ps.includes(primary) ? primary : (ps[ps.length - 1] || null),
    origin: origin || null,
  };
  emit('global-selection', state.selection);
}

/** Ordered navigation list ({path,name,...}[]) for a selection origin. */
export function navListFor(origin) {
  if (!origin) return [];
  if (origin.kind === 'gallery') {
    const g = galleries.get(origin.paneId);
    return g ? g.view : [];
  }
  return origin.list || [];
}

// ---------- settings ----------
let settingsTimer = null;
let pendingSettings = {};
export function saveSettings(partial) {
  Object.assign(state.settings, partial);
  Object.assign(pendingSettings, partial);
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(flushSettings, 250);
}
export function flushSettings() {
  clearTimeout(settingsTimer);
  const p = pendingSettings;
  pendingSettings = {};
  if (!Object.keys(p).length) return Promise.resolve();
  return api.setSettings(p).catch((e) => console.warn('settings save failed', e));
}
