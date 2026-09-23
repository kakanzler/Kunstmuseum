// Renderer entry point: bootstrap, global keyboard routing, panel resizers,
// smoke test.
import { api, state, setLib, saveSettings, emit, flushSettings, galleries } from './state.js';
import { toast, toastError, isModalOpen, isEditable } from './ui.js';
import * as sidebar from './sidebar.js';
import { initInspector } from './inspector.js';
import { openTagManager } from './tags.js';
import { wb } from './workbench.js';
import { openScreenDialog, isScreenActive } from './screen.js';

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

function isScreenShortcut(e) {
  return (e.ctrlKey || e.metaKey) && e.altKey && e.shiftKey && (e.code === 'KeyO' || e.key.toLowerCase() === 'o');
}

function onKeyDown(e) {
  if (isScreenActive()) return; // the slideshow owns the keyboard (capture listener)
  if (isScreenShortcut(e)) {
    // スクリーン表示: from anywhere, except while editing text or in another modal
    if (isModalOpen() || isEditable(e.target)) return;
    e.preventDefault();
    openScreenDialog(wb);
    return;
  }
  if (isModalOpen()) return;
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === 'KeyP' || e.key.toLowerCase() === 'p')) {
    // Alt+P: Preview in the group to the right (focus stays here)
    if (isEditable(e.target)) return;
    e.preventDefault();
    wb.showPreviewRight();
    return;
  }
  if (wb.handleKey(e)) return;                 // Ctrl+W, Ctrl+\, Ctrl+1..4, Ctrl+Tab
  if (isEditable(e.target)) return;
  if (sidebar.hasFocus()) { sidebar.handleKey(e); return; }
  const p = wb.activePane();
  if ((e.ctrlKey || e.metaKey) && e.key === '0') {
    e.preventDefault();
    if (p) p.resetZoom();
    return;
  }
  if (p && p.handleKey) p.handleKey(e);
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
