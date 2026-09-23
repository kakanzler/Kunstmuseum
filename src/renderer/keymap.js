// Central keymap (pure, DOM-free → unit-testable with node).
// Commands with default bindings, key-event normalisation, combo
// parse/format, validation rules, conflict detection and user overrides.
//
// A combo is a canonical string: modifiers in the fixed order Ctrl, Alt,
// Shift, then one key name, e.g. "Ctrl+Alt+Shift+O", "Alt+P", "Ctrl+\\", "F2".

/** Global commands. `default` is the built-in binding. */
export const COMMANDS = [
  { id: 'preview.showRight', label: 'Preview を右に表示', category: '表示', default: 'Alt+P' },
  { id: 'graph.showRight', label: '知識グラフを右に表示', category: '表示', default: 'Alt+Q' },
  { id: 'screen.open', label: 'スクリーン表示', category: '表示', default: 'Ctrl+Alt+Shift+O' },
  { id: 'settings.open', label: '設定を開く', category: '全般', default: 'Ctrl+,' },
  { id: 'search.quickOpen', label: 'ファイル名で検索（全フォルダ）', category: '全般', default: 'Ctrl+F' },
  { id: 'tags.bulkFolder', label: 'フォルダのカテゴリを一括編集', category: '編集', default: 'Alt+Shift+C' },
  { id: 'tab.close', label: 'タブを閉じる', category: 'タブ', default: 'Ctrl+W' },
  { id: 'tab.splitRight', label: '右に分割', category: 'タブ', default: 'Ctrl+\\' },
  { id: 'tab.next', label: '次のタブ', category: 'タブ', default: 'Ctrl+Tab' },
  { id: 'tab.prev', label: '前のタブ', category: 'タブ', default: 'Ctrl+Shift+Tab' },
  { id: 'group.focus1', label: 'グループ1へ移動', category: 'タブ', default: 'Ctrl+1' },
  { id: 'group.focus2', label: 'グループ2へ移動', category: 'タブ', default: 'Ctrl+2' },
  { id: 'group.focus3', label: 'グループ3へ移動', category: 'タブ', default: 'Ctrl+3' },
  { id: 'group.focus4', label: 'グループ4へ移動', category: 'タブ', default: 'Ctrl+4' },
  { id: 'edit.rename', label: '名前の変更', category: '編集', default: 'F2' },
  { id: 'edit.selectAll', label: 'すべて選択', category: '編集', default: 'Ctrl+A' },
  { id: 'view.resetZoom', label: '表示サイズを戻す', category: '表示', default: 'Ctrl+0' },
  { id: 'view.refresh', label: '更新', category: '表示', default: 'F5' },
].map((c) => Object.freeze({ scope: 'global', ...c }));

export const COMMAND_IDS = new Set(COMMANDS.map((c) => c.id));
export function commandById(id) {
  return COMMANDS.find((c) => c.id === id) || null;
}

// ---------- key names ----------
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS', 'Hyper', 'Super']);

const CODE_KEYS = {
  Backslash: '\\', IntlYen: '\\', IntlRo: '\\',
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Esc',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Delete: 'Delete', Backspace: 'Backspace', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
};
const KEY_KEYS = {
  ' ': 'Space', Spacebar: 'Space', Escape: 'Esc', Esc: 'Esc',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Tab: 'Tab', Enter: 'Enter', Delete: 'Delete', Backspace: 'Backspace', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', '¥': '\\',
};
const NAMED = new Set([
  'Space', 'Tab', 'Enter', 'Esc', 'Up', 'Down', 'Left', 'Right', 'Delete', 'Backspace', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown',
]);

/**
 * Key name of a keyboard event, or null for a modifier-only press.
 * Letters and digits come from `code` so Alt+letter works whatever the IME
 * or layout reports in `key`.
 */
export function keyName(e) {
  if (!e) return null;
  if (MODIFIER_KEYS.has(e.key)) return null;
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key || '')) return e.key;
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  if (KEY_KEYS[e.key]) return KEY_KEYS[e.key];
  if (typeof e.key === 'string' && e.key.length === 1) return e.key.toUpperCase();
  return null;
}

/** Normalised combo of a keydown event ("Ctrl+Alt+Shift+Q"), or null. */
export function eventToCombo(e) {
  const k = keyName(e);
  if (!k) return null;
  return formatCombo({ ctrl: !!(e.ctrlKey || e.metaKey), alt: !!e.altKey, shift: !!e.shiftKey, key: k });
}

/** Parse "ctrl+alt+p" / "Control+Shift+Tab" → {ctrl,alt,shift,key}, or null. */
export function parseCombo(str) {
  if (typeof str !== 'string' || !str.trim()) return null;
  const s = str.trim();
  // the key itself may be "+" ("Ctrl++")
  const parts = s.endsWith('++') ? [...s.slice(0, -2).split('+'), '+'] : s.split('+');
  const out = { ctrl: false, alt: false, shift: false, key: null };
  for (const raw of parts) {
    const p = raw.trim();
    const lower = p.toLowerCase();
    if (lower === 'ctrl' || lower === 'control' || lower === 'cmd' || lower === 'meta') out.ctrl = true;
    else if (lower === 'alt' || lower === 'option') out.alt = true;
    else if (lower === 'shift') out.shift = true;
    else {
      if (out.key || !p) return null;
      out.key = normaliseKey(p);
      if (!out.key) return null;
    }
  }
  return out.key ? out : null;
}

