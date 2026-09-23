// Editor-group layout model (pure, DOM-free → unit-testable with node).
//
// A layout is a row of 1..MAX_GROUPS groups; each group holds ordered tabs and
// an active tab. Tab kinds: gallery (many), graph / preview (singletons),
// image (one per path per group).

export const MAX_GROUPS = 4;
export const SINGLETONS = new Set(['graph', 'preview']);
const KINDS = new Set(['gallery', 'graph', 'preview', 'image']);

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

export class LayoutModel {
  /** @param {{caseInsensitive?: boolean}} [opts] */
  constructor(opts = {}) {
    this.ci = !!opts.caseInsensitive;
    this.groups = [];
    this.activeGroupId = null;
    this.mru = []; // tab ids, most recent first
    this.seq = 1;
  }

  // ---------- construction ----------
  static createDefault(opts = {}, galleryState = {}) {
    const m = new LayoutModel(opts);
    const g1 = m.addGroup();
    m.addTab(g1.id, { kind: 'gallery', state: galleryState });
    const g2 = m.addGroup(g1.id, 'right');
    m.addTab(g2.id, { kind: 'preview' });
    m.activateTab(g1.tabs[0].id);
    return m;
  }

  /**
   * Rebuild from serialized data. Invalid tabs, image tabs whose path fails
   * `pathOk`, duplicate singletons, same-group image duplicates and empty
   * groups are dropped silently.
   */
  static restore(data, opts = {}, { pathOk = () => true } = {}) {
    const m = new LayoutModel(opts);
    if (!data || typeof data !== 'object' || !Array.isArray(data.groups)) return null;
    const seenIds = new Set();
    const seenSingletons = new Set();
    let maxSeq = 0;
    const bump = (id) => {
      const n = Number(String(id).replace(/^\D+/, ''));
      if (Number.isFinite(n)) maxSeq = Math.max(maxSeq, n);
    };
    for (const g of data.groups.slice(0, MAX_GROUPS)) {
      if (!g || !Array.isArray(g.tabs) || !g.id || seenIds.has(g.id)) continue;
      seenIds.add(g.id);
      bump(g.id);
      const group = { id: String(g.id), size: Number(g.size) > 0 ? Number(g.size) : 1, tabs: [], activeTabId: null };
      const pathsHere = new Set();
      for (const t of g.tabs) {
        if (!t || !KINDS.has(t.kind) || !t.id || seenIds.has(t.id)) continue;
        if (SINGLETONS.has(t.kind)) {
          if (seenSingletons.has(t.kind)) continue;
          seenSingletons.add(t.kind);
        }
        if (t.kind === 'image') {
          if (typeof t.path !== 'string' || !t.path || !pathOk(t.path)) continue;
          const k = m.key(t.path);
          if (pathsHere.has(k)) continue;
          pathsHere.add(k);
        }
        seenIds.add(t.id);
        bump(t.id);
        const tab = { id: String(t.id), kind: t.kind };
        if (t.kind === 'image') tab.path = t.path;
        if (t.kind === 'gallery') tab.state = clone(t.state && typeof t.state === 'object' ? t.state : {});
        group.tabs.push(tab);
      }
      if (!group.tabs.length) continue;
      group.activeTabId = group.tabs.some((t) => t.id === g.activeTabId) ? g.activeTabId : group.tabs[0].id;
      m.groups.push(group);
    }
    m.seq = Math.max(maxSeq + 1, Number(data.seq) || 1);
    m.activeGroupId = m.group(data.activeGroupId) ? data.activeGroupId : (m.groups[0] ? m.groups[0].id : null);
    const ids = new Set(m.allTabs().map((t) => t.id));
    m.mru = Array.isArray(data.mru) ? data.mru.filter((id) => ids.has(id)) : [];
    m._normalize();
    return m;
  }

