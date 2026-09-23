// Reusable image viewer component (used by the Preview tab and image tabs).
// Every instance has its own zoom/pan state: fit (never above 100%),
// Ctrl+wheel zoom at the cursor, drag to pan, Ctrl+0 / middle-click / 0 → fit,
// 1 → 100%, double-click toggles 100% ⇔ fit, HUD with the zoom level.
import { el, fileUrl } from './ui.js';

const MIN_SCALE = 0.05;
const MAX_SCALE = 20;
const STEP = 1.15;

export class ImageViewer {
  /**
   * @param {{onNavigate?:(delta:number)=>void, onRename?:()=>void, emptyText?:string}} opts
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.item = null;
    this.natW = 0;
    this.natH = 0;
    this.isSvg = false;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.fitted = true;
    this.token = 0;
    this.swaps = 0;

    this.nameEl = el('div', { class: 'iv-name' });
    this.posEl = el('div', { class: 'muted small iv-pos' });
    const btn = (label, title, fn) => el('button', { class: 'btn subtle small', title, onclick: fn }, label);
    this.prevBtn = btn('←', '前へ (←)', () => this.navigate(-1));
    this.nextBtn = btn('→', '次へ (→)', () => this.navigate(1));
    this.bar = el('div', { class: 'iv-bar' },
      this.nameEl, this.posEl, el('div', { class: 'spacer' }),
      this.prevBtn, this.nextBtn,
      btn('全体', '画面に合わせる (Ctrl+0 / 中クリック / 0)', () => this.fit()),
      btn('100%', '等倍 (1)', () => this.zoomTo(1)));
    this.img = el('img', { class: 'iv-img', alt: '', draggable: 'false' });
    this.msg = el('div', { class: 'iv-msg' }, opts.emptyText || '');
    this.stage = el('div', { class: 'iv-stage' }, this.img, this.msg);
    this.hud = el('div', { class: 'iv-hud' }, '');
    this.el = el('div', { class: 'iv' }, this.bar, this.stage, this.hud);
    this.img.style.visibility = 'hidden';

    this._bind();
  }

  _bind() {
    this.stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.natW) return;
      if (e.ctrlKey) {
        const r = this.stage.getBoundingClientRect();
        this.zoomAt(this.scale * (e.deltaY < 0 ? STEP : 1 / STEP), e.clientX - r.left, e.clientY - r.top);
      } else {
        this.tx -= e.shiftKey ? e.deltaY : e.deltaX;
        this.ty -= e.shiftKey ? 0 : e.deltaY;
        this._clamp();
        this._apply();
      }
    }, { passive: false });

    this.stage.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault(); // no autoscroll
        this.fit();
        return;
      }
      if (e.button !== 0 || !this._canPan()) return;
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
      this.stage.classList.add('panning');
      const move = (ev) => {
        this.tx = start.tx + (ev.clientX - start.x);
        this.ty = start.ty + (ev.clientY - start.y);
        this._clamp();
        this._apply();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        this.stage.classList.remove('panning');
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    this.stage.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    this.stage.addEventListener('dblclick', (e) => {
      if (!this.natW) return;
      const r = this.stage.getBoundingClientRect();
      if (Math.abs(this.scale - 1) > 1e-6) this.zoomAt(1, e.clientX - r.left, e.clientY - r.top);
      else this.fit();
    });

    this.ro = new ResizeObserver(() => {
      if (!this.natW || !this.stage.clientWidth) return;
      if (this.fitted) this.fit();
      else { this._clamp(); this._apply(); }
    });
    this.ro.observe(this.stage);
  }

  dispose() {
    this.ro.disconnect();
    this.token++;
  }

  /** Show an empty/message state. */
  clear(text) {
    this.token++;
    this.item = null;
    this.natW = 0;
    this.img.removeAttribute('src');
    this.img.style.visibility = 'hidden';
    this.nameEl.textContent = '';
    this.posEl.textContent = '';
    this.msg.textContent = text || this.opts.emptyText || '';
    this.msg.classList.remove('hidden');
    this.hud.textContent = '';
    this.prevBtn.disabled = true;
    this.nextBtn.disabled = true;
  }

