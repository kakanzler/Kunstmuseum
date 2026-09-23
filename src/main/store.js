'use strict';
// Metadata store (pure Node, no electron import → unit-testable).
// Persists to a JSON file with atomic writes (tmp file + rename), debounced.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_SETTINGS = Object.freeze({
  includeSubfolders: true,
  sortKey: 'name',
  sortDir: 'asc',
  thumbSize: 160,
  lastFolder: null,
  sidebarWidth: 260,
  inspectorWidth: 300,
  window: null,
  graph: { scope: 'folder', mode: 'bipartite', hiddenTypes: [] },
  layout: null,      // editor-group layout (renderer layout-model serialize())
  showFiles: true,   // sidebar tree lists image files
  screen: { target: 'folder', folder: null, includeSub: true, tagId: null, interval: 5, order: 'name', loop: true },
});

const SEED_TAG_TYPES = [
  { name: 'カテゴリ', color: '#6fa8dc' },
  { name: 'ジャンル', color: '#b48ead' },
];

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

class StoreError extends Error {
  constructor(message) {
    super(message);
    this.code = 'ESTORE';
  }
}

class Store {
  /**
   * @param {string} filePath library.json location
   * @param {{platform?:string, debounceMs?:number, existsSync?:(p:string)=>boolean}} [opts]
   */
  constructor(filePath, opts = {}) {
    this.filePath = filePath;
    this.win = (opts.platform || process.platform) === 'win32';
    this.debounceMs = opts.debounceMs ?? 300;
    this.existsSync = opts.existsSync || fs.existsSync;
    this._timer = null;
    this._index = new Map(); // normalized key → actual key in data.images
    this.data = null;
    this.loadWarning = null;
    this.load();
  }

  // ---------- keys ----------
  norm(p) {
    const r = path.resolve(p);
    return this.win ? r.toLowerCase() : r;
  }

  isInside(dir, p) {
    const r = this.norm(dir);
    const q = this.norm(p);
    if (r === q) return true;
    const rel = path.relative(r, q);
    return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  }

  _rebuildIndex() {
    this._index.clear();
    for (const k of Object.keys(this.data.images)) this._index.set(this.norm(k), k);
  }

  _keyFor(p) {
    return this._index.get(this.norm(p));
  }

  // ---------- persistence ----------
  _defaults() {
    return {
      version: 1,
      roots: [],
      settings: clone(DEFAULT_SETTINGS),
      tagTypes: SEED_TAG_TYPES.map((t) => ({ id: newId('tt'), name: t.name, color: t.color })),
      tags: [],
      images: {},
    };
  }