  serialize(stateOf = (tab) => tab.state) {
    return {
      version: 1,
      seq: this.seq,
      activeGroupId: this.activeGroupId,
      mru: [...this.mru],
      groups: this.groups.map((g) => ({
        id: g.id,
        size: Math.round(g.size * 10000) / 10000,
        activeTabId: g.activeTabId,
        tabs: g.tabs.map((t) => {
          const out = { id: t.id, kind: t.kind };
          if (t.kind === 'image') out.path = t.path;
          if (t.kind === 'gallery') out.state = clone(stateOf(t) || {});
          return out;
        }),
      })),
    };
  }

  // ---------- queries ----------
  key(p) {
    return this.ci ? String(p).toLowerCase() : String(p);
  }
  group(id) {
    return this.groups.find((g) => g.id === id) || null;
  }
  groupIndex(id) {
    return this.groups.findIndex((g) => g.id === id);
  }
  groupOf(tabId) {
    return this.groups.find((g) => g.tabs.some((t) => t.id === tabId)) || null;
  }
  tab(tabId) {
    for (const g of this.groups) {
      const t = g.tabs.find((x) => x.id === tabId);
      if (t) return t;
    }
    return null;
  }
  allTabs() {
    return this.groups.flatMap((g) => g.tabs);
  }
  activeGroup() {
    return this.group(this.activeGroupId);
  }
  activeTab() {
    const g = this.activeGroup();
    return g ? g.tabs.find((t) => t.id === g.activeTabId) || null : null;
  }
  findSingleton(kind) {
    return this.allTabs().find((t) => t.kind === kind) || null;
  }
  /** Image tab for `path`, preferring `groupId` when given. */
  findImageTab(path, groupId = null) {
    const k = this.key(path);
    const match = (t) => t.kind === 'image' && this.key(t.path) === k;
    if (groupId) {
      const g = this.group(groupId);
      const t = g && g.tabs.find(match);
      if (t) return t;
    }
    return this.allTabs().find(match) || null;
  }
  /** Most recently used gallery tab (or null). */
  mruGallery() {
    for (const id of this.mru) {
      const t = this.tab(id);
      if (t && t.kind === 'gallery') return t;
    }
    return this.allTabs().find((t) => t.kind === 'gallery') || null;
  }

  // ---------- groups ----------
  _newId(prefix) {
    return `${prefix}${this.seq++}`;
  }

  _normalize() {
    const total = this.groups.reduce((s, g) => s + (g.size > 0 ? g.size : 0), 0);
    for (const g of this.groups) g.size = total > 0 && g.size > 0 ? g.size / total : 1 / this.groups.length;
  }

  /** Inserts a new empty group next to `refGroupId` (or appends). Returns it, or null at the limit. */
  addGroup(refGroupId = null, side = 'right') {
    if (this.groups.length >= MAX_GROUPS) return null;
    const g = { id: this._newId('g'), size: 1, tabs: [], activeTabId: null };
    const ref = refGroupId ? this.group(refGroupId) : null;
    if (!ref) {
      g.size = this.groups.length ? 1 / this.groups.length : 1;
      this.groups.push(g);
    } else {
      const half = ref.size / 2;
      ref.size = half;
      g.size = half;
      const i = this.groupIndex(ref.id);
      this.groups.splice(side === 'left' ? i : i + 1, 0, g);
    }
    this._normalize();
    if (!this.activeGroupId) this.activeGroupId = g.id;
    return g;
  }

  _removeGroup(id) {
    const i = this.groupIndex(id);
    if (i < 0) return;
    const [g] = this.groups.splice(i, 1);
    const heir = this.groups[i - 1] || this.groups[i] || null;
    if (heir) heir.size += g.size;
    if (this.activeGroupId === id) this.activeGroupId = heir ? heir.id : null;
    this._normalize();
  }

  setGroupSizes(sizes) {
    if (!Array.isArray(sizes) || sizes.length !== this.groups.length) return;
    this.groups.forEach((g, i) => { g.size = Math.max(0.05, Number(sizes[i]) || 0); });
    this._normalize();
  }

