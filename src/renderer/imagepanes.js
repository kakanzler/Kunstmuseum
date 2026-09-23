// Preview tab (follows the global selection) and pinned image tabs.
import { api, state, on, galleries, lookupItem, navListFor, setGlobalSelection, samePath } from './state.js';
import { el, basename, dirname, extname, toastError } from './ui.js';
import { ImageViewer } from './viewer.js';
import { renameFileWithDialog } from './ops.js';

function itemFor(p) {
  return lookupItem(p) || { path: p, name: basename(p), ext: extname(basename(p)) };
}

function indexIn(list, p) {
  return list.findIndex((it) => samePath(it.path, p));
}

export class PreviewPane {
  constructor(ctx, tab) {
    this.ctx = ctx;
    this.kind = 'preview';
    this.tabId = tab.id;
    this.visible = false;
    this.dirty = true;
    this.viewer = new ImageViewer({
      onNavigate: (d) => this.navigate(d),
      onRename: () => { if (state.selection.primary) renameFileWithDialog(state.selection.primary); },
      emptyText: '画像を選択すると、ここにプレビューが表示されます。',
    });
    this.viewer.clear();
    this.el = el('div', { class: 'pane image-pane preview-pane' }, this.viewer.el);
    this.offs = [
      on('global-selection', () => this.update()),
      on('gallery-view-changed', (id) => {
        const o = state.selection.origin;
        if (o && o.kind === 'gallery' && o.paneId === id) this.update();
      }),
    ];
  }

  get italic() {
    return true;
  }

  title() {
    const p = state.selection.primary;
    return p ? `Preview: ${basename(p)}` : 'Preview';
  }

  update() {
    this.ctx.titleChanged(this);
    if (!this.visible) { this.dirty = true; return this.loading || Promise.resolve(); }
    this.dirty = false;
    const p = state.selection.primary;
    if (!p) { this.viewer.clear(); return Promise.resolve(); }
    const list = navListFor(state.selection.origin);
    const i = indexIn(list, p);
    this.loading = this.viewer.setItem(itemFor(p), i >= 0 ? { index: i, total: list.length } : null);
    return this.loading;
  }

  navigate(delta) {
    const origin = state.selection.origin;
    const list = navListFor(origin);
    if (!list.length) return;
    const i = indexIn(list, state.selection.primary);
    const next = list[((i < 0 ? 0 : i + delta) + list.length) % list.length];
    const g = origin && origin.kind === 'gallery' ? galleries.get(origin.paneId) : null;
    if (g) g.selectPaths([next.path], { emit: true, scroll: true });
    else setGlobalSelection({ paths: [next.path], primary: next.path, origin });
  }

  onShow() {
    this.visible = true;
    if (this.dirty) this.update();
  }
  onHide() {
    this.visible = false;
  }
  handleKey(e) {
    return this.viewer.handleKey(e);
  }
  rename() {
    this.viewer.rename();
  }
  resetZoom() {
    this.viewer.fit();
  }
  dispose() {
    this.offs.forEach((f) => f());
    this.viewer.dispose();
  }
}

export class ImagePane {
  /** origin: {paneId?, list?} — where the image was opened from (for ←/→) */
  constructor(ctx, tab, origin = {}) {
    this.ctx = ctx;
    this.kind = 'image';
    this.tabId = tab.id;
    this.path = tab.path;
    this.origin = origin || {};
    this.siblings = null;
    this.siblingsDir = null;
    this.visible = false;
    this.viewer = new ImageViewer({
      onNavigate: (d) => this.navigate(d),
      onRename: () => renameFileWithDialog(this.path),
    });
    this.el = el('div', { class: 'pane image-pane' }, this.viewer.el);
    this.loading = this.load();
  }

  get italic() {
    return false;
  }

  title() {
    return basename(this.path);
  }

  async navList() {
    const g = this.origin.paneId ? galleries.get(this.origin.paneId) : null;
    if (g && indexIn(g.view, this.path) >= 0) return g.view;
    if (this.origin.list && indexIn(this.origin.list, this.path) >= 0) return this.origin.list;
    const dir = dirname(this.path);
    if (!this.siblings || !samePath(this.siblingsDir, dir)) {
      try {
        this.siblings = (await api.listDir(dir)).files;
      } catch {
        this.siblings = [];
      }
      this.siblingsDir = dir;
    }
    return this.siblings;
  }

  async load() {
    const list = await this.navList();
    const i = indexIn(list, this.path);
    const item = (i >= 0 && list[i]) || itemFor(this.path);
    return this.viewer.setItem(item, i >= 0 ? { index: i, total: list.length } : null);
  }

  async navigate(delta) {
    try {
      const list = await this.navList();
      if (list.length < 2) return;
      const i = indexIn(list, this.path);
      const next = list[((i < 0 ? 0 : i + delta) + list.length) % list.length];
      this.ctx.retargetImage(this, next.path);
    } catch (e) {
      toastError(e);
    }
  }

  /** Point this tab at another path (navigation, rename, move). */
  setPath(p, { keepList = false } = {}) {
    // navigation keeps the sibling listing; renames/moves reload it lazily
    if (!keepList || !samePath(dirname(p), this.siblingsDir || '')) this.siblings = null;
    this.path = p;
    this.loading = this.load();
    this.ctx.titleChanged(this);
    return this.loading;
  }

  onShow() {
    this.visible = true;
  }
  onHide() {
    this.visible = false;
  }
  handleKey(e) {
    return this.viewer.handleKey(e);
  }
  rename() {
    this.viewer.rename();
  }
  resetZoom() {
    this.viewer.fit();
  }
  dispose() {
    this.viewer.dispose();
  }
}
