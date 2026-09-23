// Runtime keymap: the effective bindings (defaults + persisted overrides),
// command handlers, event → command lookup, and labels for UI hints.
import { state, emit, saveSettings } from './state.js';
import { resolveBindings, toOverrides, eventToCombo, matchCommand, displayCombo } from './keymap.js';

const handlers = new Map();

/** Load bindings from settings.keybindings (overrides only). */
export function initKeymap() {
  state.bindings = resolveBindings(state.settings.keybindings);
}

export function bindings() {
  if (!state.bindings) initKeymap();
  return state.bindings;
}

/** Replace the bindings, persist only the overrides, notify hint renderers. */
export function applyBindings(next) {
  state.bindings = next;
  saveSettings({ keybindings: toOverrides(next) });
  emit('keymap-changed');
}

/** Display label of a command's current binding (e.g. "Alt+P"). */
export function keyLabel(id) {
  return displayCombo(bindings().get(id)) || '未設定';
}

export function registerCommands(map) {
  for (const [id, fn] of Object.entries(map)) handlers.set(id, fn);
}

/** Command id bound to a keydown event, or null. */
export function commandForEvent(e) {
  return matchCommand(bindings(), eventToCombo(e));
}

export function runCommand(id) {
  const fn = handlers.get(id);
  if (!fn) return false;
  fn();
  return true;
}
