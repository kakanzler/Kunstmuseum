// Gallery pane (one per gallery tab): own folder, filters, sort, thumbnail
// size, selection and scroll. Lazy thumbnails, inline rename, drag-out/move.
import {
  api, state, emit, on, saveSettings, setGlobalSelection, tagById, normKey, keyUnder, pathUnder,
  remapUnder, samePath, galleries, applyImageTags,
} from './state.js';
import { el, toast, toastError, showContextMenu, collator, thumbUrl, basename, debounce } from './ui.js';
import { tagChip, sortedTags } from './tags.js';
import {
  checkFileName, renameFileTo, splitName, moveInto, draggedPaths, dragSource, startPathsDrag, DRAG_TYPE,
} from './ops.js';

export const DEFAULT_THUMB = 160;
const MIN_THUMB = 80;
const MAX_THUMB = 400;
const MAX_SAVED_SELECTION = 2000;

/** Initial state for a new gallery tab (inherits the last used view options). */
export function defaultGalleryState(source = null) {
  const s = state.settings;
  return {
    source,
    includeSub: s.includeSubfolders !== false,
    search: '',
    sortKey: s.sortKey || 'name',
    sortDir: s.sortDir === 'desc' ? 'desc' : 'asc',
    tagFilter: [],
    thumbSize: s.thumbSize || DEFAULT_THUMB,
    scrollTop: 0,
    selection: [],
    focus: null,
  };
}

export class GalleryPane {
  constructor(ctx, tab) {
    this.ctx = ctx;
    this.kind = 'gallery';
    this.tabId = tab.id;
    this.id = tab.id;
    const st = { ...defaultGalleryState(), ...(tab.state || {}) };
    this.source = st.source && (st.source.kind === 'tagged' || (st.source.kind === 'folder' && st.source.path)) ? st.source : null;
    this.includeSub = st.includeSub !== false;
    this.search = st.search || '';
    this.sortKey = ['name', 'mtime', 'size'].includes(st.sortKey) ? st.sortKey : 'name';
    this.sortDir = st.sortDir === 'desc' ? 'desc' : 'asc';
    this.tagFilter = Array.isArray(st.tagFilter) ? st.tagFilter : [];
    this.thumbSize = Number(st.thumbSize) || DEFAULT_THUMB;
    this.scrollTop = Number(st.scrollTop) || 0;
    this.selection = new Set(Array.isArray(st.selection) ? st.selection : []);
    this.focus = st.focus || null;
    this.anchor = this.focus;
    this.items = [];
    this.itemsByPath = new Map();
    this.view = [];
    this.tileByPath = new Map();
    this.loadToken = 0;
    this.renaming = false;
    this.pendingRefresh = false;
    this.visible = false;
    this.loaded = false;

    this._build();
    this._bind();
    galleries.set(this.id, this);
    this.offs = [
      on('lib-changed', () => this.renderTagFilter()),
      on('image-tags-changed', () => { if (this.tagFilter.length) this.applyView({ keepScroll: true }); }),
      on('tags-structure-changed', () => this.refreshItemTags()),
      on('fs-changed', (dirs) => this.onFsChanged(dirs)),
      on('paths-renamed', (renames) => this.onRenamed(renames)),
      on('paths-moved', ({ moved, dest }) => this.onMoved(moved, dest)),
      on('folder-renamed', ({ from, to }) => this.onFolderRenamed(from, to)),
      on('roots-changed', () => this.onRootsChanged()),
    ];
    this.setThumbSize(this.thumbSize, false);
    this.renderTagFilter();
    this.loadPromise = this.load({ restoreScroll: true });
  }