  activateGroup(id) {
    if (this.group(id)) {
      this.activeGroupId = id;
      const g = this.group(id);
      if (g.activeTabId) this._touch(g.activeTabId);
    }
  }

  // ---------- tabs ----------
  _touch(tabId) {
    this.mru = [tabId, ...this.mru.filter((x) => x !== tabId)];
  }

  activateTab(tabId) {
    const g = this.groupOf(tabId);
    if (!g) return;
    g.activeTabId = tabId;
    this.activeGroupId = g.id;
    this._touch(tabId);
  }

  /**
   * Adds a tab. Singletons that already exist are moved to `groupId` instead;
   * an image already open in `groupId` is just activated. Returns the tab.
   */
  addTab(groupId, spec, { index, activate = true } = {}) {
    let g = this.group(groupId);
    if (!g) g = this.activeGroup() || this.groups[0] || this.addGroup();
    if (!KINDS.has(spec.kind)) throw new Error(`unknown tab kind ${spec.kind}`);
    if (SINGLETONS.has(spec.kind)) {
      const existing = this.findSingleton(spec.kind);
      if (existing) {
        if (this.groupOf(existing.id) !== g) this.moveTab(existing.id, g.id, index);
        if (activate) this.activateTab(existing.id);
        return existing;
      }
    }
    if (spec.kind === 'image') {
      const dup = g.tabs.find((t) => t.kind === 'image' && this.key(t.path) === this.key(spec.path));
      if (dup) {
        if (activate) this.activateTab(dup.id);
        return dup;
      }
    }
    const tab = { id: this._newId('t'), kind: spec.kind };
    if (spec.kind === 'image') tab.path = spec.path;
    if (spec.kind === 'gallery') tab.state = clone(spec.state || {});
    const at = index == null ? g.tabs.length : Math.max(0, Math.min(index, g.tabs.length));
    g.tabs.splice(at, 0, tab);
    if (activate || !g.activeTabId) {
      g.activeTabId = tab.id;
      if (activate) this.activateTab(tab.id);
    }
    return tab;
  }

  closeTab(tabId) {
    const g = this.groupOf(tabId);
    if (!g) return;
    const i = g.tabs.findIndex((t) => t.id === tabId);
    g.tabs.splice(i, 1);
    this.mru = this.mru.filter((x) => x !== tabId);
    if (!g.tabs.length) {
      this._removeGroup(g.id);
      return;
    }
    if (g.activeTabId === tabId) {
      // most recently used tab of this group, else the neighbour
      const recent = this.mru.find((id) => g.tabs.some((t) => t.id === id));
      g.activeTabId = recent || (g.tabs[i] || g.tabs[i - 1]).id;
    }
  }

  closeOthers(tabId) {
    const g = this.groupOf(tabId);
    if (!g) return;
    for (const t of [...g.tabs]) if (t.id !== tabId) this.closeTab(t.id);
    this.activateTab(tabId);
  }

  /** Moves a tab into `groupId` at `index` (reorders within the same group). */
  moveTab(tabId, groupId, index) {
    const src = this.groupOf(tabId);
    const dst = this.group(groupId);
    if (!src || !dst) return null;
    const tab = this.tab(tabId);
    const from = src.tabs.indexOf(tab);
    if (src === dst) {
      src.tabs.splice(from, 1);
      let to = index == null ? src.tabs.length : index;
      if (index != null && to > from) to -= 1; // index was computed with the tab still in place
      src.tabs.splice(Math.max(0, Math.min(to, src.tabs.length)), 0, tab);
      this.activateTab(tabId);
      return tab;
    }
    if (tab.kind === 'image') {
      const dup = dst.tabs.find((t) => t.kind === 'image' && this.key(t.path) === this.key(tab.path));
      if (dup) {
        this.closeTab(tabId);
        this.activateTab(dup.id);
        return dup;
      }
    }
    src.tabs.splice(from, 1);
    const at = index == null ? dst.tabs.length : Math.max(0, Math.min(index, dst.tabs.length));
    dst.tabs.splice(at, 0, tab);
    if (!src.tabs.length) {
      this._removeGroup(src.id);
    } else if (src.activeTabId === tabId) {
      const recent = this.mru.find((id) => id !== tabId && src.tabs.some((t) => t.id === id));
      src.activeTabId = recent || (src.tabs[from] || src.tabs[from - 1]).id;
    }
    this.activateTab(tabId);
    return tab;
  }

