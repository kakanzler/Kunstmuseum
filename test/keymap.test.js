'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

let km;
test.before(async () => {
  km = await import('../src/renderer/keymap.js');
});

const ev = (o) => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, key: '', code: '', ...o });

test('eventToCombo normalises modifiers in a fixed order', () => {
  assert.equal(km.eventToCombo(ev({ key: 'O', code: 'KeyO', ctrlKey: true, altKey: true, shiftKey: true })), 'Ctrl+Alt+Shift+O');
  assert.equal(km.eventToCombo(ev({ key: 'p', code: 'KeyP', altKey: true })), 'Alt+P');
  assert.equal(km.eventToCombo(ev({ key: '1', code: 'Digit1', ctrlKey: true })), 'Ctrl+1');
  assert.equal(km.eventToCombo(ev({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Tab');
  assert.equal(km.eventToCombo(ev({ key: 'F2', code: 'F2' })), 'F2');
  assert.equal(km.eventToCombo(ev({ key: ',', code: 'Comma', ctrlKey: true })), 'Ctrl+,');
  assert.equal(km.eventToCombo(ev({ key: '\\', code: 'Backslash', ctrlKey: true })), 'Ctrl+\\');
  assert.equal(km.eventToCombo(ev({ key: '\\', code: 'IntlYen', ctrlKey: true })), 'Ctrl+\\', 'JIS ¥ key');
  assert.equal(km.eventToCombo(ev({ key: 'ArrowLeft', code: 'ArrowLeft' })), 'Left');
  assert.equal(km.eventToCombo(ev({ key: ' ', code: 'Space' })), 'Space');
  assert.equal(km.eventToCombo(ev({ key: 'Escape', code: 'Escape' })), 'Esc');
});

test('eventToCombo uses code for letters/digits whatever `key` says (IME, layouts, Alt symbols)', () => {
  assert.equal(km.eventToCombo(ev({ key: 'œ', code: 'KeyQ', altKey: true })), 'Alt+Q');
  assert.equal(km.eventToCombo(ev({ key: 'Process', code: 'KeyQ', altKey: true })), 'Alt+Q', 'IME composition');
  assert.equal(km.eventToCombo(ev({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+1');
  assert.equal(km.eventToCombo(ev({ key: 'Unidentified', code: 'KeyA', ctrlKey: true })), 'Ctrl+A');
});

test('eventToCombo returns null for modifier-only presses', () => {
  for (const key of ['Control', 'Alt', 'Shift', 'Meta']) {
    assert.equal(km.eventToCombo(ev({ key, code: `${key}Left`, ctrlKey: key === 'Control' })), null);
  }
});

test('parse/format roundtrip and normalisation', () => {
  for (const c of ['Alt+P', 'Ctrl+Alt+Shift+O', 'Ctrl+,', 'Ctrl+\\', 'Ctrl+Shift+Tab', 'F2', 'Ctrl+0', 'Alt+Left']) {
    assert.equal(km.formatCombo(km.parseCombo(c)), c);
  }
  assert.equal(km.formatCombo('shift+ctrl+alt+o'), 'Ctrl+Alt+Shift+O', 'order and case normalised');
  assert.equal(km.formatCombo('Control+Escape'), 'Ctrl+Esc');
  assert.equal(km.formatCombo('ctrl+f5'), 'Ctrl+F5');
  assert.equal(km.parseCombo('Ctrl+A+B'), null, 'two keys');
  assert.equal(km.parseCombo('Ctrl+'), null);
  assert.equal(km.parseCombo(''), null);
  assert.equal(km.displayCombo('Alt+Left'), 'Alt+←');
});

test('validation rules', () => {
  const ok = (c) => assert.equal(km.validateCombo(c), null, c);
  const bad = (c) => assert.ok(km.validateCombo(c), c);
  ok('Alt+P'); ok('Ctrl+Alt+P'); ok('Ctrl+,'); ok('F2'); ok('F5'); ok('Shift+F3'); ok('Ctrl+Tab'); ok('Ctrl+Space'); ok('Ctrl+Left');
  bad('P'); bad('Shift+P'); bad('1');                   // needs Ctrl or Alt
  bad('Esc'); bad('Ctrl+Esc'); bad('Alt+Esc');          // Esc never
  bad('Enter'); bad('Alt+Enter'); bad('Space'); bad('Left'); bad('Shift+Down'); bad('Tab'); bad('Alt+Tab'); bad('Shift+Tab');
  bad('Alt+F4'); bad('F12'); bad('F10'); bad('Ctrl+Shift+I'); bad('Alt+Space'); // reserved
  bad('F13');
  bad('nonsense+');
});

test('defaults are valid and unique', () => {
  const seen = new Set();
  for (const c of km.COMMANDS) {
    assert.equal(km.validateCombo(c.default), null, `${c.id} default ${c.default}`);
    assert.ok(!seen.has(c.default), `duplicate default ${c.default}`);
    seen.add(c.default);
    assert.equal(c.scope, 'global');
  }
  assert.equal(km.resolveBindings().get('graph.showRight'), 'Alt+Q');
  assert.equal(km.resolveBindings().get('settings.open'), 'Ctrl+,');
});

test('overrides merge with defaults; unknown ids and invalid combos are ignored', () => {
  const b = km.resolveBindings({ 'preview.showRight': 'ctrl+alt+p', 'no.such.command': 'Alt+Z', 'tab.close': 'Esc', 'graph.showRight': 42 });
  assert.equal(b.get('preview.showRight'), 'Ctrl+Alt+P');
  assert.ok(!b.has('no.such.command'));
  assert.equal(b.get('tab.close'), 'Ctrl+W', 'invalid override falls back to the default');
  assert.equal(b.get('graph.showRight'), 'Alt+Q');
  assert.deepEqual(km.toOverrides(b), { 'preview.showRight': 'Ctrl+Alt+P' });
  assert.deepEqual(km.toOverrides(km.resolveBindings()), {});
  assert.equal(km.resolveBindings(null).size, km.COMMANDS.length);
});

test('conflict detection and swap', () => {
  let b = km.resolveBindings();
  assert.equal(km.matchCommand(b, 'Alt+P'), 'preview.showRight');
  assert.equal(km.matchCommand(b, 'Alt+Z'), null);
  let r = km.setBinding(b, 'graph.showRight', 'Alt+P');
  assert.equal(r.conflict, 'preview.showRight');
  assert.equal(r.bindings, b, 'unchanged without swap');
  r = km.setBinding(b, 'graph.showRight', 'Alt+P', { swap: true });
  assert.equal(r.swappedWith, 'preview.showRight');
  assert.equal(r.bindings.get('graph.showRight'), 'Alt+P');
  assert.equal(r.bindings.get('preview.showRight'), 'Alt+Q');
  b = r.bindings;
  // rebinding to its own current combo is not a conflict
  assert.equal(km.setBinding(b, 'graph.showRight', 'Alt+P').conflict, null);
  // reset to default conflicts with the swapped partner until swapped back
  r = km.resetBinding(b, 'graph.showRight');
  assert.equal(r.conflict, 'preview.showRight');
  r = km.resetBinding(b, 'graph.showRight', { swap: true });
  assert.deepEqual(km.toOverrides(r.bindings), {});
  assert.equal(km.setBinding(b, 'no.such', 'Alt+Z').error, 'invalid');
});