  // ---------- DOM ----------
  _build() {
    const q = (cls) => this.el.querySelector(cls);
    this.el = el('div', { class: 'pane gallery-pane' });
    this.el.innerHTML = `
      <div class="toolbar">
        <div class="title-block"><div class="gallery-title"></div><div class="gallery-count muted small"></div></div>
        <input class="input search" type="search" placeholder="ファイル名で検索" spellcheck="false">
        <label class="field-inline">並び順
          <select class="input sort-key">
            <option value="name">名前</option><option value="mtime">更新日時</option><option value="size">サイズ</option>
          </select>
        </label>
        <button class="btn icon sort-dir" title="昇順 / 降順">↑</button>
        <label class="toggle"><input class="include-sub" type="checkbox"> サブフォルダを含む</label>
        <label class="field-inline" title="サムネイルの大きさ（Ctrl+ホイール / Ctrl+0 / 中クリック）">サイズ
          <input class="thumb-size" type="range" min="${MIN_THUMB}" max="${MAX_THUMB}" step="8">
        </label>
        <button class="btn refresh">更新</button>
      </div>
      <div class="filterbar">
        <span class="muted small">タグで絞り込み:</span>
        <div class="chips tag-filter-chips"></div>
        <select class="input small-select tag-filter-add"></select>
        <button class="btn subtle small tag-filter-clear hidden">解除</button>
      </div>
      <div class="grid-wrap">
        <div class="grid" tabindex="0"></div>
        <div class="empty-state"></div>
      </div>`;
    this.titleEl = q('.gallery-title');
    this.countEl = q('.gallery-count');
    this.searchEl = q('.search');
    this.sortKeyEl = q('.sort-key');
    this.sortDirEl = q('.sort-dir');
    this.includeEl = q('.include-sub');
    this.sliderEl = q('.thumb-size');
    this.chipsEl = q('.tag-filter-chips');
    this.filterAddEl = q('.tag-filter-add');
    this.filterClearEl = q('.tag-filter-clear');
    this.gridWrap = q('.grid-wrap');
    this.grid = q('.grid');
    this.emptyEl = q('.empty-state');

    this.searchEl.value = this.search;
    this.sortKeyEl.value = this.sortKey;
    this.includeEl.checked = this.includeSub;
    this._paintDir();
  }

