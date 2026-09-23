// 知識グラフ pane (singleton tab): cytoscape view of tags and tagged images.
import { api, state, on, saveSettings, setGlobalSelection } from './state.js';
import { el, toastError, thumbUrl, basename, extname, collator } from './ui.js';

/* global cytoscape */

function graphSettings() {
  const g = state.settings.graph || {};
  return { scope: g.scope || 'folder', mode: g.mode || 'bipartite', hiddenTypes: Array.isArray(g.hiddenTypes) ? g.hiddenTypes : [] };
}
function saveGraph(partial) {
  saveSettings({ graph: { ...graphSettings(), ...partial } });
}

function tagSize(count) {
  return Math.min(90, 18 + 9 * Math.sqrt(count));
}

export class GraphPane {
  constructor(ctx, tab) {
    this.ctx = ctx;
    this.kind = 'graph';
    this.tabId = tab.id;
    this.cy = null;
    this.dirty = true;
    this.visible = false;
    this.pinned = null;
    this.building = null;
    this.imageList = [];

    this.el = el('div', { class: 'pane graph-pane' });
    this.el.innerHTML = `
      <div class="toolbar">
        <label class="field-inline">範囲
          <select class="input graph-scope">
            <option value="folder">現在のフォルダ</option>
            <option value="all">全フォルダ</option>
          </select>
        </label>
        <div class="segmented graph-mode">
          <button data-mode="bipartite">画像+タグ</button>
          <button data-mode="cooccur">タグ共起のみ</button>
        </div>
        <div class="type-checks graph-types"></div>
        <input class="input search graph-search" type="search" placeholder="ノードを検索（Enter）" spellcheck="false">
        <button class="btn graph-relayout">レイアウト再計算</button>
        <button class="btn graph-fit">全体表示</button>
      </div>
      <div class="graph-wrap">
        <div class="cy"></div>
        <div class="empty-state hidden graph-empty"></div>
        <div class="graph-status muted small"></div>
      </div>`;
    const q = (c) => this.el.querySelector(c);
    this.scopeEl = q('.graph-scope');
    this.modeEl = q('.graph-mode');
    this.typesEl = q('.graph-types');
    this.searchEl = q('.graph-search');
    this.container = q('.cy');
    this.emptyEl = q('.graph-empty');
    this.statusEl = q('.graph-status');

    const gs = graphSettings();
    this.scopeEl.value = gs.scope;
    this.scopeEl.addEventListener('change', () => { saveGraph({ scope: this.scopeEl.value }); this.rebuild(); });
    for (const b of this.modeEl.querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.mode === gs.mode);
      b.addEventListener('click', () => {
        saveGraph({ mode: b.dataset.mode });
        for (const x of this.modeEl.querySelectorAll('button')) x.classList.toggle('active', x === b);
        this.rebuild();
      });
    }
    q('.graph-relayout').addEventListener('click', () => this.runLayout());
    q('.graph-fit').addEventListener('click', () => this.fit());
    this.searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.focusSearch(this.searchEl.value); }
      if (e.key === 'Escape') { this.searchEl.value = ''; this.clearHighlight(); this.pinned = null; e.stopPropagation(); }
    });

    this.container.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.cy) return;
      const r = this.container.getBoundingClientRect();
      if (e.ctrlKey) {
        const cy = this.cy;
        const level = Math.max(cy.minZoom(), Math.min(cy.maxZoom(), cy.zoom() * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        cy.zoom({ level, renderedPosition: { x: e.clientX - r.left, y: e.clientY - r.top } });
      } else {
        this.cy.panBy({ x: -(e.shiftKey ? e.deltaY : e.deltaX), y: e.shiftKey ? 0 : -e.deltaY });
      }
    }, { passive: false, capture: true });
    this.container.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); this.fit(); }
    }, true);

    const markDirty = () => {
      this.dirty = true;
      if (this.visible) this.rebuild();
    };
    this.offs = [
      on('lib-changed', () => { this.renderTypeChecks(); markDirty(); }),
      on('image-tags-changed', markDirty),
      on('paths-renamed', markDirty),
      on('paths-moved', markDirty),
      on('folder-renamed', markDirty),
      on('mru-gallery-changed', () => { if (graphSettings().scope === 'folder') markDirty(); }),
    ];
    this.renderTypeChecks();
  }

  // ---------- pane interface ----------
  title() {
    return '知識グラフ';
  }
  get italic() {
    return false;
  }
  onShow() {
    this.visible = true;
    if (this.dirty || !this.cy) this.rebuild();
    else requestAnimationFrame(() => this.cy && this.cy.resize());
  }
  onHide() {
    this.visible = false;
  }
  resetZoom() {
    this.fit();
  }
  handleKey(e) {
    if (e.key === 'Escape' && this.pinned) { this.pinned = null; this.clearHighlight(); return true; }
    return false;
  }
  dispose() {
    this.offs.forEach((f) => f());
    const cy = this.cy;
    this.cy = null;
    if (!cy) return;
    // cose's stop() only flags the layout: its already-queued animation frame
    // still runs once and repositions nodes. Destroy after that frame.
    this.stopLayout();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try { cy.destroy(); } catch { /* ignore */ }
    }));
  }

  stopLayout() {
    if (this.layoutRun) {
      try { this.layoutRun.stop(); } catch { /* already finished */ }
      this.layoutRun = null;
    }
  }

  nodeCount() {
    return this.cy ? this.cy.nodes().length : 0;
  }

  // ---------- building ----------
  renderTypeChecks() {
    const hidden = new Set(graphSettings().hiddenTypes);
    this.typesEl.replaceChildren(...state.lib.tagTypes.map((t) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !hidden.has(t.id);
      cb.addEventListener('change', () => {
        const h = new Set(graphSettings().hiddenTypes);
        if (cb.checked) h.delete(t.id); else h.add(t.id);
        saveGraph({ hiddenTypes: [...h] });
        this.rebuild();
      });
      return el('label', { title: `種類「${t.name}」を表示` }, cb, el('span', { class: 'dot', style: { background: t.color } }), t.name);
    }));
  }

  scopeDir() {
    if (graphSettings().scope !== 'folder') return null;
    const g = this.ctx.mruGalleryPane();
    return g && g.source && g.source.kind === 'folder' ? g.source.path : null;
  }

  async rebuild() {
    this.dirty = false;
    const run = (async () => {
      let data;
      try {
        data = await api.graphData(this.scopeDir());
      } catch (e) {
        toastError(e, 'グラフを作成できませんでした。');
        return;
      }
      if (!this.el.isConnected) { this.dirty = true; return; }
      this.build(data);
    })();
    this.building = run;
    await run;
    if (this.building === run) this.building = null;
  }

  build(data) {
    const gs = graphSettings();
    const hidden = new Set(gs.hiddenTypes);
    const tagMap = new Map(data.tags.filter((t) => !hidden.has(t.typeId)).map((t) => [t.id, t]));
    const typeColor = new Map(data.tagTypes.map((t) => [t.id, t.color]));
    const elements = [];
    const counts = new Map();
    const images = [];
    for (const img of data.images) {
      const tags = img.tags.filter((id) => tagMap.has(id));
      if (!tags.length) continue;
      images.push({ path: img.path, tags });
      for (const id of tags) counts.set(id, (counts.get(id) || 0) + 1);
    }
    images.sort((a, b) => collator.compare(basename(a.path), basename(b.path)));
    this.imageList = images.map((im) => ({ path: im.path, name: basename(im.path), ext: extname(basename(im.path)) }));

    for (const [id, count] of counts) {
      const t = tagMap.get(id);
      elements.push({
        group: 'nodes',
        data: { id: `t:${id}`, kind: 'tag', tagId: id, label: t.name, color: typeColor.get(t.typeId) || '#888', size: tagSize(count), count },
        classes: 'tag',
      });
    }
    if (gs.mode === 'bipartite') {
      images.forEach((im, i) => {
        const nid = `i:${i}`;
        elements.push({ group: 'nodes', data: { id: nid, kind: 'image', path: im.path, label: basename(im.path), thumb: thumbUrl({ path: im.path }) }, classes: 'image' });
        for (const id of im.tags) elements.push({ group: 'edges', data: { id: `e:${i}:${id}`, source: nid, target: `t:${id}`, width: 1 } });
      });
    } else {
      const pairs = new Map();
      for (const im of images) {
        const ids = [...new Set(im.tags)].sort();
        for (let a = 0; a < ids.length; a++) {
          for (let b = a + 1; b < ids.length; b++) {
            const k = `${ids[a]}|${ids[b]}`;
            pairs.set(k, (pairs.get(k) || 0) + 1);
          }
        }
      }
      for (const [k, n] of pairs) {
        const [a, b] = k.split('|');
        elements.push({ group: 'edges', data: { id: `c:${k}`, source: `t:${a}`, target: `t:${b}`, width: Math.min(14, 0.8 + n * 0.9), count: n } });
      }
    }

    if (!counts.size) {
      this.emptyEl.textContent = data.images.length
        ? '表示対象の種類にタグ付き画像がありません。上のチェックボックスで種類を選択してください。'
        : 'タグ付けされた画像がありません。ギャラリーで画像を選択し、右パネルからタグを追加してください。';
      this.emptyEl.classList.remove('hidden');
    } else {
      this.emptyEl.classList.add('hidden');
    }

    if (!this.cy) this.createCy();
    this.stopLayout();
    this.pinned = null;
    this.cy.resize();
    this.cy.batch(() => {
      this.cy.elements().remove();
      this.cy.add(elements);
    });
    this.statusEl.textContent = counts.size
      ? `タグ ${counts.size}${gs.mode === 'bipartite' ? `・画像 ${images.length}` : `・共起 ${this.cy.edges().length}`}`
      : '';
    this.runLayout();
  }

  createCy() {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c8a45a';
    const cy = cytoscape({
      container: this.container,
      userZoomingEnabled: false, // Ctrl+wheel handled manually
      boxSelectionEnabled: false,
      minZoom: 0.05,
      maxZoom: 6,
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)', color: '#e6e3dc', 'font-size': 11, 'text-valign': 'center', 'text-halign': 'center',
            'text-outline-color': '#0e0e0f', 'text-outline-width': 2, 'min-zoomed-font-size': 7,
            'transition-property': 'opacity', 'transition-duration': 120,
          },
        },
        { selector: 'node.tag', style: { 'background-color': 'data(color)', width: 'data(size)', height: 'data(size)', 'border-width': 1.5, 'border-color': '#0e0e0f' } },
        {
          selector: 'node.image',
          style: {
            shape: 'round-rectangle', width: 26, height: 26, label: '', 'background-color': '#2a2a2f',
            'background-image': 'data(thumb)', 'background-fit': 'cover', 'background-clip': 'node',
            // kmimg: is not CORS-enabled; load without crossorigin (canvas is never exported)
            'background-image-crossorigin': 'null',
            'border-width': 1, 'border-color': '#4a4a52',
          },
        },
        { selector: 'node.image.hl', style: { label: 'data(label)', 'text-valign': 'bottom', 'text-margin-y': 4, 'font-size': 8 } },
        { selector: 'edge', style: { width: 'data(width)', 'line-color': '#4a4a52', 'curve-style': 'haystack', opacity: 0.55 } },
        { selector: '.faded', style: { opacity: 0.08 } },
        { selector: 'edge.hl', style: { 'line-color': accent, opacity: 0.95 } },
        { selector: 'node.hl', style: { 'border-color': accent, 'border-width': 2 } },
        { selector: 'node.focus', style: { 'border-color': '#ffffff', 'border-width': 3 } },
      ],
    });
    cy.on('mouseover', 'node', (e) => { if (!this.pinned) this.highlight(e.target); });
    cy.on('mouseout', 'node', () => { if (!this.pinned) this.clearHighlight(); });
    cy.on('tap', 'node', (e) => {
      const n = e.target;
      this.pinned = n;
      this.highlight(n);
      if (n.data('kind') === 'image') this.selectImage(n.data('path'));
    });
    cy.on('tap', (e) => { if (e.target === cy) { this.pinned = null; this.clearHighlight(); } });
    cy.on('dbltap', 'node', (e) => {
      const n = e.target;
      if (n.data('kind') === 'image') {
        this.ctx.openImage(n.data('path'), { fromPane: this, list: this.imageList });
      } else if (n.data('kind') === 'tag') {
        this.ctx.showTagInGallery(n.data('tagId'), graphSettings().scope);
      }
    });
    this.cy = cy;
  }

  selectImage(p) {
    setGlobalSelection({ paths: [p], primary: p, origin: { kind: 'graph', list: this.imageList } });
  }

  highlight(node) {
    const hood = node.closedNeighborhood();
    this.cy.batch(() => {
      this.cy.elements().removeClass('hl focus').addClass('faded');
      hood.removeClass('faded').addClass('hl');
      node.addClass('focus');
    });
  }

  clearHighlight() {
    if (!this.cy) return;
    this.cy.batch(() => this.cy.elements().removeClass('faded hl focus'));
  }

  runLayout() {
    if (!this.cy || !this.cy.nodes().length) return;
    this.stopLayout();
    const n = this.cy.nodes().length;
    const run = this.cy.layout({
      name: 'cose',
      animate: n <= 300,
      animationDuration: 500,
      randomize: true,
      fit: true,
      padding: 40,
      nodeRepulsion: () => 9000,
      idealEdgeLength: () => 70,
      nodeOverlap: 8,
      componentSpacing: 80,
      gravity: 0.6,
      numIter: n > 1500 ? 300 : 1000,
    });
    this.layoutRun = run;
    run.one('layoutstop', () => { if (this.layoutRun === run) this.layoutRun = null; });
    run.run();
  }

  fit() {
    if (this.cy && this.cy.nodes().length) this.cy.fit(undefined, 40);
  }

  focusSearch(q) {
    if (!this.cy) return;
    const s = q.trim().toLowerCase();
    if (!s) return;
    const match = (n) => String(n.data('label') || '').toLowerCase().includes(s);
    const tags = this.cy.nodes('.tag').filter(match);
    const node = tags.length ? tags[0] : this.cy.nodes('.image').filter(match)[0];
    if (!node) {
      this.statusEl.textContent = `「${q}」に一致するノードはありません`;
      return;
    }
    this.pinned = node;
    this.highlight(node);
    const zoom = Math.max(this.cy.zoom(), 1.2);
    if (this.cy.nodes().length > 300) {
      this.cy.zoom(zoom);
      this.cy.center(node);
    } else {
      this.cy.animate({ center: { eles: node }, zoom }, { duration: 300 });
    }
    if (node.data('kind') === 'image') this.selectImage(node.data('path'));
  }
}
