// Editor-group workbench: renders the LayoutModel (groups, tab bars, panes),
// tab drag & drop, splitters, menus, image/folder opening and persistence.
import { LayoutModel } from './layout-model.js';
import { api, state, emit, on, saveSettings, isWin, samePath, remapUnder, pathUnder } from './state.js';
import { el, showContextMenu } from './ui.js';
import { GalleryPane, defaultGalleryState } from './gallery.js';
import { GraphPane } from './graph.js';
import { PreviewPane, ImagePane } from './imagepanes.js';

const TAB_TYPE = 'application/x-km-tab';
const ICONS = { gallery: '▦', graph: '◎', preview: '◫', image: '▣' };

class Workbench {
  constructor() {
    this.model = null;
    this.panes = new Map();     // tab id → pane
    this.groupEls = new Map();  // group id → {el, tabs, body, overlay}
    this.splitters = [];
    this.origins = new Map();   // image tab id → {paneId?, list?} (navigation source)
    this.saveTimer = null;
    this.lastMru = null;
  }

  // ---------- setup ----------
  async init(root) {
    this.root = root;
    this.emptyEl = el('div', { class: 'wb-empty' },
      el('div', { class: 'wb-empty-title' }, 'タブが開かれていません'),
      el('div', { class: 'wb-empty-actions' },
        el('button', { class: 'btn', onclick: () => this.addFromMenu(null, 'gallery') }, 'ギャラリー'),
        el('button', { class: 'btn', onclick: () => this.addFromMenu(null, 'graph') }, '知識グラフ'),
        el('button', { class: 'btn', onclick: () => this.addFromMenu(null, 'preview') }, 'Preview')));
    root.append(this.emptyEl);

    const byPath = (pairs) => (p) => {
      for (const { from, to } of pairs) if (samePath(p, from)) return to;
      return null;
    };
    on('paths-renamed', (renames) => this.remapImageTabs(byPath(renames)));
    on('paths-moved', ({ moved }) => this.remapImageTabs(byPath(moved)));
    on('folder-renamed', ({ from, to }) => this.remapImageTabs((p) => remapUnder(p, from, to)));
    on('roots-changed', () => this.dropTabsOutsideRoots());

    let model = null;
    const saved = state.settings.layout;
    if (saved && Array.isArray(saved.groups)) {
      const paths = saved.groups.flatMap((g) => (g.tabs || []).filter((t) => t && t.kind === 'image' && t.path).map((t) => t.path));
      let exists = {};
      try {
        exists = paths.length ? await api.exists(paths) : {};
      } catch {
        exists = {};
      }
      model = LayoutModel.restore(saved, { caseInsensitive: isWin() }, { pathOk: (p) => exists[p] === true });
    }
    if (!model) model = LayoutModel.createDefault({ caseInsensitive: isWin() }, defaultGalleryState(this.lastFolderSource()));
    this.model = model;
    this.render();
    this.save();
  }

  lastFolderSource() {
    const p = state.settings.lastFolder;
    if (p && state.roots.some((r) => r.exists && pathUnder(p, r.path))) return { kind: 'folder', path: p };
    return null;
  }

  createPane(tab) {
    switch (tab.kind) {
      case 'gallery': return new GalleryPane(this, tab);
      case 'graph': return new GraphPane(this, tab);
      case 'preview': return new PreviewPane(this, tab);
      case 'image': return new ImagePane(this, tab, this.origins.get(tab.id));
      default: throw new Error(`unknown tab kind ${tab.kind}`);
    }
  }

  pane(tabId) {
    return this.panes.get(tabId) || null;
  }

  activePane() {
    const t = this.model && this.model.activeTab();
    return t ? this.pane(t.id) : null;
  }

  mruGalleryPane() {
    const t = this.model && this.model.mruGallery();
    return t ? this.pane(t.id) : null;
  }

