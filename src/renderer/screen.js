// スクリーン表示モード: fullscreen slideshow of a folder or a tag (カテゴリ).
// Two stacked layers crossfade; the next image is always preloaded and
// decoded before it is shown, so slides never flash. Broken files are skipped.
import { api, state, saveSettings, setGlobalSelection, normKey, pathUnder } from './state.js';
import { el, openModal, toast, toastError, fileUrl } from './ui.js';
import { fillTagSelect } from './tags.js';
import { expandWithDescendants } from './tag-tree.js';
import { Playlist } from './playlist.js';

const HUD_MS = 2000;
const CURSOR_MS = 2000;
const FADE_MS = 400;
const MAX_FOLDER_OPTIONS = 2000;

let dialogOpen = false;
let active = null;

export function isScreenActive() {
  return !!active;
}
/** Running slideshow (for the smoke test). */
export function activeShow() {
  return active;
}

function defaults() {
  const s = state.settings.screen || {};
  const interval = Number(s.interval);
  return {
    target: s.target === 'category' ? 'category' : 'folder',
    folder: s.folder || null,
    includeSub: s.includeSub !== false,
    tagId: s.tagId || null,
    interval: Number.isFinite(interval) && interval >= 1 && interval <= 3600 ? interval : 5,
    order: s.order === 'random' ? 'random' : 'name',
    loop: s.loop !== false,
  };
}

/** Roots and their subfolders (breadth-first, bounded) as select options. */
async function folderOptions(select, preferred) {
  const out = [];
  const queue = state.roots.filter((r) => r.exists).map((r) => ({ path: r.path, name: r.name, depth: 0 }));
  while (queue.length && out.length < MAX_FOLDER_OPTIONS) {
    const n = queue.shift();
    out.push(n);
    if (n.depth >= 8) continue;
    try {
      const subs = await api.subdirs(n.path);
      // keep each folder's children right after it: insert at the front in order
      queue.unshift(...subs.map((d) => ({ path: d.path, name: d.name, depth: n.depth + 1 })));
    } catch { /* unreadable: skip */ }
  }
  if (preferred && !out.some((o) => normKey(o.path) === normKey(preferred))
    && state.roots.some((r) => pathUnder(preferred, r.path))) {
    out.push({ path: preferred, name: preferred, depth: 0 });
  }
  select.replaceChildren(...out.map((o) => el('option', { value: o.path, title: o.path }, `${'　'.repeat(o.depth)}${o.name}`)));
  const pick = out.find((o) => preferred && normKey(o.path) === normKey(preferred)) || out[0];
  if (pick) select.value = pick.path;
  return out.length;
}

/**
 * Open the 「スクリーン表示」 dialog. `wb` provides the MRU gallery (default folder).
 * Resolves when the dialog closes.
 */