  _bind() {
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target;
        this.observer.unobserve(img);
        if (!img.src && img.dataset.src) img.src = img.dataset.src;
      }
    }, { root: this.grid, rootMargin: '600px 0px' });

    const applySearch = debounce(() => { this.search = this.searchEl.value; this.applyView(); this.changed(); }, 150);
    this.searchEl.addEventListener('input', applySearch);
    this.searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.searchEl.value) {
        this.searchEl.value = '';
        this.search = '';
        this.applyView();
        this.changed();
        e.stopPropagation();
      }
    });
    this.sortKeyEl.addEventListener('change', () => {
      this.sortKey = this.sortKeyEl.value;
      saveSettings({ sortKey: this.sortKey });
      this.applyView();
      this.changed();
    });
    this.sortDirEl.addEventListener('click', () => {
      this.sortDir = this.sortDir === 'desc' ? 'asc' : 'desc';
      saveSettings({ sortDir: this.sortDir });
      this._paintDir();
      this.applyView();
      this.changed();
    });
    this.includeEl.addEventListener('change', () => {
      this.includeSub = this.includeEl.checked;
      saveSettings({ includeSubfolders: this.includeSub });
      this.reload();
      this.changed();
    });
    this.sliderEl.addEventListener('input', () => this.setThumbSize(Number(this.sliderEl.value)));
    this.el.querySelector('.refresh').addEventListener('click', () => {
      this.reload();
      emit('refresh-requested');
    });
    this.filterAddEl.addEventListener('change', () => {
      const id = this.filterAddEl.value;
      this.filterAddEl.value = '';
      if (id && !this.tagFilter.includes(id)) this.setTagFilter([...this.tagFilter, id]);
    });
    this.filterClearEl.addEventListener('click', () => this.setTagFilter([]));

    const g = this.grid;
    g.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); this.resetZoom(); return; }
      g.focus({ preventScroll: true });
    });
    g.addEventListener('click', (e) => this._onClick(e));
    g.addEventListener('dblclick', (e) => {
      const i = this._tileIndex(e.target);
      if (i >= 0) this.ctx.openImage(this.view[i].path, { fromPane: this });
    });
    g.addEventListener('contextmenu', (e) => this._onContextMenu(e));
    g.addEventListener('dragstart', (e) => this._onDragStart(e));
    g.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setThumbSize(this.thumbSize + (e.deltaY < 0 ? 16 : -16));
    }, { passive: false });
    g.addEventListener('scroll', () => {
      if (this.visible && g.isConnected && g.clientHeight) {
        this.scrollTop = g.scrollTop;
        this.changedLater();
      }
    });

    // drop target: move dragged images into this gallery's folder
    const wrap = this.gridWrap;
    const accepts = (e) => e.dataTransfer.types.includes(DRAG_TYPE)
      && this.source && this.source.kind === 'folder'
      && dragSource(e) !== String(this.id).toLowerCase();
    wrap.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      wrap.classList.add('drop-target');
    });
    wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('drop-target'); });
    wrap.addEventListener('drop', async (e) => {
      wrap.classList.remove('drop-target');
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const paths = draggedPaths(e);
      if (paths && paths.length) await moveInto(paths, this.source.path, { quietUnchanged: true });
    });
  }

  _paintDir() {
    this.sortDirEl.textContent = this.sortDir === 'desc' ? '↓' : '↑';
    this.sortDirEl.title = this.sortDir === 'desc' ? '降順（クリックで昇順）' : '昇順（クリックで降順）';
  }

  // ---------- pane interface ----------
  title() {
    if (!this.source) return 'ギャラリー';
    if (this.source.kind === 'tagged') return '全フォルダ（タグ付き画像）';
    return basename(this.source.path) || this.source.path;
  }
  get italic() {
    return false;
  }
  serialize() {
    return {
      source: this.source,
      includeSub: this.includeSub,
      search: this.search,
      sortKey: this.sortKey,
      sortDir: this.sortDir,
      tagFilter: [...this.tagFilter],
      thumbSize: this.thumbSize,
      scrollTop: Math.round(this.scrollTop),
      selection: this.selectedPaths().slice(0, MAX_SAVED_SELECTION),
      focus: this.focus,
    };
  }
  onShow() {
    this.visible = true;
    // re-attaching a node resets its scroll offset
    requestAnimationFrame(() => {
      if (this.grid.scrollTop !== this.scrollTop) this.grid.scrollTop = this.scrollTop;
    });
  }
  onHide() {
    this.visible = false;
  }
  resetZoom() {
    this.setThumbSize(DEFAULT_THUMB);
  }
  dispose() {
    this.offs.forEach((f) => f());
    this.observer.disconnect();
    galleries.delete(this.id);
    this.loadToken++;
  }
  changed() {
    this.ctx.stateChanged(this);
  }
  changedLater() {
    clearTimeout(this._chTimer);
    this._chTimer = setTimeout(() => this.changed(), 400);
  }

  // ---------- thumbnail size ----------
  setThumbSize(px, persist = true) {
    const v = Math.max(MIN_THUMB, Math.min(MAX_THUMB, Math.round(px)));
    this.thumbSize = v;
    this.el.style.setProperty('--thumb', `${v}px`);
    this.sliderEl.value = String(v);
    if (persist) {
      saveSettings({ thumbSize: v });
      this.changed();
    }
  }

  // ---------- loading ----------
  setSource(source) {
    const same = (this.source && source && this.source.kind === source.kind
      && (source.kind === 'tagged' || samePath(this.source.path, source.path)));
    this.source = source;
    if (!same) {
      this.selection = new Set();
      this.focus = null;
      this.anchor = null;
      this.scrollTop = 0;
    }
    this.ctx.titleChanged(this);
    this.changed();
    return this.load({ preserve: same });
  }

  reload(opts = {}) {
    return this.load({ preserve: true, quiet: true, ...opts });
  }

  async load({ preserve = true, quiet = false, restoreScroll = false } = {}) {
    const token = ++this.loadToken;
    const scroll = restoreScroll ? this.scrollTop : (preserve ? this.grid.scrollTop || this.scrollTop : 0);
    let items = [];
    if (this.source) {
      if (!quiet) this._setEmpty('読み込み中…');
      try {
        if (this.source.kind === 'folder') items = await api.scan(this.source.path, this.includeSub);
        else items = await api.listTagged();
      } catch (e) {
        if (token !== this.loadToken) return;
        if (!quiet) toastError(e, 'フォルダを読み込めませんでした。');
        items = [];
      }
    }
    if (token !== this.loadToken) return;
    this.items = items;
    this.itemsByPath = new Map(items.map((it) => [it.path, it]));
    this.selection = new Set([...this.selection].filter((p) => this.itemsByPath.has(p)));
    if (this.focus && !this.itemsByPath.has(this.focus)) this.focus = null;
    if (this.anchor && !this.itemsByPath.has(this.anchor)) this.anchor = null;
    this.loaded = true;
    this.titleEl.textContent = this.title();
    this.titleEl.title = this.source && this.source.kind === 'folder' ? this.source.path : '';
    this.applyView({ scrollTop: scroll });
    // keep the global selection in step when it came from this gallery
    const o = state.selection.origin;
    if (o && o.kind === 'gallery' && o.paneId === this.id) this._emitSelection(state.selection.primary);
  }

  isShowingDir(dir) {
    if (!this.source || this.source.kind !== 'folder') return false;
    const k = normKey(dir);
    const src = normKey(this.source.path);
    return this.includeSub ? keyUnder(k, src) : k === src;
  }

  onFsChanged(dirs) {
    if (!this.source) return;
    const hit = this.source.kind === 'tagged' || dirs.some((d) => this.isShowingDir(d));
    if (!hit) return;
    if (this.renaming) this.pendingRefresh = true;
    else this.reload();
  }

  onRenamed(renames) {
    let touched = false;
    for (const { from, to } of renames) {
      const it = this.itemsByPath.get(from);
      if (!it) continue;
      touched = true;
      const upd = { ...it, path: to, name: basename(to) };
      const i = this.items.indexOf(it);
      if (i >= 0) this.items[i] = upd;
      this.itemsByPath.delete(from);
      this.itemsByPath.set(to, upd);
      if (this.selection.delete(from)) this.selection.add(to);
      if (this.anchor === from) this.anchor = to;
      if (this.focus === from) this.focus = to;
    }
    if (touched) {
      this.applyView({ keepScroll: true });
      this.changed();
    }
  }

  onMoved(moved, dest) {
    if (!this.source) return;
    const affects = this.source.kind === 'tagged'
      || moved.some((m) => this.itemsByPath.has(m.from))
      || this.isShowingDir(dest);
    if (!affects) return;
    for (const m of moved) this.selection.delete(m.from);
    this.reload();
  }

  onFolderRenamed(from, to) {
    if (!this.source) return;
    if (this.source.kind === 'folder') {
      const n = remapUnder(this.source.path, from, to);
      if (n) {
        this.source = { kind: 'folder', path: n };
        this.selection = new Set([...this.selection].map((p) => remapUnder(p, from, to) || p));
        if (this.focus) this.focus = remapUnder(this.focus, from, to) || this.focus;
        if (this.anchor) this.anchor = remapUnder(this.anchor, from, to) || this.anchor;
        this.ctx.titleChanged(this);
        this.changed();
        this.reload();
        return;
      }
      if (this.includeSub && pathUnder(from, this.source.path)) { this.reload(); return; }
    }
    if (this.source.kind === 'tagged') this.reload();
  }

  onRootsChanged() {
    if (this.source && this.source.kind === 'folder' && !state.roots.some((r) => pathUnder(this.source.path, r.path))) {
      this.setSource(null);
    }
  }

  /** Re-read tag ids for all loaded items (after merge/delete in タグ管理). */
  async refreshItemTags() {
    if (!this.items.length) return;
    try {
      applyImageTags(await api.getImageTags(this.items.map((it) => it.path)));
    } catch (e) {
      toastError(e);
    }
  }

  // ---------- filter & sort ----------
  setTagFilter(ids) {
    this.tagFilter = ids.filter((id) => tagById(id));
    this.renderTagFilter();
    this.applyView();
    this.changed();
  }

  renderTagFilter() {
    this.tagFilter = this.tagFilter.filter((id) => tagById(id));
    this.chipsEl.innerHTML = '';
    for (const id of this.tagFilter) {
      this.chipsEl.append(tagChip(tagById(id), { onRemove: () => this.setTagFilter(this.tagFilter.filter((x) => x !== id)) }));
    }
    if (!this.tagFilter.length) this.chipsEl.append(el('span', { class: 'muted small' }, 'なし'));
    this.filterClearEl.classList.toggle('hidden', !this.tagFilter.length);
    const sel = this.filterAddEl;
    sel.innerHTML = '';
    sel.append(el('option', { value: '' }, state.lib.tags.length ? '＋ タグを追加…' : '（タグがありません）'));
    for (const type of state.lib.tagTypes) {
      const tags = sortedTags().filter((t) => t.typeId === type.id && !this.tagFilter.includes(t.id));
      if (!tags.length) continue;
      const g = el('optgroup', { label: type.name });
      for (const t of tags) g.append(el('option', { value: t.id }, `${t.name}（${state.lib.usage[t.id] || 0}）`));
      sel.append(g);
    }
  }

  applyView({ keepScroll = false, scrollTop } = {}) {
    const q = this.search.trim().toLowerCase();
    const filter = this.tagFilter;
    const view = this.items.filter((it) => {
      if (q && !it.name.toLowerCase().includes(q)) return false;
      if (filter.length) {
        const tags = it.tags || [];
        for (const id of filter) if (!tags.includes(id)) return false;
      }
      return true;
    });
    const key = this.sortKey;
    const dir = this.sortDir === 'desc' ? -1 : 1;
    view.sort((a, b) => {
      let c = 0;
      if (key === 'mtime') c = a.mtime - b.mtime;
      else if (key === 'size') c = a.size - b.size;
      if (c === 0) c = collator.compare(a.name, b.name) || collator.compare(a.path, b.path);
      return c * dir;
    });
    this.view = view;
    const st = keepScroll ? (this.grid.scrollTop || this.scrollTop) : scrollTop;
    this._renderGrid();
    if (st) {
      this.grid.scrollTop = st;
      this.scrollTop = st;
    }
    this._renderCount();
    emit('gallery-view-changed', this.id);
  }

  _renderCount() {
    const total = this.items.length;
    const shown = this.view.length;
    const sel = this.selection.size;
    let s = shown === total ? `${total}枚` : `${shown} / ${total}枚`;
    if (sel) s += `・${sel}枚選択`;
    this.countEl.textContent = this.source ? s : '';
  }

  _setEmpty(msg) {
    this.emptyEl.textContent = msg || '';
  }

  _renderGrid() {
    this.observer.disconnect();
    this.tileByPath = new Map();
    const frag = document.createDocumentFragment();
    this.view.forEach((it, i) => {
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      img.dataset.src = thumbUrl(it);
      img.addEventListener('error', () => img.classList.add('broken'), { once: true });
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.append(img);
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.textContent = it.name;
      cap.title = it.name;
      const tile = document.createElement('div');
      tile.className = 'tile';
      if (this.selection.has(it.path)) tile.classList.add('selected');
      if (this.focus === it.path) tile.classList.add('focused');
      tile.dataset.i = String(i);
      tile.draggable = true;
      tile.append(thumb, cap);
      frag.append(tile);
      this.tileByPath.set(it.path, tile);
      this.observer.observe(img);
    });
    this.grid.replaceChildren(frag);
    if (!this.source) this._setEmpty('サイドバーでフォルダを選択してください。\nフォルダは「フォルダを追加」またはエクスプローラーからのドロップで登録できます。');
    else if (!this.items.length) this._setEmpty(this.source.kind === 'tagged' ? 'タグ付けされた画像がありません。' : 'このフォルダには対応する画像がありません。');
    else if (!this.view.length) this._setEmpty('条件に一致する画像がありません。');
    else this._setEmpty('');
  }

  // ---------- selection ----------
  _tileIndex(target) {
    const tile = target && target.closest && target.closest('.tile');
    return tile ? Number(tile.dataset.i) : -1;
  }

  _paintSelection() {
    for (const [p, tile] of this.tileByPath) {
      tile.classList.toggle('selected', this.selection.has(p));
      tile.classList.toggle('focused', this.focus === p);
    }
    this._renderCount();
  }

  selectedPaths() {
    return this.view.filter((it) => this.selection.has(it.path)).map((it) => it.path);
  }

  _emitSelection(primary) {
    const paths = this.selectedPaths();
    setGlobalSelection({
      paths,
      primary: primary && this.selection.has(primary) ? primary : (this.focus && this.selection.has(this.focus) ? this.focus : paths[paths.length - 1]),
      origin: { kind: 'gallery', paneId: this.id },
    });
  }

  _selectionChanged(primary, emitGlobal = true) {
    this._paintSelection();
    if (emitGlobal) this._emitSelection(primary);
    this.changedLater();
  }

  selectIndex(i, { toggle = false, range = false } = {}) {
    const it = this.view[i];
    if (!it) return;
    if (range && this.anchor && this.itemsByPath.has(this.anchor)) {
      const a = this.view.findIndex((x) => x.path === this.anchor);
      const [lo, hi] = a < i ? [a, i] : [i, a];
      if (!toggle) this.selection = new Set();
      for (let k = lo; k <= hi; k++) this.selection.add(this.view[k].path);
    } else if (toggle) {
      if (this.selection.has(it.path)) this.selection.delete(it.path);
      else this.selection.add(it.path);
      this.anchor = it.path;
    } else {
      this.selection = new Set([it.path]);
      this.anchor = it.path;
    }
    this.focus = it.path;
    this._selectionChanged(it.path);
  }

  selectAll() {
    this.selection = new Set(this.view.map((it) => it.path));
    this._selectionChanged(this.focus);
  }

  clearSelection() {
    this.selection = new Set();
    this.anchor = null;
    this._selectionChanged(null);
  }

  /** Select paths programmatically (`emit`: also make it the global selection). */
  selectPaths(paths, { emit: emitGlobal = true, scroll = true } = {}) {
    const set = new Set(paths.filter((p) => this.itemsByPath.has(p)));
    this.selection = set;
    const last = paths.filter((p) => set.has(p)).pop() || null;
    this.anchor = last;
    this.focus = last;
    this._selectionChanged(last, emitGlobal);
    if (last && scroll) this.scrollToPath(last);
  }

  scrollToPath(p) {
    const tile = this.tileByPath.get(p);
    if (tile) tile.scrollIntoView({ block: 'nearest' });
  }

  _onClick(e) {
    const i = this._tileIndex(e.target);
    if (i < 0) {
      if (e.target === this.grid && !e.ctrlKey && !e.shiftKey) this.clearSelection();
      return;
    }
    if (e.target.closest('.cap input')) return;
    this.selectIndex(i, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });
  }

  _onContextMenu(e) {
    const i = this._tileIndex(e.target);
    if (i < 0) return;
    e.preventDefault();
    const it = this.view[i];
    if (!this.selection.has(it.path)) this.selectIndex(i);
    const paths = this.selectedPaths();
    const multi = paths.length > 1;
    showContextMenu(e.clientX, e.clientY, [
      { label: '開く', action: () => this.ctx.openImage(it.path, { fromPane: this }) },
      { label: '名前の変更', disabled: multi, action: () => this.startRename(it) },
      { separator: true },
      { label: 'エクスプローラーで表示', action: () => api.showItem(it.path) },
      {
        label: multi ? `パスをコピー（${paths.length}件）` : 'パスをコピー',
        action: async () => { await api.copyText(paths.join('\r\n')); toast('パスをコピーしました。', 'success', 1800); },
      },
    ]);
  }

  // ---------- keyboard ----------
  _columns() {
    const first = this.grid.querySelector('.tile');
    if (!first) return 1;
    const w = first.getBoundingClientRect().width + 10;
    return Math.max(1, Math.floor((this.grid.clientWidth - 28 + 10) / w));
  }

  handleKey(e) {
    if (this.renaming) return false;
    const n = this.view.length;
    const cur = this.focus ? this.view.findIndex((it) => it.path === this.focus) : -1;
    const move = (delta) => {
      if (!n) return;
      const next = cur < 0 ? 0 : Math.max(0, Math.min(n - 1, cur + delta));
      this.selectIndex(next, { range: e.shiftKey });
      this.scrollToPath(this.view[next].path);
    };
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); this.selectAll(); return true; }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); move(1); return true;
      case 'ArrowLeft': e.preventDefault(); move(-1); return true;
      case 'ArrowDown': e.preventDefault(); move(this._columns()); return true;
      case 'ArrowUp': e.preventDefault(); move(-this._columns()); return true;
      case 'Home': e.preventDefault(); move(-n); return true;
      case 'End': e.preventDefault(); move(n); return true;
      case 'Enter': {
        const i = cur >= 0 ? cur : this.view.findIndex((it) => this.selection.has(it.path));
        if (i >= 0) { e.preventDefault(); this.ctx.openImage(this.view[i].path, { fromPane: this }); }
        return true;
      }
      case 'F2': {
        e.preventDefault();
        const paths = this.selectedPaths();
        const target = this.focus && this.selection.has(this.focus) ? this.focus : paths[0];
        if (paths.length > 1) toast('名前の変更は1枚ずつ行ってください。');
        else if (target) this.startRename(this.itemsByPath.get(target));
        return true;
      }
      case 'Escape':
        if (this.selection.size) { this.clearSelection(); return true; }
        return false;
      default:
        return false;
    }
  }

  // ---------- inline rename ----------
  startRename(item) {
    if (!item) return;
    const tile = this.tileByPath.get(item.path);
    if (!tile) return;
    this.scrollToPath(item.path);
    const cap = tile.querySelector('.cap');
    const input = el('input', { class: 'input', value: item.name, spellcheck: 'false' });
    cap.replaceChildren(input);
    this.renaming = true;
    input.focus();
    input.setSelectionRange(0, splitName(item.name));
    let finished = false;
    const finish = async (commit) => {
      if (finished) return;
      finished = true;
      const v = input.value;
      if (commit && v !== item.name) {
        const err = await checkFileName(item.name, v);
        if (err) {
          toast(err, 'error');
          finished = false;
          input.focus();
          return;
        }
        this.renaming = false;
        const to = await renameFileTo(item.path, v);
        if (!to) cap.textContent = item.name;
      } else {
        this.renaming = false;
        cap.textContent = item.name;
      }
      this.grid.focus({ preventScroll: true });
      if (this.pendingRefresh) { this.pendingRefresh = false; this.reload(); }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => { if (!finished) finish(true); });
    for (const t of ['mousedown', 'click', 'dblclick']) input.addEventListener(t, (e) => e.stopPropagation());
  }

  // ---------- drag out ----------
  _onDragStart(e) {
    const i = this._tileIndex(e.target);
    if (i < 0 || this.renaming) { e.preventDefault(); return; }
    const it = this.view[i];
    if (!this.selection.has(it.path)) this.selectIndex(i);
    startPathsDrag(e, this.selectedPaths(), this.id);
  }
}