  // ---------- rendering ----------
  render() {
    const m = this.model;
    const liveTabs = new Set(m.allTabs().map((t) => t.id));
    for (const [id, p] of [...this.panes]) {
      if (liveTabs.has(id)) continue;
      p.dispose();
      p.el.remove();
      this.panes.delete(id);
      this.origins.delete(id);
    }
    const liveGroups = new Set(m.groups.map((g) => g.id));
    for (const [id, ge] of [...this.groupEls]) {
      if (!liveGroups.has(id)) { ge.el.remove(); this.groupEls.delete(id); }
    }

    // group/splitter order
    const desired = [];
    m.groups.forEach((g, i) => {
      if (i > 0) desired.push(this.splitter(i - 1));
      desired.push(this.groupEl(g).el);
    });
    for (const s of this.splitters.slice(Math.max(0, m.groups.length - 1))) s.remove();
    const current = [...this.root.children].filter((c) => c !== this.emptyEl);
    let reordered = false;
    if (current.length !== desired.length || current.some((c, i) => c !== desired[i])) {
      // moving nodes detaches them (scroll offsets reset) → re-show visible panes
      for (const node of desired) this.root.insertBefore(node, this.emptyEl);
      reordered = true;
    }
    this.emptyEl.classList.toggle('hidden', m.groups.length > 0);

    const toShow = [];
    for (const g of m.groups) {
      const ge = this.groupEl(g);
      ge.el.style.flex = `${g.size} 1 0`;
      ge.el.classList.toggle('active-group', g.id === m.activeGroupId);
      for (const tab of g.tabs) {
        let p = this.panes.get(tab.id);
        if (!p) {
          p = this.createPane(tab);
          this.panes.set(tab.id, p);
        }
        const moved = p.el.parentNode !== ge.body;
        if (moved) ge.body.insertBefore(p.el, ge.overlay);
        const active = tab.id === g.activeTabId;
        p.el.classList.toggle('hidden', !active);
        if (active && (moved || reordered || !p.visible)) toShow.push(p);
        else if (!active && p.visible) p.onHide();
      }
      this.renderTabs(g);
    }
    for (const p of toShow) p.onShow();
    this.checkMru();
    emit('layout-changed');
  }

  checkMru() {
    const mru = this.model.mruGallery();
    const mruId = mru ? mru.id : null;
    if (mruId !== this.lastMru) {
      this.lastMru = mruId;
      emit('mru-gallery-changed', mruId);
    }
  }