export async function openScreenDialog(wb) {
  if (dialogOpen || active) return;
  dialogOpen = true;
  try {
    const d = defaults();
    const mru = wb && wb.mruGalleryPane();
    const mruFolder = mru && mru.source && mru.source.kind === 'folder' ? mru.source.path : null;
    const preferredFolder = mruFolder || d.folder;

    const radio = (value, label) => {
      const input = el('input', { type: 'radio', name: 'screen-target', value });
      input.checked = d.target === value;
      return { input, label: el('label', { class: 'toggle' }, input, label) };
    };
    const rFolder = radio('folder', 'フォルダ');
    const rCategory = radio('category', 'カテゴリ');
    const folderSel = el('select', { class: 'input wide screen-folder' }, el('option', { value: '' }, '読み込み中…'));
    const includeSub = el('input', { type: 'checkbox', class: 'screen-include' });
    includeSub.checked = d.includeSub;
    // indented category tree; a parent includes the images of its sub-categories
    const tagSel = el('select', { class: 'input wide screen-tag' });
    fillTagSelect(tagSel, {
      count: (t) => `（${(state.lib.usageDeep && state.lib.usageDeep[t.id]) || state.lib.usage[t.id] || 0}）`,
    });
    if (!tagSel.options.length) tagSel.append(el('option', { value: '' }, '（タグがありません）'));
    if (d.tagId && [...tagSel.options].some((o) => o.value === d.tagId)) tagSel.value = d.tagId;
    const interval = el('input', { type: 'number', class: 'input screen-interval', min: '1', max: '3600', step: '0.5', value: String(d.interval) });
    const order = el('select', { class: 'input screen-order' },
      el('option', { value: 'name' }, '名前順'), el('option', { value: 'random' }, 'ランダム'));
    order.value = d.order;
    const loop = el('input', { type: 'checkbox', class: 'screen-loop' });
    loop.checked = d.loop;
    const err = el('div', { class: 'error' });

    const folderBox = el('div', { class: 'screen-sub' }, folderSel,
      el('label', { class: 'toggle' }, includeSub, 'サブフォルダを含む'));
    const tagBox = el('div', { class: 'screen-sub' }, tagSel);
    const sync = () => {
      const isFolder = rFolder.input.checked;
      folderBox.classList.toggle('disabled', !isFolder);
      tagBox.classList.toggle('disabled', isFolder);
      folderSel.disabled = !isFolder;
      includeSub.disabled = !isFolder;
      tagSel.disabled = isFolder;
    };
    rFolder.input.addEventListener('change', sync);
    rCategory.input.addEventListener('change', sync);
    sync();
    folderOptions(folderSel, preferredFolder).catch(() => {});

    const body = el('div', { class: 'screen-dialog' },
      el('div', { class: 'screen-row' }, el('div', { class: 'screen-label' }, '対象'),
        el('div', { class: 'screen-field' },
          el('div', { class: 'screen-radio' }, rFolder.label), folderBox,
          el('div', { class: 'screen-radio' }, rCategory.label), tagBox)),
      el('div', { class: 'screen-row' }, el('div', { class: 'screen-label' }, '切り替え秒数'),
        el('div', { class: 'screen-field inline' }, interval, el('span', { class: 'muted small' }, '秒（1〜3600）'))),
      el('div', { class: 'screen-row' }, el('div', { class: 'screen-label' }, '順番'),
        el('div', { class: 'screen-field inline' }, order, el('label', { class: 'toggle' }, loop, 'ループ'))),
      err,
      el('div', { class: 'note' }, '表示中: Esc 終了・←/→ 前後・Space 一時停止'));

    let busy = false;
    const start = async (close) => {
      if (busy) return;
      err.textContent = '';
      const sec = Number(interval.value);
      if (!Number.isFinite(sec) || sec < 1 || sec > 3600) { err.textContent = '切り替え秒数は 1〜3600 の範囲で指定してください。'; return; }
      const target = rFolder.input.checked ? 'folder' : 'category';
      if (target === 'folder' && !folderSel.value) { err.textContent = 'フォルダを選択してください。'; return; }
      if (target === 'category' && !tagSel.value) { err.textContent = 'タグを選択してください。'; return; }
      busy = true;
      let items = [];
      try {
        if (target === 'folder') items = await api.scan(folderSel.value, includeSub.checked);
        else {
          const want = expandWithDescendants(state.lib.tags, [tagSel.value]);
          items = (await api.listTagged()).filter((it) => (it.tags || []).some((id) => want.has(id)));
        }
      } catch (e) {
        busy = false;
        toastError(e, '画像を読み込めませんでした。');
        return;
      }
      const opts = { target, folder: folderSel.value || d.folder, includeSub: includeSub.checked, tagId: tagSel.value || d.tagId, interval: sec, order: order.value, loop: loop.checked };
      saveSettings({ screen: opts });
      busy = false;
      if (!items.length) {
        toast('表示できる画像がありません。対象を変更してください。', 'error');
        return; // keep the dialog open
      }
      close(true);
      await startScreen(items, opts);
    };

    await openModal({
      title: 'スクリーン表示',
      body,
      buttons: [
        { label: 'キャンセル', value: false },
        { label: 'スクリーン 開始', primary: true, onClick: start },
      ],
      onEnter: start,
    });
  } finally {
    dialogOpen = false;
  }
}

export function isScreenDialogOpen() {
  return dialogOpen;
}

export async function startScreen(items, opts) {
  if (active) return active;
  const show = new ScreenShow(items, opts);
  active = show;
  try {
    await show.start();
  } catch (e) {
    active = null;
    show.teardown();
    toastError(e, 'スクリーン表示を開始できませんでした。');
  }
  return show;
}

class ScreenShow {
  constructor(items, opts) {
    this.opts = opts;
    this.playlist = new Playlist(items, { order: opts.order, loop: opts.loop });
    this.interval = opts.interval;
    this.paused = false;
    this.ended = false;
    this.timer = null;
    this.token = 0;
    this.shownCount = 0;
    this.lastShown = null;
    this.decoded = new Map(); // url → Promise (decoded offscreen)

    this.layers = [0, 1].map(() => {
      const img = el('img', { alt: '', draggable: 'false' });
      return { root: el('div', { class: 'screen-layer' }, img), img };
    });
    this.front = 0;
    this.hud = el('div', { class: 'screen-hud' });
    this.el = el('div', { class: 'screen-overlay', tabindex: '-1' }, this.layers[0].root, this.layers[1].root, this.hud);

    this.onKey = (e) => this.handleKey(e);
    this.onMove = () => this.poke();
    this.block = (e) => { e.preventDefault(); e.stopPropagation(); };
  }