function normaliseKey(p) {
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(p)) return p.toUpperCase();
  const alias = { esc: 'Esc', escape: 'Esc', space: 'Space', tab: 'Tab', enter: 'Enter', return: 'Enter', up: 'Up', down: 'Down', left: 'Left', right: 'Right', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', del: 'Delete', delete: 'Delete', backspace: 'Backspace', insert: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', backslash: '\\', comma: ',' };
  const a = alias[p.toLowerCase()];
  if (a) return a;
  if (p.length === 1) return p.toUpperCase();
  return null;
}

/** Canonical string for a parsed combo (or normalises a string). */
export function formatCombo(c) {
  const p = typeof c === 'string' ? parseCombo(c) : c;
  if (!p || !p.key) return null;
  return [p.ctrl && 'Ctrl', p.alt && 'Alt', p.shift && 'Shift', p.key].filter(Boolean).join('+');
}

const DISPLAY = { Left: '←', Right: '→', Up: '↑', Down: '↓' };
/** Human-readable form for the UI (arrows as ←→↑↓). */
export function displayCombo(combo) {
  const p = parseCombo(combo);
  if (!p) return '';
  return [p.ctrl && 'Ctrl', p.alt && 'Alt', p.shift && 'Shift', DISPLAY[p.key] || p.key].filter(Boolean).join('+');
}

// ---------- validation ----------
/** Combos the OS or Electron itself consumes (never delivered to the page). */
export const RESERVED = new Set([
  'Alt+F4', 'Alt+Tab', 'Alt+Shift+Tab', 'Alt+Esc', 'Alt+Space', 'Ctrl+Esc', 'Ctrl+Shift+Esc', 'Ctrl+Alt+Delete',
  'F10', 'Shift+F10', 'F12', 'Ctrl+Shift+I', // system menu key, context menu, DevTools (main process)
]);

const isFKey = (k) => /^F([1-9]|1[0-2])$/.test(k);

/** Error message (Japanese) if `combo` may not be used as a global binding, else null. */
export function validateCombo(combo) {
  const p = typeof combo === 'string' ? parseCombo(combo) : combo;
  if (!p || !p.key) return 'キーを認識できませんでした。';
  const c = formatCombo(p);
  if (RESERVED.has(c)) return `${displayCombo(c)} はシステムやブラウザが使用するため割り当てられません。`;
  if (p.key === 'Esc') return 'Esc は割り当てられません（キャンセルに使用します）。';
  if (['Enter', 'Space', 'Up', 'Down', 'Left', 'Right', 'Tab'].includes(p.key) && !p.ctrl) {
    return `${DISPLAY[p.key] || p.key} は Ctrl と組み合わせる必要があります。`;
  }
  if (!p.ctrl && !p.alt && !isFKey(p.key)) return 'Ctrl または Alt を含めてください（F1〜F12 は単独で使用できます）。';
  if (/^F(1[3-9]|2[0-4])$/.test(p.key) && !p.ctrl && !p.alt) return 'Ctrl または Alt を含めてください。';
  return null;
}

// ---------- bindings ----------
/** Effective bindings: defaults merged with overrides ({id: combo}); unknown ids and invalid combos are ignored. */
export function resolveBindings(overrides = {}) {
  const map = new Map(COMMANDS.map((c) => [c.id, c.default]));
  if (overrides && typeof overrides === 'object') {
    for (const [id, combo] of Object.entries(overrides)) {
      if (!COMMAND_IDS.has(id)) continue;
      const f = formatCombo(combo);
      if (f && !validateCombo(f)) map.set(id, f);
    }
  }
  return map;
}

/** Overrides to persist: only entries that differ from the defaults. */
export function toOverrides(bindings) {
  const out = {};
  for (const c of COMMANDS) {
    const b = bindings.get(c.id);
    if (b && b !== c.default) out[c.id] = b;
  }
  return out;
}

/** Command bound to `combo` (optionally ignoring one id), or null. */
export function findConflict(bindings, combo, exceptId = null) {
  const f = formatCombo(combo);
  if (!f) return null;
  for (const [id, b] of bindings) if (id !== exceptId && b === f) return id;
  return null;
}

export function matchCommand(bindings, combo) {
  return combo ? findConflict(bindings, combo) : null;
}

/**
 * Bind `id` to `combo`. Returns {bindings, conflict}: when another command
 * already uses the combo and `swap` is false, nothing changes and
 * `conflict` names it; with `swap` the two commands exchange bindings.
 */
export function setBinding(bindings, id, combo, { swap = false } = {}) {
  const f = formatCombo(combo);
  if (!COMMAND_IDS.has(id) || !f) return { bindings, conflict: null, error: 'invalid' };
  const other = findConflict(bindings, f, id);
  if (other && !swap) return { bindings, conflict: other };
  const next = new Map(bindings);
  if (other) next.set(other, bindings.get(id));
  next.set(id, f);
  return { bindings: next, conflict: null, swappedWith: other || null };
}

export function resetBinding(bindings, id, opts) {
  const c = commandById(id);
  return c ? setBinding(bindings, id, c.default, opts) : { bindings, conflict: null };
}
