'use strict';
// In-memory index of every supported image below the registered roots, for
// Quick Open (Ctrl+F). Built once in the background; afterwards kept current
// from the watcher's batched changed-directory events and the app's own
// rename/move operations — only the touched directories are re-listed.

const path = require('node:path');
const fsp = require('node:fs/promises');
const fsops = require('./fsops');
const fuzzy = require('./fuzzy');

class FileIndex {
  constructor({ win = process.platform === 'win32' } = {}) {
    this.win = win;
    this.entries = new Map(); // normKey(path) → {path, name, rel, root, rootName, size, mtime, ext}
    this.roots = [];
    this.building = false;
    this.built = false;
    this.buildPromise = null;
  }

  key(p) {
    return fsops.normKey(p, this.win);
  }

  rootOf(p) {
    let best = null;
    for (const r of this.roots) {
      if (fsops.isInside(r, p, this.win) && (!best || r.length > best.length)) best = r;
    }
    return best;
  }

  _entry(item) {
    const root = this.rootOf(item.path);
    if (!root) return null;
    const relDir = path.relative(root, path.dirname(item.path));
    return {
      path: item.path,
      name: item.name,
      ext: item.ext,
      size: item.size,
      mtime: item.mtime,
      root,
      rootName: path.basename(root) || root,
      rel: relDir.split(path.sep).join('/'),
    };
  }

  _add(items) {
    for (const it of items) {
      const e = this._entry(it);
      if (e) this.entries.set(this.key(it.path), e);
    }
  }

  _removeUnder(dir, { directOnly = false } = {}) {
    const k = this.key(dir);
    for (const [ek, e] of this.entries) {
      const d = this.key(path.dirname(e.path));
      if (directOnly ? d === k : (d === k || fsops.isInside(dir, e.path, this.win))) this.entries.delete(ek);
    }
  }

  /** Replace the root set; drops entries of removed roots, scans added ones. */
  setRoots(roots) {
    const next = roots.map((r) => path.resolve(r));
    const removed = this.roots.filter((r) => !next.some((n) => this.key(n) === this.key(r)));
    const added = next.filter((n) => !this.roots.some((r) => this.key(r) === this.key(n)));
    this.roots = next;
    for (const r of removed) this._removeUnder(r);
    if (this.built || this.building) {
      for (const r of added) this._scanInto(r);
    }
  }

  async _scanInto(dir) {
    try {
      this._add(await fsops.scanFolder(dir, { recursive: true }));
    } catch { /* missing root: nothing to index */ }
  }

  /** Build in the background (idempotent). */
  build() {
    if (this.buildPromise) return this.buildPromise;
    this.building = true;
    this.buildPromise = (async () => {
      for (const r of [...this.roots]) await this._scanInto(r);
      this.building = false;
      this.built = true;
    })();
    return this.buildPromise;
  }

  /**
   * Watcher batch: re-list only these directories. Files directly inside are
   * replaced; vanished sub-folders are dropped; sub-folders the index has
   * never seen (e.g. moved in) are scanned.
   */
  async updateDirs(dirs) {
    if (!this.built && !this.building) return;
    const uniq = [...new Map(dirs.map((d) => [this.key(d), path.resolve(d)])).values()];
    for (const dir of uniq) {
      if (!this.rootOf(dir)) continue;
      let items;
      let subdirs;
      try {
        items = await fsops.scanFolder(dir, { recursive: false });
        subdirs = (await fsp.readdir(dir, { withFileTypes: true }))
          .filter((d) => d.isDirectory() && !fsops.shouldSkipDir(d.name))
          .map((d) => path.join(dir, d.name));
      } catch {
        this._removeUnder(dir); // the directory itself is gone
        continue;
      }
      this._removeUnder(dir, { directOnly: true });
      this._add(items);
      // sub-folders: known ones are handled by their own events; new ones are scanned
      const known = new Set();
      const k = this.key(dir);
      for (const e of this.entries.values()) {
        const ek = this.key(e.path);
        if (ek.startsWith(k + (this.win ? '\\' : '/'))) {
          const rest = ek.slice(k.length + 1);
          const i = rest.search(/[\\/]/);
          if (i > 0) known.add(rest.slice(0, i));
        }
      }
      const present = new Set(subdirs.map((s) => this.key(path.basename(s))));
      for (const name of known) if (!present.has(name)) this._removeUnder(path.join(dir, name));
      for (const s of subdirs) if (!known.has(this.key(path.basename(s)))) await this._scanInto(s);
    }
  }

  /** App-initiated file rename/move. */
  renamePath(from, to, stat = null) {
    const old = this.entries.get(this.key(from));
    this.entries.delete(this.key(from));
    const it = { path: to, name: path.basename(to), ext: fsops.extOf(to), size: stat ? stat.size : old && old.size, mtime: stat ? stat.mtimeMs : old && old.mtime };
    if (fsops.isSupported(to)) this._add([it]);
  }

  /** App-initiated folder rename. */
  renameDir(from, to) {
    const moved = [];
    for (const [ek, e] of this.entries) {
      if (fsops.isInside(from, e.path, this.win)) {
        this.entries.delete(ek);
        moved.push({ ...e, path: path.join(to, path.relative(from, e.path)) });
      }
    }
    this._add(moved);
  }

  search(query, limit = 100) {
    return {
      results: fuzzy.search([...this.entries.values()], query, limit),
      building: this.building,
      count: this.entries.size,
    };
  }
}

module.exports = { FileIndex };