  /** Drop of a dragged tab onto a group's content: zone = left | right | center. */
  dropTab(tabId, groupId, zone) {
    const src = this.groupOf(tabId);
    const dst = this.group(groupId);
    if (!src || !dst) return null;
    if (zone === 'left' || zone === 'right') {
      if (src === dst && src.tabs.length === 1) return this.tab(tabId); // nothing to split off
      if (this.groups.length < MAX_GROUPS) {
        const g = this.addGroup(dst.id, zone);
        return this.moveTab(tabId, g.id);
      }
    }
    return this.moveTab(tabId, dst.id);
  }

  /**
   * Split a tab to the `side` of its group. Galleries are duplicated (state
   * via `cloneState`), singletons move, image tabs open the same path again.
   * At the group limit the neighbouring group on that side is used.
   */
  splitTab(tabId, side, cloneState = (t) => t.state) {
    const src = this.groupOf(tabId);
    const tab = this.tab(tabId);
    if (!src || !tab) return null;
    let target;
    if (SINGLETONS.has(tab.kind) && src.tabs.length === 1) {
      // moving the only tab would just recreate the same group: reorder instead
      const i = this.groupIndex(src.id);
      const j = side === 'left' ? i - 1 : i + 1;
      if (j < 0 || j >= this.groups.length) return tab;
      const other = this.groups[j];
      this.groups[j] = src;
      this.groups[i] = other;
      this.activateTab(tabId);
      return tab;
    }
    if (this.groups.length < MAX_GROUPS) {
      target = this.addGroup(src.id, side);
    } else {
      const i = this.groupIndex(src.id);
      target = this.groups[side === 'left' ? i - 1 : i + 1] || src;
    }
    if (SINGLETONS.has(tab.kind)) {
      if (target === src) return tab;
      return this.moveTab(tabId, target.id);
    }
    if (tab.kind === 'gallery') {
      return this.addTab(target.id, { kind: 'gallery', state: clone(cloneState(tab)) });
    }
    // image
    if (target === src) { this.activateTab(tabId); return tab; }
    return this.addTab(target.id, { kind: 'image', path: tab.path });
  }

  /** 左/右のグループへ移動: into the neighbour, creating one when missing. */
  moveTabToNeighbor(tabId, dir) {
    const src = this.groupOf(tabId);
    if (!src) return null;
    const i = this.groupIndex(src.id);
    const neighbour = this.groups[dir === 'left' ? i - 1 : i + 1];
    if (neighbour) return this.moveTab(tabId, neighbour.id);
    if (src.tabs.length > 1 && this.groups.length < MAX_GROUPS) {
      const g = this.addGroup(src.id, dir);
      return this.moveTab(tabId, g.id);
    }
    return this.tab(tabId);
  }

  /** Retarget an image tab to a new path (e.g. ←/→ navigation or rename). */
  setTabPath(tabId, path) {
    const t = this.tab(tabId);
    if (t && t.kind === 'image') t.path = path;
  }

  /** Rewrite image-tab paths after a rename/move. `map(path) → newPath|null`. */
  remapPaths(map) {
    let changed = false;
    for (const t of this.allTabs()) {
      if (t.kind !== 'image') continue;
      const n = map(t.path);
      if (n && n !== t.path) { t.path = n; changed = true; }
    }
    return changed;
  }

  cycleTab(delta) {
    const g = this.activeGroup();
    if (!g || !g.tabs.length) return null;
    const i = g.tabs.findIndex((t) => t.id === g.activeTabId);
    const next = g.tabs[(i + delta + g.tabs.length) % g.tabs.length];
    this.activateTab(next.id);
    return next;
  }
}