  /**
   * Display `item`; `pos` = {index,total} for the position label.
   * The current image stays on screen until the next one is fully decoded
   * offscreen; then src, size and fit are applied in the same task, so no
   * empty or half-decoded frame is ever painted. Stale loads are dropped.
   */
  setItem(item, pos) {
    this.setPosition(pos);
    this.nameEl.textContent = item.name;
    this.nameEl.title = item.path;
    const same = this.item && this.item.path === item.path && (this.item.mtime || 0) === (item.mtime || 0) && this.natW;
    this.item = item;
    if (same) return Promise.resolve();
    const token = ++this.token;
    const isSvg = (item.ext || item.name.slice(item.name.lastIndexOf('.'))).toLowerCase() === '.svg';
    const url = fileUrl(item);
    const probe = new Image();
    probe.decoding = 'async';
    probe.src = url;
    return probe.decode().then(() => {
      if (token !== this.token) return;
      let w = probe.naturalWidth || 0;
      let h = probe.naturalHeight || 0;
      if (!w || !h) {
        const r = this.stage.getBoundingClientRect();
        w = Math.round(r.width * 0.8) || 800;
        h = Math.round(r.height * 0.8) || 600;
      }
      this.natW = w;
      this.natH = h;
      this.isSvg = isSvg;
      this.img.src = url; // same URL → served decoded from the memory cache
      this.swaps++;
      this.img.style.visibility = 'visible';
      this.msg.classList.add('hidden');
      this.fit();
    }, () => {
      if (token !== this.token) return;
      this.natW = 0;
      this.img.removeAttribute('src');
      this.img.style.visibility = 'hidden';
      this.msg.textContent = 'この画像を表示できません。';
      this.msg.classList.remove('hidden');
      this.hud.textContent = '—';
    });
  }

  setPosition(pos) {
    const has = pos && pos.total > 0 && pos.index >= 0;
    this.posEl.textContent = has ? `${pos.index + 1} / ${pos.total}` : '';
    const nav = !!this.opts.onNavigate && has && pos.total > 1;
    this.prevBtn.disabled = !nav;
    this.nextBtn.disabled = !nav;
  }

  navigate(delta) {
    if (this.opts.onNavigate) this.opts.onNavigate(delta);
  }

  // ---------- zoom ----------
  _viewport() {
    return { w: this.stage.clientWidth, h: this.stage.clientHeight };
  }

  fit() {
    if (!this.natW) return;
    const { w, h } = this._viewport();
    this.scale = w && h ? Math.min(1, w / this.natW, h / this.natH) : 1;
    this.tx = (w - this.natW * this.scale) / 2;
    this.ty = (h - this.natH * this.scale) / 2;
    this.fitted = true;
    this._apply();
  }

  zoomTo(s) {
    const { w, h } = this._viewport();
    this.zoomAt(s, w / 2, h / 2);
  }

  zoomBy(f) {
    this.zoomTo(this.scale * f);
  }

  zoomAt(newScale, cx, cy) {
    if (!this.natW) return;
    const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    const k = s / this.scale;
    this.tx = cx - (cx - this.tx) * k;
    this.ty = cy - (cy - this.ty) * k;
    this.scale = s;
    this.fitted = false;
    this._clamp();
    this._apply();
  }

  zoomPercent() {
    return Math.round(this.scale * 100);
  }

  _canPan() {
    const { w, h } = this._viewport();
    return this.natW * this.scale > w + 0.5 || this.natH * this.scale > h + 0.5;
  }

  _clamp() {
    const { w, h } = this._viewport();
    const iw = this.natW * this.scale;
    const ih = this.natH * this.scale;
    this.tx = iw <= w ? (w - iw) / 2 : Math.min(0, Math.max(w - iw, this.tx));
    this.ty = ih <= h ? (h - ih) / 2 : Math.min(0, Math.max(h - ih, this.ty));
  }

  _apply() {
    const s = this.img.style;
    if (this.isSvg) {
      // vector: lay out at the zoomed size so it rasterises crisply
      s.width = `${this.natW * this.scale}px`;
      s.height = `${this.natH * this.scale}px`;
      s.transform = `translate(${this.tx}px, ${this.ty}px)`;
    } else {
      s.width = `${this.natW}px`;
      s.height = `${this.natH}px`;
      s.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    }
    this.stage.classList.toggle('pannable', this._canPan());
    this.hud.textContent = `${this.zoomPercent()}%`;
  }

  /** Keyboard handling for the owning tab. Returns true when handled. */
  handleKey(e) {
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl && !e.altKey && (k === 'ArrowRight' || k === 'PageDown')) { e.preventDefault(); this.navigate(1); return true; }
    if (!ctrl && !e.altKey && (k === 'ArrowLeft' || k === 'PageUp')) { e.preventDefault(); this.navigate(-1); return true; }
    if (ctrl && k === '0') { e.preventDefault(); this.fit(); return true; }
    if (ctrl && (k === '+' || k === '=' || k === ';')) { e.preventDefault(); this.zoomBy(STEP); return true; }
    if (ctrl && k === '-') { e.preventDefault(); this.zoomBy(1 / STEP); return true; }
    if (!ctrl && !e.altKey && k === '1') { e.preventDefault(); this.zoomTo(1); return true; }
    if (!ctrl && !e.altKey && k === '0') { e.preventDefault(); this.fit(); return true; }
    if (k === 'F2' && this.opts.onRename && this.item) { e.preventDefault(); this.opts.onRename(); return true; }
    return false;
  }
}