  groupEl(g) {
    let ge = this.groupEls.get(g.id);
    if (ge) return ge;
    const tabs = el('div', { class: 'etabs' });
    const add = el('button', { class: 'etab-add', title: '新しいタブ' }, '＋');
    const bar = el('div', { class: 'tabbar' }, tabs, add);
    const overlay = el('div', { class: 'drop-overlay hidden' });
    const body = el('div', { class: 'group-body' }, overlay);
    const root = el('div', { class: 'group', dataset: { group: g.id } }, bar, body);
    ge = { el: root, bar, tabs, body, overlay, id: g.id };
    this.groupEls.set(g.id, ge);

    root.addEventListener('mousedown', () => this.activateGroup(ge.id), true);
    add.addEventListener('click', (e) => {
      const r = add.getBoundingClientRect();
      showContextMenu(r.left, r.bottom + 2, [
        { label: 'ギャラリー', action: () => this.addFromMenu(ge.id, 'gallery') },
        { label: '知識グラフ', action: () => this.addFromMenu(ge.id, 'graph') },
        { label: 'Preview', title: 'Alt+P: アクティブなグループの右に Preview を表示', action: () => this.addFromMenu(ge.id, 'preview') },
      ]);
      e.stopPropagation();
    });

    // reorder / move between tab bars
    const clearMarks = () => bar.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
    const indexAt = (x) => {
      const els = [...tabs.children];
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        if (x < r.left + r.width / 2) return i;
      }
      return els.length;
    };
    bar.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes(TAB_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearMarks();
      const i = indexAt(e.clientX);
      const target = tabs.children[i];
      if (target) target.classList.add('drop-before');
      bar.classList.toggle('drop-end', !target);
    });
    bar.addEventListener('dragleave', (e) => {
      if (!bar.contains(e.relatedTarget)) { clearMarks(); bar.classList.remove('drop-end'); }
    });
    bar.addEventListener('drop', (e) => {
      if (!e.dataTransfer.types.includes(TAB_TYPE)) return;
      e.preventDefault();
      clearMarks();
      bar.classList.remove('drop-end');
      const tabId = e.dataTransfer.getData(TAB_TYPE);
      if (!this.model.tab(tabId)) return;
      this.model.moveTab(tabId, ge.id, indexAt(e.clientX));
      this.commit();
    });

    // split / move by dropping on the content area
    const zoneAt = (e) => {
      const r = body.getBoundingClientRect();
      const f = (e.clientX - r.left) / Math.max(1, r.width);
      return f < 0.3 ? 'left' : f > 0.7 ? 'right' : 'center';
    };
    body.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes(TAB_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      overlay.className = `drop-overlay zone-${zoneAt(e)}`;
    });
    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) overlay.className = 'drop-overlay hidden';
    });
    body.addEventListener('drop', (e) => {
      if (!e.dataTransfer.types.includes(TAB_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      overlay.className = 'drop-overlay hidden';
      const tabId = e.dataTransfer.getData(TAB_TYPE);
      if (!this.model.tab(tabId)) return;
      this.model.dropTab(tabId, ge.id, zoneAt(e));
      this.commit();
    });
    return ge;
  }

  splitter(i) {
    if (this.splitters[i]) return this.splitters[i];
    const s = el('div', { class: 'group-splitter', title: 'ドラッグで幅を変更' });
    s.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const idx = this.splitters.indexOf(s);
      const groups = this.model.groups;
      const left = this.groupEls.get(groups[idx].id).el;
      const right = this.groupEls.get(groups[idx + 1].id).el;
      const total = groups.reduce((sum, g) => sum + this.groupEls.get(g.id).el.getBoundingClientRect().width, 0);
      const lw = left.getBoundingClientRect().width;
      const rw = right.getBoundingClientRect().width;
      const startX = e.clientX;
      s.setPointerCapture(e.pointerId);
      s.classList.add('active');
      const move = (ev) => {
        const dx = Math.max(-lw + 120, Math.min(rw - 120, ev.clientX - startX));
        const sizes = groups.map((g) => this.groupEls.get(g.id).el.getBoundingClientRect().width / total);
        sizes[idx] = (lw + dx) / total;
        sizes[idx + 1] = (rw - dx) / total;
        this.model.setGroupSizes(sizes);
        groups.forEach((g) => { this.groupEls.get(g.id).el.style.flex = `${g.size} 1 0`; });
      };
      const up = () => {
        s.classList.remove('active');
        s.removeEventListener('pointermove', move);
        s.removeEventListener('pointerup', up);
        s.removeEventListener('pointercancel', up);
        this.save();
      };
      s.addEventListener('pointermove', move);
      s.addEventListener('pointerup', up);
      s.addEventListener('pointercancel', up);
    });
    this.splitters[i] = s;
    return s;
  }

  renderTabs(g) {
    const ge = this.groupEl(g);
    ge.tabs.replaceChildren(...g.tabs.map((tab) => this.tabEl(tab, g)));
  }

  tabEl(tab, g) {
    const p = this.pane(tab.id);
    const title = el('span', { class: 'etab-title' }, p ? p.title() : tab.kind);
    const close = el('button', { class: 'etab-close', title: '閉じる (Ctrl+W)' }, '×');
    const t = el('div', {
      class: `etab${tab.id === g.activeTabId ? ' active' : ''}${p && p.italic ? ' italic' : ''}`,
      draggable: 'true',
      dataset: { tab: tab.id, kind: tab.kind },
      title: this.tabTooltip(tab, p),
    }, el('span', { class: 'etab-icon' }, ICONS[tab.kind] || ''), title, close);
    t.addEventListener('click', () => this.activate(tab.id));
    close.addEventListener('click', (e) => { e.stopPropagation(); this.closeTab(tab.id); });
    t.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    t.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      this.closeTab(tab.id);
    });
    t.addEventListener('contextmenu', (e) => { e.preventDefault(); this.tabMenu(e, tab.id); });
    t.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(TAB_TYPE, tab.id);
    });
    t.addEventListener('dragend', () => {
      this.root.querySelectorAll('.drop-overlay').forEach((o) => { o.className = 'drop-overlay hidden'; });
    });
    return t;
  }

  tabTooltip(tab, p) {
    if (tab.kind === 'image') return tab.path;
    if (tab.kind === 'gallery' && p && p.source && p.source.kind === 'folder') return p.source.path;
    return p ? p.title() : '';
  }

  /** Refresh one tab's label after its pane title changed. */
  titleChanged(pane) {
    if (!this.root) return;
    emit('active-pane-changed');
    const t = this.root.querySelector(`.etab[data-tab="${pane.tabId}"]`);
    if (!t) return;
    // update the existing text node in place (no tab-bar rebuild, no reflow of siblings' nodes)
    const span = t.querySelector('.etab-title');
    const text = pane.title();
    if (span.textContent !== text) {
      if (span.firstChild && span.firstChild.nodeType === Node.TEXT_NODE && span.childNodes.length === 1) span.firstChild.nodeValue = text;
      else span.textContent = text;
    }
    if (t.classList.contains('italic') !== !!pane.italic) t.classList.toggle('italic', !!pane.italic);
    const tab = this.model.tab(pane.tabId);
    const tip = tab ? this.tabTooltip(tab, pane) : '';
    if (tab && t.title !== tip) t.title = tip;
  }

  stateChanged() {
    this.save();
  }

  commit() {
    this.render();
    this.save();
  }

  // ---------- commands ----------
  activate(tabId) {
    if (!this.model.tab(tabId)) return;
    this.model.activateTab(tabId);
    this.commit();
  }

  /** Pointer entered a group: mark it active without rebuilding its tab bar. */
  activateGroup(groupId) {
    const m = this.model;
    const g = m.group(groupId);
    if (!g) return;
    if (m.activeGroupId === groupId && m.mru[0] === g.activeTabId) return;
    m.activateGroup(groupId);
    for (const [id, ge] of this.groupEls) ge.el.classList.toggle('active-group', id === m.activeGroupId);
    this.checkMru();
    emit('active-pane-changed');
    this.save();
  }

  focusGroup(index) {
    const g = this.model.groups[index];
    if (!g) return;
    this.activateGroup(g.id);
    const p = this.activePane();
    const focusable = p && p.el.querySelector('.grid, [tabindex]');
    if (focusable) focusable.focus({ preventScroll: true });
  }

  closeTab(tabId) {
    if (!this.model.tab(tabId)) return;
    this.model.closeTab(tabId);
    this.commit();
  }

  closeActive() {
    const t = this.model.activeTab();
    if (t) this.closeTab(t.id);
  }

  cycle(delta) {
    if (this.model.cycleTab(delta)) this.commit();
  }

  split(tabId, side) {
    const tab = this.model.tab(tabId);
    if (!tab) return null;
    const res = this.model.splitTab(tabId, side, (t) => {
      const p = this.pane(t.id);
      return p && p.serialize ? p.serialize() : t.state;
    });
    if (res && res.kind === 'image' && res.id !== tabId && this.origins.has(tabId)) this.origins.set(res.id, this.origins.get(tabId));
    this.commit();
    return res;
  }

  splitActive(side = 'right') {
    const t = this.model.activeTab();
    return t ? this.split(t.id, side) : null;
  }

  tabMenu(e, tabId) {
    const g = this.model.groupOf(tabId);
    const gi = this.model.groupIndex(g.id);
    showContextMenu(e.clientX, e.clientY, [
      { label: '閉じる', action: () => this.closeTab(tabId) },
      { label: '他のタブを閉じる', disabled: g.tabs.length < 2, action: () => { this.model.closeOthers(tabId); this.commit(); } },
      { separator: true },
      { label: '右に分割', action: () => this.split(tabId, 'right') },
      { label: '左に分割', action: () => this.split(tabId, 'left') },
      { separator: true },
      { label: '左のグループへ移動', disabled: gi === 0 && g.tabs.length < 2, action: () => { this.model.moveTabToNeighbor(tabId, 'left'); this.commit(); } },
      { label: '右のグループへ移動', disabled: gi === this.model.groups.length - 1 && g.tabs.length < 2, action: () => { this.model.moveTabToNeighbor(tabId, 'right'); this.commit(); } },
    ]);
  }

  defaultSource() {
    const g = this.mruGalleryPane();
    if (g && g.source) return g.source;
    return this.lastFolderSource();
  }

  addFromMenu(groupId, kind) {
    const gid = groupId || (this.model.activeGroup() && this.model.activeGroupId);
    const spec = kind === 'gallery' ? { kind, state: defaultGalleryState(this.defaultSource()) } : { kind };
    const tab = this.model.addTab(gid, spec);
    this.commit();
    return tab;
  }

  /** Opens (or focuses) a pinned image tab. */
  openImage(path, { fromPane = null, list = null } = {}) {
    const m = this.model;
    const existing = m.findImageTab(path);
    if (existing) {
      m.activateTab(existing.id);
      this.commit();
      return existing;
    }
    const srcGroup = fromPane ? m.groupOf(fromPane.tabId) : m.activeGroup();
    const prev = m.findSingleton('preview');
    const pg = prev ? m.groupOf(prev.id) : null;
    const target = pg && (!srcGroup || pg.id !== srcGroup.id) ? pg : srcGroup;
    const tab = m.addTab(target ? target.id : null, { kind: 'image', path });
    this.origins.set(tab.id, fromPane && fromPane.kind === 'gallery' ? { paneId: fromPane.id } : { list });
    this.commit();
    return tab;
  }

  /** ←/→ inside an image tab: point it at another path. */
  retargetImage(pane, path) {
    this.model.setTabPath(pane.tabId, path);
    pane.setPath(path, { keepList: true });
    this.save();
  }

  remapImageTabs(fn) {
    let changed = false;
    for (const t of this.model.allTabs()) {
      if (t.kind !== 'image') continue;
      const n = fn(t.path);
      if (!n || n === t.path) continue;
      this.model.setTabPath(t.id, n);
      const p = this.pane(t.id);
      if (p) p.setPath(n);
      changed = true;
    }
    if (changed) this.save();
  }

  dropTabsOutsideRoots() {
    const inRoots = (p) => state.roots.some((r) => pathUnder(p, r.path));
    const gone = this.model.allTabs().filter((t) => t.kind === 'image' && !inRoots(t.path));
    if (!gone.length) return;
    for (const t of gone) this.model.closeTab(t.id);
    this.commit();
  }

  /** Sidebar folder click: active gallery → MRU gallery → new gallery tab. */
  openFolder(path, opts = {}) {
    saveSettings({ lastFolder: path });
    return this.openSource({ kind: 'folder', path }, opts);
  }

  /** 全フォルダ（タグ付き画像）. */
  openTagged(opts = {}) {
    return this.openSource({ kind: 'tagged' }, opts);
  }

  openSource(src, { newTab = false } = {}) {
    const m = this.model;
    if (!newTab) {
      const at = m.activeTab();
      let t = at && at.kind === 'gallery' ? at : m.mruGallery();
      if (t) {
        m.activateTab(t.id);
        this.commit();
        const p = this.pane(t.id);
        return p.setSource(src).then(() => p);
      }
    }
    const tab = m.addTab(m.activeGroupId, { kind: 'gallery', state: defaultGalleryState(src) });
    this.commit();
    const p = this.pane(tab.id);
    return p.loadPromise.then(() => p);
  }

  /** Graph tag double-click: filter the MRU gallery (or a new one). */
  async showTagInGallery(tagId, scope) {
    const m = this.model;
    let t = m.mruGallery();
    if (!t) t = m.addTab(m.activeGroupId, { kind: 'gallery', state: defaultGalleryState({ kind: 'tagged' }) });
    m.activateTab(t.id);
    this.commit();
    const p = this.pane(t.id);
    if (scope !== 'folder' || !p.source || p.source.kind !== 'folder') await p.setSource({ kind: 'tagged' });
    p.setTagFilter([tagId]);
    return p;
  }

  /**
   * Alt+P: show Preview in the group right of the active group while the
   * active group and the keyboard focus stay where they are.
   */
  showPreviewRight() {
    const focused = document.activeElement;
    const tab = this.model.showPreviewRight(this.model.activeGroupId);
    this.commit();
    if (focused && focused !== document.body && focused.isConnected) focused.focus({ preventScroll: true });
    return tab;
  }

  // ---------- keyboard ----------
  handleKey(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl || e.altKey) return false;
    if (!e.shiftKey && e.key.toLowerCase() === 'w') { e.preventDefault(); this.closeActive(); return true; }
    if (e.key === '\\' || e.code === 'Backslash' || e.code === 'IntlYen') { e.preventDefault(); this.splitActive('right'); return true; }
    const m = /^Digit([1-4])$/.exec(e.code) || /^([1-4])$/.exec(e.key);
    if (m && !e.shiftKey) { e.preventDefault(); this.focusGroup(Number(m[1]) - 1); return true; }
    if (e.key === 'Tab') { e.preventDefault(); this.cycle(e.shiftKey ? -1 : 1); return true; }
    return false;
  }

  // ---------- persistence ----------
  serialize() {
    return this.model.serialize((t) => {
      const p = this.pane(t.id);
      return p && p.serialize ? p.serialize() : t.state;
    });
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      if (this.model) saveSettings({ layout: this.serialize() });
    }, 300);
  }

  /** Persist right now (used before shutdown / by the smoke test). */
  saveNow() {
    clearTimeout(this.saveTimer);
    const layout = this.serialize();
    state.settings.layout = layout;
    return api.setSettings({ layout });
  }
}

export const wb = new Workbench();