  async start() {
    await api.screenEnter();
    document.body.append(this.el);
    window.addEventListener('keydown', this.onKey, true);
    this.el.addEventListener('mousemove', this.onMove);
    for (const t of ['click', 'dblclick', 'mousedown', 'auxclick', 'contextmenu', 'wheel', 'dragstart']) {
      this.el.addEventListener(t, this.block, t === 'wheel' ? { passive: false } : undefined);
    }
    this.el.focus();
    this.poke();
    await this.showCurrent();
  }

  // ---------- slides ----------
  decode(item) {
    const url = fileUrl(item);
    let p = this.decoded.get(url);
    if (!p) {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      p = img.decode().then(() => img);
      p.catch(() => {});
      this.decoded.set(url, p);
      while (this.decoded.size > 4) this.decoded.delete(this.decoded.keys().next().value);
    }
    return p;
  }

  /** Decode the current item offscreen, then crossfade to it. */
  async showCurrent() {
    const my = ++this.token;
    for (;;) {
      const item = this.playlist.current;
      if (!item) {
        toast('表示できる画像がありません。', 'error');
        this.exit();
        return;
      }
      try {
        await this.decode(item);
      } catch {
        if (my !== this.token) return;
        this.decoded.delete(fileUrl(item));
        this.playlist.remove(item); // missing/broken: skip silently
        continue;
      }
      if (my !== this.token || active !== this) return;
      const back = this.layers[1 - this.front];
      const front = this.layers[this.front];
      back.img.src = fileUrl(item);
      back.root.classList.add('visible');
      front.root.classList.remove('visible');
      this.front = 1 - this.front;
      this.lastShown = item;
      this.shownCount++;
      this.ended = false;
      this.renderHud();
      this.schedule();
      const nxt = this.playlist.peekNext();
      if (nxt) this.decode(nxt).catch(() => {}); // always preload the following image
      return;
    }
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.paused || this.ended || active !== this) return;
    this.timer = setTimeout(() => this.next(), this.interval * 1000);
  }

  next() {
    const item = this.playlist.next();
    if (!item) {
      // end of a non-looping list: stay on the last image
      this.ended = true;
      clearTimeout(this.timer);
      this.timer = null;
      this.renderHud(true);
      return;
    }
    this.showCurrent();
  }

  prev() {
    this.playlist.prev();
    this.showCurrent();
  }

  togglePause() {
    this.paused = !this.paused;
    this.schedule();
    this.renderHud(true);
  }

  // ---------- HUD / cursor ----------
  renderHud(show = false) {
    const it = this.lastShown;
    const parts = [];
    if (it) parts.push(it.name);
    if (this.playlist.length) parts.push(`${this.playlist.index + 1} / ${this.playlist.length}`);
    parts.push(`${this.interval}秒ごと`);
    if (this.paused) parts.push('一時停止中');
    if (this.ended) parts.push('終了');
    this.hud.textContent = parts.join('　・　');
    const sticky = this.paused || this.ended;
    this.hud.classList.toggle('sticky', sticky);
    if (show) this.poke();
  }

  poke() {
    this.el.classList.remove('idle');
    this.hud.classList.add('shown');
    clearTimeout(this.hudTimer);
    clearTimeout(this.cursorTimer);
    this.hudTimer = setTimeout(() => this.hud.classList.remove('shown'), HUD_MS);
    this.cursorTimer = setTimeout(() => this.el.classList.add('idle'), CURSOR_MS);
  }

  // ---------- input ----------
  handleKey(e) {
    // screen mode owns the keyboard: nothing else may see (or swallow) these keys
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat && e.key === 'Escape') return;
    switch (e.key) {
      case 'Escape': this.exit(); break;
      case 'ArrowRight': this.next(); break;
      case 'ArrowLeft': this.prev(); break;
      case ' ':
      case 'Spacebar': this.togglePause(); break;
      default: break;
    }
  }

  teardown() {
    clearTimeout(this.timer);
    clearTimeout(this.hudTimer);
    clearTimeout(this.cursorTimer);
    this.token++;
    window.removeEventListener('keydown', this.onKey, true);
    this.el.remove();
  }

  /** Leave screen mode: restore window state, select the last shown image. */
  async exit() {
    if (active !== this) return;
    active = null;
    this.teardown();
    try {
      await api.screenExit();
    } catch (e) {
      toastError(e);
    }
    const last = this.lastShown;
    if (last) {
      setGlobalSelection({ paths: [last.path], primary: last.path, origin: { kind: 'screen', list: this.playlist.order } });
    }
  }

  /** For tests: the layer currently faded in. */
  visibleImg() {
    return this.layers[this.front].img;
  }
}

export const SCREEN_FADE_MS = FADE_MS;
