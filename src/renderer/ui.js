// Generic UI helpers: DOM builder, toasts, context menu, modals, formatting.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// ---------- toasts ----------
/**
 * Show a toast. `actions` = [{label, onClick}] renders buttons (e.g. 元に戻す);
 * clicking one runs it and dismisses the toast. Returns the element.
 */
export function toast(message, kind = 'info', ms, actions = []) {
  const root = document.getElementById('toasts');
  const t = el('div', { class: `toast ${kind}` }, message);
  if (actions.length) {
    const bar = el('div', { class: 'toast-actions' });
    for (const a of actions) {
      bar.append(el('button', {
        class: 'btn small toast-action',
        onclick: (e) => {
          e.stopPropagation();
          t.remove();
          Promise.resolve().then(a.onClick).catch((err) => toastError(err));
        },
      }, a.label));
    }
    t.append(bar);
  }
  root.append(t);
  while (root.children.length > 5) root.firstChild.remove();
  const life = ms ?? (actions.length ? 10000 : kind === 'error' ? 7000 : 3500);
  setTimeout(() => t.remove(), life);
  t.addEventListener('click', () => t.remove());
  return t;
}

export function toastError(e, prefix = '') {
  const msg = (e && e.message) || String(e);
  toast(prefix ? `${prefix}\n${msg}` : msg, 'error');
}

// ---------- context menu ----------
let ctxClose = null;
export function showContextMenu(x, y, items) {
  hideContextMenu();
  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = '';
  for (const it of items) {
    if (!it) continue;
    if (it.separator) { menu.append(el('div', { class: 'ctx-sep' })); continue; }
    const row = el('div', { class: `ctx-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`, title: it.title || null }, it.label);
    row.addEventListener('click', () => {
      hideContextMenu();
      Promise.resolve().then(it.action).catch((e) => toastError(e));
    });
    menu.append(row);
  }
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`;
  const close = (e) => {
    if (e.type === 'keydown' && e.key !== 'Escape') return;
    if (e.type === 'mousedown' && menu.contains(e.target)) return;
    hideContextMenu();
  };
  setTimeout(() => {
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', close, true);
    window.addEventListener('blur', close);
  });
  ctxClose = () => {
    window.removeEventListener('mousedown', close, true);
    window.removeEventListener('keydown', close, true);
    window.removeEventListener('blur', close);
  };
}
export function hideContextMenu() {
  document.getElementById('ctx-menu').classList.add('hidden');
  if (ctxClose) ctxClose();
  ctxClose = null;
}

// ---------- modals ----------
let modalDepth = 0;
export function isModalOpen() {
  return modalDepth > 0;
}

/**
 * Generic modal. `build(close)` returns body content. Resolves with the value
 * passed to close() (undefined when dismissed via Esc/backdrop).
 */
export function openModal({ title, body, buttons = [], onEnter, wide = false, className = '' }) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const box = el('div', { class: `modal${className ? ` ${className}` : ''}`, style: wide ? { maxWidth: '92vw' } : null });
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      modalDepth--;
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(value);
    };
    const content = typeof body === 'function' ? body(close) : body;
    const foot = el('div', { class: 'modal-foot' });
    for (const b of buttons) {
      const btn = el('button', { class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}` }, b.label);
      btn.addEventListener('click', () => (b.onClick ? b.onClick(close) : close(b.value)));
      foot.append(btn);
    }
    box.append(el('div', { class: 'modal-head' }, title), el('div', { class: 'modal-body' }, content));
    if (buttons.length) box.append(foot);
    backdrop.append(box);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(undefined); });
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(undefined); return; }
      if (e.key === 'Enter' && onEnter && e.target.tagName !== 'TEXTAREA' && !e.isComposing) {
        // autocomplete lists and fields marked data-local-enter handle Enter themselves
        if (e.target.closest && e.target.closest('.ac-list, [data-local-enter]')) return;
        e.preventDefault();
        onEnter(close);
      }
    };
    document.addEventListener('keydown', onKey, true);
    modalDepth++;
    document.getElementById('modal-root').append(backdrop);
    const focusable = box.querySelector('input, select, button');
    if (focusable) focusable.focus();
  });
}

export async function confirmDialog(message, { title = '確認', okLabel = 'OK', danger = false } = {}) {
  const v = await openModal({
    title,
    body: el('div', { style: { whiteSpace: 'pre-line', maxWidth: '520px' } }, message),
    buttons: [
      { label: 'キャンセル', value: false },
      { label: okLabel, value: true, primary: !danger, danger },
    ],
    onEnter: (close) => close(true),
  });
  return v === true;
}

/**
 * Text prompt. `validate(value)` returns an error string or null.
 * `selectEnd` limits the initial selection (e.g. the basename without extension).
 */
export function promptDialog({ title, label = '', value = '', selectEnd, validate, okLabel = 'OK', note }) {
  const input = el('input', { class: 'input wide', value, spellcheck: 'false' });
  const err = el('div', { class: 'error' });
  const submit = async (close) => {
    const v = input.value;
    const msg = validate ? await validate(v) : null;
    if (msg) { err.textContent = msg; return; }
    close(v);
  };
  const p = openModal({
    title,
    body: el('div', {}, label ? el('div', { class: 'note', style: { marginTop: 0, marginBottom: '6px' } }, label) : null, input, err, note ? el('div', { class: 'note' }, note) : null),
    buttons: [
      { label: 'キャンセル', value: null },
      { label: okLabel, primary: true, onClick: submit },
    ],
    onEnter: submit,
  });
  requestAnimationFrame(() => {
    input.focus();
    input.setSelectionRange(0, selectEnd ?? value.length);
  });
  input.addEventListener('input', () => { err.textContent = ''; });
  return p.then((v) => (v === undefined ? null : v));
}

// ---------- formatting ----------
export const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

export function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

const dtf = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export function formatDate(ms) {
  return ms ? dtf.format(new Date(ms)) : '';
}

export function basename(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}
export function dirname(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i > 0 ? s.slice(0, i) : s;
}
export function extname(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

export function fileUrl(item) {
  return `kmimg://file/${encodeURIComponent(item.path)}${item.mtime ? `?v=${Math.round(item.mtime)}` : ''}`;
}
export function thumbUrl(item) {
  return `kmimg://thumb/${encodeURIComponent(item.path)}${item.mtime ? `?v=${Math.round(item.mtime)}` : ''}`;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Mirrors fsops.validateName for instant feedback (main re-validates). */
export function validateName(name) {
  if (!name || !name.trim()) return '名前を入力してください。';
  if (name === '.' || name === '..') return 'この名前は使用できません。';
  if (/[\\/:*?"<>|]/.test(name)) return '名前に次の文字は使用できません: \\ / : * ? " < > |';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return '名前に制御文字は使用できません。';
  if (/[. ]$/.test(name)) return '名前の末尾にピリオドや空白は使用できません。';
  if (name.length > 255) return '名前が長すぎます。';
  const base = name.split('.')[0].trim();
  if (RESERVED.test(base)) return `「${base.toUpperCase()}」は Windows の予約名のため使用できません。`;
  return null;
}

export function debounce(fn, ms) {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function isEditable(target) {
  if (!target || !target.tagName) return false;
  const t = target.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || target.isContentEditable;
}

export function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(136,136,136,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
