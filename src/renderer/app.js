// Renderer entry point: bootstrap, global keyboard routing, panel resizers,
// smoke test.
import { api, state, setLib, saveSettings, emit, on, flushSettings, galleries } from './state.js';
import { toast, toastError, isModalOpen, isEditable } from './ui.js';
import * as sidebar from './sidebar.js';
import { initInspector } from './inspector.js';
import { openTagManager } from './tags.js';
import { wb } from './workbench.js';
import { openScreenDialog, isScreenActive } from './screen.js';
import { initKeymap, registerCommands, commandForEvent, runCommand, keyLabel } from './commands.js';
import { toggleSettings, isSettingsOpen } from './settings.js';

const $ = (id) => document.getElementById(id);

window.addEventListener('error', (e) => {
  console.error('[uncaught]', (e.error && e.error.stack) || e.message);
  toast(`予期しないエラー: ${e.message}`, 'error');
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e.reason && e.reason.message) || String(e.reason);
  console.error('[unhandled]', msg);
  toast(`予期しないエラー: ${msg}`, 'error');
});

// Ctrl+wheel must never reach Chromium's page zoom.
window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
// Dropping files anywhere else must not navigate.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
window.addEventListener('beforeunload', () => { wb.saveNow(); flushSettings(); });

function initResizers() {
  const layout = $('layout');
  const apply = () => {
    layout.style.setProperty('--sidebar-w', `${state.settings.sidebarWidth || 260}px`);
    layout.style.setProperty('--inspector-w', `${state.settings.inspectorWidth || 300}px`);
  };
  apply();
  for (const r of document.querySelectorAll('.resizer')) {
    r.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      r.setPointerCapture(e.pointerId);
      r.classList.add('active');
      const which = r.dataset.resize;
      const startX = e.clientX;
      const start = which === 'sidebar' ? (state.settings.sidebarWidth || 260) : (state.settings.inspectorWidth || 300);
      const move = (ev) => {
        const dx = ev.clientX - startX;
        const max = Math.max(260, window.innerWidth * 0.45);
        const v = Math.round(Math.max(160, Math.min(max, which === 'sidebar' ? start + dx : start - dx)));
        state.settings[which === 'sidebar' ? 'sidebarWidth' : 'inspectorWidth'] = v;
        apply();
      };
      const up = () => {
        r.classList.remove('active');
        r.removeEventListener('pointermove', move);
        r.removeEventListener('pointerup', up);
        r.removeEventListener('pointercancel', up);
        saveSettings({ sidebarWidth: state.settings.sidebarWidth, inspectorWidth: state.settings.inspectorWidth });
      };
      r.addEventListener('pointermove', move);
      r.addEventListener('pointerup', up);
      r.addEventListener('pointercancel', up);
    });
  }
}

/**
 * Global shortcuts go through the keymap (settings › ホットキー). Guards: none
 * while editing text, in screen mode or in another modal; while 設定 is open
 * only its own shortcut works (it closes it). Fixed context keys (arrows,
 * Enter, viewer 1/0, …) are handled by the tree / the active pane.
 */
function onKeyDown(e) {
  if (isScreenActive()) return; // the slideshow owns the keyboard (capture listener)
  const id = commandForEvent(e);
  if (isSettingsOpen()) {
    if (id === 'settings.open') { e.preventDefault(); toggleSettings(settingsCtx); }
    return;
  }
  if (isModalOpen()) return;
  if (isEditable(e.target)) return;
  if (id) {
    e.preventDefault();
    runCommand(id);
    return;
  }
  if (sidebar.hasFocus()) { sidebar.handleKey(e); return; }
  const p = wb.activePane();
  if (p && p.handleKey) p.handleKey(e);
}

const settingsCtx = { setShowFiles: (v) => sidebar.setShowFiles(v) };

function registerAllCommands() {
  const pane = () => wb.activePane();
  registerCommands({
    'preview.showRight': () => wb.showSingletonRight('preview'),
    'graph.showRight': () => wb.showSingletonRight('graph'),
    'screen.open': () => openScreenDialog(wb),
    'settings.open': () => toggleSettings(settingsCtx),
    'tab.close': () => wb.closeActive(),
    'tab.splitRight': () => wb.splitActive('right'),
    'tab.next': () => wb.cycle(1),
    'tab.prev': () => wb.cycle(-1),
    'group.focus1': () => wb.focusGroup(0),
    'group.focus2': () => wb.focusGroup(1),
    'group.focus3': () => wb.focusGroup(2),
    'group.focus4': () => wb.focusGroup(3),
    'edit.rename': () => {
      if (sidebar.hasFocus()) sidebar.renameFocused();
      else if (pane() && pane().rename) pane().rename();
    },
    'edit.selectAll': () => { if (!sidebar.hasFocus() && pane() && pane().selectAll) pane().selectAll(); },
    'view.resetZoom': () => { if (pane()) pane().resetZoom(); },
    'view.refresh': () => {
      const p = pane();
      if (p && p.kind === 'gallery') p.reload();
      else if (p && p.kind === 'graph') p.rebuild();
      emit('refresh-requested');
    },
  });
}

/** Top-bar hint, rendered from the current bindings. */
function renderHint() {
  $('topbar-hint').textContent = `${keyLabel('tab.splitRight')} 分割・${keyLabel('tab.close')} 閉じる・${keyLabel('preview.showRight')} Preview・${keyLabel('graph.showRight')} グラフ・${keyLabel('settings.open')} 設定`;
}

async function boot() {
  try {
    state.info = await api.appInfo();
    state.settings = await api.getSettings();
    setLib(await api.getLib());
  } catch (e) {
    toastError(e, '初期化に失敗しました。');
    return;
  }
  const savedLayout = state.settings.layout ? JSON.parse(JSON.stringify(state.settings.layout)) : null;

  initKeymap();
  registerAllCommands();
  renderHint();
  on('keymap-changed', renderHint);
  $('btn-settings').addEventListener('click', () => toggleSettings(settingsCtx));
  initResizers();
  sidebar.initSidebar(wb);
  initInspector(wb);
  $('btn-tag-manager').addEventListener('click', () => openTagManager());
  document.addEventListener('keydown', onKeyDown);
  api.onFsChanged((dirs) => emit('fs-changed', dirs));

  await sidebar.loadRoots();
  await wb.init($('workbench'));
  const g = wb.mruGalleryPane();
  if (g && g.source && g.source.kind === 'folder') sidebar.revealPath(g.source.path);

  try {
    for (const w of await api.warnings()) toast(w, 'error', 10000);
  } catch { /* ignore */ }

  if (state.info.smoke) {
    const smoke = await import('./smoke.js');
    smoke.run({ wb, sidebar, savedLayout, galleries });
  }
}

boot();