  load() {
    let raw = null;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') this.loadWarning = `ライブラリを読み込めませんでした: ${e.message}`;
    }
    let data = null;
    if (raw != null) {
      try {
        data = JSON.parse(raw);
      } catch {
        // keep a copy of the unreadable file before it can be replaced by a save
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        try { fs.copyFileSync(this.filePath, backup, fs.constants.COPYFILE_EXCL); } catch { /* ignore */ }
        this.loadWarning = `ライブラリファイルが破損していたため新規作成しました（バックアップ: ${path.basename(backup)}）`;
      }
    }
    this.data = this._sanitize(data);
    this._rebuildIndex();
    return this.data;
  }

  _sanitize(d) {
    const def = this._defaults();
    if (!d || typeof d !== 'object') return def;
    const out = {
      version: 1,
      roots: Array.isArray(d.roots) ? d.roots.filter((r) => typeof r === 'string').map((r) => path.resolve(r)) : [],
      settings: { ...clone(DEFAULT_SETTINGS), ...(d.settings && typeof d.settings === 'object' ? d.settings : {}) },
      tagTypes: Array.isArray(d.tagTypes) && d.tagTypes.length
        ? d.tagTypes.filter((t) => t && t.id && typeof t.name === 'string').map((t) => ({ id: t.id, name: t.name, color: t.color || '#888888' }))
        : def.tagTypes,
      tags: [],
      images: {},
    };
    if (!out.tagTypes.length) out.tagTypes = def.tagTypes;
    const typeIds = new Set(out.tagTypes.map((t) => t.id));
    if (Array.isArray(d.tags)) {
      for (const t of d.tags) {
        if (!t || !t.id || typeof t.name !== 'string') continue;
        out.tags.push({ id: t.id, name: t.name, typeId: typeIds.has(t.typeId) ? t.typeId : out.tagTypes[0].id });
      }
    }
    const tagIds = new Set(out.tags.map((t) => t.id));
    if (d.images && typeof d.images === 'object') {
      for (const [k, v] of Object.entries(d.images)) {
        const tags = Array.isArray(v && v.tags) ? [...new Set(v.tags.filter((id) => tagIds.has(id)))] : [];
        if (tags.length) out.images[path.resolve(k)] = { tags };
      }
    }
    return out;
  }

  serialize() {
    return JSON.stringify(this.data, null, 1);
  }

  /** Schedule a debounced atomic save. */
  save() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      try { this.flush(); } catch (e) { this.lastSaveError = e; }
    }, this.debounceMs);
    if (this._timer.unref) this._timer.unref();
  }

  /** Cancel a pending debounced save without writing. */
  dispose() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  /** Write immediately (tmp file + rename). */
  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmp, this.serialize(), 'utf8');
    try {
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* our own tmp file */ }
      throw e;
    }
  }

  // ---------- roots ----------
  getRoots() {
    return [...this.data.roots];
  }

  addRoot(p) {
    const r = path.resolve(p);
    if (this.data.roots.some((x) => this.norm(x) === this.norm(r))) return false;
    this.data.roots.push(r);
    this.save();
    return true;
  }

  removeRoot(p) {
    const n = this.norm(p);
    const before = this.data.roots.length;
    this.data.roots = this.data.roots.filter((x) => this.norm(x) !== n);
    const changed = this.data.roots.length !== before;
    if (changed) {
      const lf = this.data.settings.lastFolder;
      if (lf && this.isInside(p, lf)) this.data.settings.lastFolder = null;
      this.save();
    }
    return changed;
  }

  isInRoots(p) {
    return this.data.roots.some((r) => this.isInside(r, p));
  }

  // ---------- settings ----------
  getSettings() {
    return clone(this.data.settings);
  }

  setSettings(partial) {
    if (!partial || typeof partial !== 'object') return this.getSettings();
    for (const [k, v] of Object.entries(partial)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      this.data.settings[k] = clone(v);
    }
    this.save();
    return this.getSettings();
  }

  // ---------- tag types ----------
  listTagTypes() {
    return clone(this.data.tagTypes);
  }

  _type(id) {
    const t = this.data.tagTypes.find((x) => x.id === id);
    if (!t) throw new StoreError('タグの種類が見つかりません。');
    return t;
  }

  addTagType({ name, color }) {
    const n = String(name || '').trim();
    if (!n) throw new StoreError('種類名を入力してください。');
    if (this.data.tagTypes.some((t) => t.name.toLowerCase() === n.toLowerCase())) {
      throw new StoreError(`種類「${n}」は既に存在します。`);
    }
    const t = { id: newId('tt'), name: n, color: color || '#9a9a9a' };
    this.data.tagTypes.push(t);
    this.save();
    return clone(t);
  }

  updateTagType(id, { name, color } = {}) {
    const t = this._type(id);
    if (name !== undefined) {
      const n = String(name).trim();
      if (!n) throw new StoreError('種類名を入力してください。');
      if (this.data.tagTypes.some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) {
        throw new StoreError(`種類「${n}」は既に存在します。`);
      }
      t.name = n;
    }
    if (color !== undefined) t.color = String(color);
    this.save();
    return clone(t);
  }

  /** Deletes a type; its tags are reassigned to `reassignTo` (default: first other type). */
  deleteTagType(id, reassignTo) {
    this._type(id);
    const others = this.data.tagTypes.filter((t) => t.id !== id);
    if (!others.length) throw new StoreError('最後の種類は削除できません。');
    const target = reassignTo && others.find((t) => t.id === reassignTo) ? reassignTo : others[0].id;
    for (const tag of this.data.tags) if (tag.typeId === id) tag.typeId = target;
    this.data.tagTypes = others;
    this.save();
    return target;
  }

  // ---------- tags ----------
  listTags() {
    return clone(this.data.tags);
  }

  getTag(id) {
    return clone(this.data.tags.find((t) => t.id === id));
  }

  _tag(id) {
    const t = this.data.tags.find((x) => x.id === id);
    if (!t) throw new StoreError('タグが見つかりません。');
    return t;
  }

  findTag(name, typeId) {
    const n = String(name).trim().toLowerCase();
    return clone(this.data.tags.find((t) => t.typeId === typeId && t.name.toLowerCase() === n));
  }

  /** Creates a tag, or returns the existing one with the same name and type. */
  addTag({ name, typeId }) {
    const n = String(name || '').trim();
    if (!n) throw new StoreError('タグ名を入力してください。');
    const tid = typeId || this.data.tagTypes[0].id;
    this._type(tid);
    const existing = this.findTag(n, tid);
    if (existing) return existing;
    const t = { id: newId('t'), name: n, typeId: tid };
    this.data.tags.push(t);
    this.save();
    return clone(t);
  }

  updateTag(id, { name, typeId } = {}) {
    const t = this._tag(id);
    const nextName = name !== undefined ? String(name).trim() : t.name;
    const nextType = typeId !== undefined ? typeId : t.typeId;
    if (!nextName) throw new StoreError('タグ名を入力してください。');
    this._type(nextType);
    const dup = this.data.tags.find((x) => x.id !== id && x.typeId === nextType && x.name.toLowerCase() === nextName.toLowerCase());
    if (dup) throw new StoreError(`同じ種類に「${dup.name}」が既にあります。統合を使用してください。`);
    t.name = nextName;
    t.typeId = nextType;
    this.save();
    return clone(t);
  }

  /** Replaces `sourceId` by `targetId` on every image, then deletes the source tag. */
  mergeTags(sourceId, targetId) {
    if (sourceId === targetId) throw new StoreError('同じタグには統合できません。');
    this._tag(sourceId);
    this._tag(targetId);
    for (const entry of Object.values(this.data.images)) {
      const i = entry.tags.indexOf(sourceId);
      if (i === -1) continue;
      entry.tags.splice(i, 1);
      if (!entry.tags.includes(targetId)) entry.tags.push(targetId);
    }
    this.data.tags = this.data.tags.filter((t) => t.id !== sourceId);
    this.save();
  }

  /** Deletes the tag metadata only (never touches files). */
  deleteTag(id) {
    this._tag(id);
    this.data.tags = this.data.tags.filter((t) => t.id !== id);
    for (const [k, entry] of Object.entries(this.data.images)) {
      entry.tags = entry.tags.filter((x) => x !== id);
      if (!entry.tags.length) this._deleteKey(k);
    }
    this.save();
  }

  tagUsage() {
    const usage = {};
    for (const t of this.data.tags) usage[t.id] = 0;
    for (const entry of Object.values(this.data.images)) {
      for (const id of entry.tags) usage[id] = (usage[id] || 0) + 1;
    }
    return usage;
  }

  // ---------- images ----------
  _deleteKey(k) {
    delete this.data.images[k];
    this._index.delete(this.norm(k));
  }

  getImageTags(p) {
    const k = this._keyFor(p);
    return k ? [...this.data.images[k].tags] : [];
  }

  /** Returns a map { inputPath: tagIds } */
  getTagsFor(paths) {
    const out = {};
    for (const p of paths) out[p] = this.getImageTags(p);
    return out;
  }

  addTagsToImages(paths, tagIds) {
    const valid = tagIds.filter((id) => this.data.tags.some((t) => t.id === id));
    for (const p of paths) {
      let k = this._keyFor(p);
      if (!k) {
        if (!valid.length) continue;
        k = path.resolve(p);
        this.data.images[k] = { tags: [] };
        this._index.set(this.norm(k), k);
      }
      const entry = this.data.images[k];
      for (const id of valid) if (!entry.tags.includes(id)) entry.tags.push(id);
    }
    this.save();
    return this.getTagsFor(paths);
  }

  removeTagsFromImages(paths, tagIds) {
    const rm = new Set(tagIds);
    for (const p of paths) {
      const k = this._keyFor(p);
      if (!k) continue;
      const entry = this.data.images[k];
      entry.tags = entry.tags.filter((id) => !rm.has(id));
      if (!entry.tags.length) this._deleteKey(k);
    }
    this.save();
    return this.getTagsFor(paths);
  }

  /** All tagged image entries: [{path, tags}] */
  listTaggedImages() {
    return Object.entries(this.data.images).map(([p, v]) => ({ path: p, tags: [...v.tags] }));
  }

  renameImageKey(oldPath, newPath) {
    const k = this._keyFor(oldPath);
    if (!k) return false;
    const entry = this.data.images[k];
    this._deleteKey(k);
    const nk = path.resolve(newPath);
    const existing = this._keyFor(nk);
    if (existing) {
      // merge onto whatever was already recorded for the destination
      const tgt = this.data.images[existing];
      for (const id of entry.tags) if (!tgt.tags.includes(id)) tgt.tags.push(id);
    } else {
      this.data.images[nk] = entry;
      this._index.set(this.norm(nk), nk);
    }
    this.save();
    return true;
  }

  /** Rewrites every key (and root / lastFolder) below `oldDir` to live below `newDir`. */
  renameFolderPrefix(oldDir, newDir) {
    const od = path.resolve(oldDir);
    const nd = path.resolve(newDir);
    // segment-based so the original case of the sub-path is preserved
    const odDepth = od.split(path.sep).filter(Boolean).length;
    const remap = (p) => {
      const tail = path.resolve(p).split(path.sep).filter(Boolean).slice(odDepth);
      return tail.length ? path.join(nd, ...tail) : nd;
    };
    let count = 0;
    const moved = [];
    for (const k of Object.keys(this.data.images)) {
      if (this.isInside(od, k)) moved.push(k);
    }
    for (const k of moved) {
      const entry = this.data.images[k];
      this._deleteKey(k);
      const nk = remap(k);
      this.data.images[nk] = entry;
      this._index.set(this.norm(nk), nk);
      count++;
    }
    this.data.roots = this.data.roots.map((r) => (this.isInside(od, r) ? remap(r) : r));
    const lf = this.data.settings.lastFolder;
    if (lf && this.isInside(od, lf)) this.data.settings.lastFolder = remap(lf);
    this.save();
    return count;
  }

  /**
   * Drops entries whose file no longer exists. Entries on a volume that is
   * currently unavailable (e.g. unplugged drive) are kept.
   */
  pruneMissing() {
    let removed = 0;
    const volumeOk = new Map();
    for (const k of Object.keys(this.data.images)) {
      let ok = false;
      try { ok = this.existsSync(k); } catch { ok = true; }
      if (ok) continue;
      const vol = path.parse(k).root;
      if (!volumeOk.has(vol)) {
        let v = false;
        try { v = this.existsSync(vol); } catch { v = false; }
        volumeOk.set(vol, v);
      }
      if (!volumeOk.get(vol)) continue;
      this._deleteKey(k);
      removed++;
    }
    if (removed) this.save();
    return removed;
  }
}

module.exports = { Store, StoreError, DEFAULT_SETTINGS };
