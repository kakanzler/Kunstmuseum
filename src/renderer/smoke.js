// Smoke test sequence (KM_SMOKE=1). Phase 1 runs against a fresh userData;
// phase 2 is a second launch against the same userData and verifies that the
// persisted layout was restored. Operates only on the smoke fixtures.
import { api, state, setLib, samePath, on, pathUnder } from './state.js';
import { LayoutModel } from './layout-model.js';
import { addTagsToPaths, openTagManager } from './tags.js';
import { renameFolderTo } from './ops.js';
import { inspectorPreviewImg } from './inspector.js';
import { activeShow } from './screen.js';
import { isCapturing } from './settings.js';
import { bindings } from './commands.js';
import { toOverrides } from './keymap.js';
import { flushSettings } from './state.js';
import { fileUrl } from './ui.js';

const TAB_TYPE = 'application/x-km-tab';

function waitFor(cond, ms, what) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const tick = () => {
      let v;
      try { v = cond(); } catch { v = false; }
      if (v) return resolve(v);
      if (performance.now() - t0 > ms) return reject(new Error(`timeout: ${what}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function waitForAsync(fn, ms, what) {
  const t0 = performance.now();
  for (;;) {
    if (await fn()) return true;
    if (performance.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const kinds = (wb) => wb.model.groups.map((g) => g.tabs.map((t) => t.kind));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function key(init) {
  document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

function tabEl(tabId) {
  return document.querySelector(`.etab[data-tab="${tabId}"]`);
}

export async function run({ wb, sidebar, savedLayout }) {
  const phase = Number(state.info.smokePhase || 1);
  const report = { ok: false, phase, steps: [] };
  const step = (s) => { report.steps.push(s); console.log(`[smoke] ${s}`); };
  try {
    if (phase === 2) await phase2({ wb, savedLayout, step, report });
    else await phase1({ wb, sidebar, step, report });
    report.ok = true;
  } catch (e) {
    report.error = String((e && e.stack) || e);
    console.error('[smoke] failed', report.error);
  }
  api.smokeReport(report);
}

async function phase1({ wb, sidebar, step, report }) {
  const expect = Number(state.info.smokeExpect || 1);
  const fsEvents = [];
  on('fs-changed', (dirs) => fsEvents.push(...dirs));

  // 1. default layout
  assert(sameJson(kinds(wb), [['gallery'], ['preview']]), `default layout ${JSON.stringify(kinds(wb))}`);
  const g1 = wb.model.groups[0].id;
  const galleryTabId = wb.model.groups[0].tabs[0].id;
  const previewTabId = wb.model.groups[1].tabs[0].id;
  const g = wb.pane(galleryTabId);
  const preview = wb.pane(previewTabId);
  step('default layout: gallery | Preview');

  await waitFor(() => g.grid.querySelectorAll('.tile').length >= expect, 20000, 'gallery tiles');
  report.tiles = g.grid.querySelectorAll('.tile').length;
  await waitFor(() => {
    const imgs = [...g.grid.querySelectorAll('img')].filter((i) => i.getAttribute('src'));
    return imgs.length >= 1 && imgs.every((i) => i.complete);
  }, 20000, 'thumbnails');
  const imgs = [...g.grid.querySelectorAll('img')].filter((i) => i.getAttribute('src'));
  report.brokenThumbs = imgs.filter((i) => !i.naturalWidth).map((i) => decodeURIComponent(i.src));
  assert(!report.brokenThumbs.length, 'broken thumbnails');
  step(`gallery rendered ${report.tiles} tiles, ${imgs.length} thumbnails loaded`);

  // 2. selecting a thumbnail updates Preview
  g.selectIndex(0);
  const first = g.view[0];
  await waitFor(() => preview.viewer.item && preview.viewer.item.path === first.path && preview.viewer.img.naturalWidth > 0, 10000, 'preview image');
  const ptab = tabEl(previewTabId);
  assert(ptab.textContent.includes(`Preview: ${first.name}`), 'preview tab title');
  assert(ptab.classList.contains('italic'), 'preview tab italic');
  step(`Preview follows selection (${first.name})`);

  // 2b. no flash on selection: nothing is rebuilt or blanked while the selection changes
  {
    const fsBefore = fsEvents.length;
    const inspImg0 = inspectorPreviewImg();
    const st = { grid: 0, tabbar: 0, srcEmpty: 0, swapNotReady: 0, blankFrames: 0, hiddenFrames: 0, inspBlankFrames: 0, inspReplaced: 0, frames: 0 };
    const mo = new MutationObserver((recs) => {
      for (const r of recs) {
        const t = r.target;
        if (r.type === 'childList' && g.grid.contains(t)) st.grid++;
        else if (r.type === 'childList' && t.closest && t.closest('.tabbar')) st.tabbar++;
        else if (r.type === 'attributes' && t === preview.viewer.img) {
          if (!t.getAttribute('src')) st.srcEmpty++;
          else if (!t.complete || !t.naturalWidth) st.swapNotReady++;
        }
      }
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
    let sampling = true;
    const sample = () => {
      if (!sampling) return;
      st.frames++;
      const im = preview.viewer.img;
      if (getComputedStyle(im).visibility === 'hidden') st.hiddenFrames++;
      else if (!im.getAttribute('src') || !im.complete || !im.naturalWidth) st.blankFrames++;
      const ii = inspectorPreviewImg();
      if (ii !== inspImg0) st.inspReplaced++;
      else if (!ii.getAttribute('src') || !ii.complete || !ii.naturalWidth) st.inspBlankFrames++;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    for (let k = 1; k <= 4; k++) {
      g.selectIndex(k % g.view.length);
      await new Promise((res) => setTimeout(res, 350));
    }
    // rapid changes: stale loads must be ignored, the last pick wins
    g.selectIndex(1); g.selectIndex(2); g.selectIndex(3);
    const last = g.view[3];
    await waitFor(() => preview.viewer.item && preview.viewer.item.path === last.path && preview.viewer.img.getAttribute('src') === fileUrl(last), 5000, 'last rapid pick shown');
    await new Promise((res) => setTimeout(res, 900)); // a watcher event would arrive within ~500 ms
    sampling = false;
    mo.disconnect();
    st.fsEvents = fsEvents.length - fsBefore;
    report.flash = st;
    assert(st.grid === 0, `grid tiles recreated on selection (${st.grid})`);
    assert(st.tabbar === 0, `tab bar rebuilt on selection (${st.tabbar})`);
    assert(st.srcEmpty === 0 && st.swapNotReady === 0, `Preview img swapped to empty/undecoded (${st.srcEmpty}/${st.swapNotReady})`);
    assert(st.blankFrames === 0 && st.hiddenFrames === 0, `Preview painted blank frames (${st.blankFrames}/${st.hiddenFrames})`);
    assert(st.inspReplaced === 0 && st.inspBlankFrames === 0, `inspector preview replaced/blank (${st.inspReplaced}/${st.inspBlankFrames})`);
    assert(st.fsEvents === 0, `selection caused ${st.fsEvents} watcher refreshes (access-time events)`);
    step(`no flash on selection (${st.frames} frames observed)`);
  }

  // 3. tags + filter
  g.selectIndex(0);
  g.selectIndex(1, { range: true });
  const paths = g.selectedPaths();
  const r = await api.addTag({ name: 'スモーク', typeId: state.lib.tagTypes[0].id });
  setLib(r.lib);
  const tagId = r.tag.id;
  await addTagsToPaths(paths, [tagId]);
  await waitFor(() => document.querySelectorAll('#inspector .insp-tags .chip').length >= 1, 5000, 'inspector tag chip');
  g.setTagFilter([tagId]);
  await waitFor(() => g.grid.querySelectorAll('.tile').length === paths.length, 5000, 'tag filter');
  g.setTagFilter([]);
  step(`tagged ${paths.length} images, filter ok`);

  // 4. graph tab
  const graphTab = wb.addFromMenu(g1, 'graph');
  const graph = wb.pane(graphTab.id);
  await waitFor(() => graph.nodeCount() >= paths.length + 1, 10000, 'graph nodes');
  report.graphNodes = graph.nodeCount();
  step(`graph rendered ${report.graphNodes} nodes`);

  // 5. drag the graph tab onto the left half of its group → new left group; closing it removes the group
  const body = wb.groupEls.get(g1).body;
  const rect = body.getBoundingClientRect();
  const dt = new DataTransfer();
  dt.setData(TAB_TYPE, graphTab.id);
  const at = { clientX: rect.left + 10, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true, dataTransfer: dt };
  body.dispatchEvent(new DragEvent('dragover', at));
  body.dispatchEvent(new DragEvent('drop', at));
  assert(sameJson(kinds(wb), [['graph'], ['gallery'], ['preview']]), `after tab drop ${JSON.stringify(kinds(wb))}`);
  wb.closeTab(graphTab.id);
  assert(sameJson(kinds(wb), [['gallery'], ['preview']]), `after close ${JSON.stringify(kinds(wb))}`);
  step('tab dropped into new left group; closing it removed the group');

  // 6. double-click opens a pinned image tab in the Preview group
  g.selectIndex(0);
  const tile0 = g.grid.querySelector('.tile[data-i="0"]');
  tile0.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const imgTab = wb.model.findImageTab(first.path);
  assert(imgTab, 'image tab opened');
  assert(wb.model.groupOf(imgTab.id) === wb.model.groupOf(previewTabId), 'image tab in the Preview group');
  assert(wb.model.activeTab().id === imgTab.id, 'image tab active');
  const ip = wb.pane(imgTab.id);
  await ip.loading;
  await waitFor(() => ip.viewer.natW > 0, 5000, 'image tab loaded');
  step('double-click opened image tab in the Preview group');

  // 7. zoom reset in both viewers (Ctrl+0 and middle-click)
  const checkReset = async (viewer, label) => {
    viewer.fit();
    const fitScale = viewer.scale;
    viewer.zoomBy(3);
    assert(!viewer.fitted && viewer.scale !== fitScale, `${label} zoomed`);
    key({ key: '0', code: 'Digit0', ctrlKey: true });
    assert(viewer.fitted && Math.abs(viewer.scale - fitScale) < 1e-9, `${label} Ctrl+0 reset`);
    viewer.zoomBy(2.5);
    viewer.stage.dispatchEvent(new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true }));
    assert(viewer.fitted && Math.abs(viewer.scale - fitScale) < 1e-9, `${label} middle-click reset`);
    return `${label} ${Math.round(fitScale * 100)}%`;
  };
  const z1 = await checkReset(ip.viewer, 'image tab');
  wb.activate(previewTabId);
  await waitFor(() => preview.viewer.natW > 0 && preview.visible, 5000, 'preview visible');
  const z2 = await checkReset(preview.viewer, 'Preview');
  wb.activate(imgTab.id);
  step(`zoom reset ok (${z1}, ${z2})`);

  // 8. duplicate the gallery via split (Ctrl+\), then close it (Ctrl+W)
  wb.activate(galleryTabId);
  key({ key: '\\', code: 'Backslash', ctrlKey: true });
  assert(wb.model.groups.length === 3, 'split created a group');
  const dupTab = wb.model.activeTab();
  assert(dupTab.kind === 'gallery' && dupTab.id !== galleryTabId, 'duplicate gallery active');
  const dup = wb.pane(dupTab.id);
  await dup.loadPromise;
  assert(dup.source && samePath(dup.source.path, g.source.path), 'duplicate has the same folder');
  assert(sameJson(dup.selectedPaths(), g.selectedPaths()), 'duplicate has the same selection');
  assert(dup.thumbSize === g.thumbSize && dup.sortKey === g.sortKey, 'duplicate has the same view state');
  key({ key: 'w', code: 'KeyW', ctrlKey: true });
  assert(!wb.model.tab(dupTab.id) && wb.model.groups.length === 2, 'Ctrl+W closed the duplicate');
  step('gallery duplicated via Ctrl+\\ and closed via Ctrl+W');

  // 9. sidebar lists files with extensions; file click drives Preview
  const root = state.roots[0].path;
  await sidebar.expandFolder(root);
  const files = sidebar.visibleFileRows();
  assert(files.length >= 5, `tree file rows ${files.length}`);
  assert(files.every((f) => f.label === f.name && /\.[a-z0-9]+$/i.test(f.label)), 'file labels include extensions');
  const bmp = files.find((f) => f.name.endsWith('.bmp'));
  document.querySelector(`.tree-row.file[data-path="${CSS.escape(bmp.path)}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert(state.selection.primary === bmp.path && state.selection.origin.kind === 'tree', 'tree click set the global selection');
  await waitFor(() => tabEl(previewTabId).textContent.includes(`Preview: ${bmp.name}`), 3000, 'preview title from tree');
  assert(g.selection.has(bmp.path), 'gallery mirrored the tree selection');
  step(`sidebar lists ${files.length} files with extensions; tree click drives Preview`);

  // 10. inline rename in the gallery: tags and the image tab follow
  g.startRename(g.itemsByPath.get(first.path));
  const inp = await waitFor(() => g.grid.querySelector('.cap input'), 3000, 'inline rename');
  inp.value = first.name.replace(/(\.[^.]+)$/, ' renamed$1');
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const renamed = await waitFor(() => g.items.find((it) => it.name.includes(' renamed')), 5000, 'renamed item');
  const hasTag = async (p) => ((await api.getImageTags([p]))[p] || []).includes(tagId);
  assert(await hasTag(renamed.path), 'tags followed rename');
  assert(wb.model.tab(imgTab.id).path === renamed.path, 'image tab followed rename');
  step('inline rename: tags and image tab followed');

  // 11. case-only rename and conflict refusal
  const gif = g.items.find((it) => it.name === 'anim.gif');
  const up = await api.renameFile(gif.path, 'ANIM.gif');
  assert(up.to.endsWith('ANIM.gif'), 'case-only rename');
  const ico = g.items.find((it) => it.name === 'icon.ico');
  let refused = false;
  try { await api.renameFile(ico.path, 'anim.gif'); } catch { refused = true; }
  assert(refused, 'rename onto an existing file refused');
  step('case-only rename ok, conflict refused');

  // 12. tree → folder drag & drop move (tags and image tab follow)
  const row = await waitFor(() => document.querySelector(`.tree-row.file[data-path="${CSS.escape(renamed.path)}"]`), 5000, 'renamed file in tree');
  const subRow = document.querySelector('.tree-row.folder[data-path$="Sub フォルダ"]');
  assert(subRow, 'sub folder row');
  const dt2 = new DataTransfer();
  row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
  subRow.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
  subRow.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
  const movedPath = `${subRow.dataset.path}\\${renamed.name}`;
  await waitFor(() => wb.model.tab(imgTab.id).path === movedPath, 5000, 'image tab followed move');
  assert(await hasTag(movedPath), 'tags followed tree move');
  step('tree → folder move: tags and image tab followed');

  // 13. folder rename (tags + image tab follow)
  const rd = await renameFolderTo(subRow.dataset.path, 'Sub 改名');
  assert(rd, 'folder renamed');
  const inRenamed = `${rd.to}\\${renamed.name}`;
  assert(await hasTag(inRenamed), 'tags followed folder rename');
  assert(wb.model.tab(imgTab.id).path === inRenamed, 'image tab followed folder rename');
  await g.reload();
  step('folder rename: tags and image tab followed');

  // watcher: batched fs-changed events arrive for the touched folders
  await waitFor(() => fsEvents.some((d) => pathUnder(d, root)), 5000, 'fs-changed from the root watcher');
  report.fsChangedDirs = [...new Set(fsEvents)].length;
  step(`root watcher delivered ${report.fsChangedDirs} changed folders`);

  // 14. tag manager opens/closes
  const tm = openTagManager();
  await waitFor(() => document.querySelector('.modal .tm'), 3000, 'tag manager');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tm;
  step('tag manager ok');

  // 15. スクリーン表示モード
  await screenModeChecks({ wb, root, tagId, step, report });

  // 16. Alt+P: Preview in the group right of the gallery, focus stays on the gallery
  {
    const altP = () => key({ key: 'p', code: 'KeyP', altKey: true });
    const galGroup = () => wb.model.groupOf(galleryTabId);
    const prevTab = () => wb.model.findSingleton('preview');
    const checkRight = async (label) => {
      const pt = prevTab();
      assert(pt, `${label}: Preview exists`);
      const pgI = wb.model.groupIndex(wb.model.groupOf(pt.id).id);
      assert(pgI === wb.model.groupIndex(galGroup().id) + 1, `${label}: Preview is right of the gallery group (${JSON.stringify(kinds(wb))})`);
      assert(wb.model.groupOf(pt.id).activeTabId === pt.id, `${label}: Preview is the active tab of its group`);
      assert(wb.model.activeGroupId === galGroup().id, `${label}: active group stays on the gallery`);
      assert(document.activeElement === g.grid, `${label}: keyboard focus stays in the gallery`);
      const pv = wb.pane(pt.id);
      const sel = g.view[0];
      await waitFor(() => pv.viewer.item && pv.viewer.item.path === sel.path && pv.viewer.img.naturalWidth > 0, 5000, `${label}: Preview shows the selection`);
    };
    const focusGallery = () => {
      wb.activate(galleryTabId);
      g.grid.focus({ preventScroll: true });
      g.selectIndex(0);
    };

    wb.closeTab(prevTab().id);
    assert(!prevTab(), 'Preview closed');
    focusGallery();
    altP();
    await checkRight('Alt+P (no Preview)');
    const snap = JSON.stringify(wb.model.serialize((t) => t.state));
    altP();
    assert(JSON.stringify(wb.model.serialize((t) => t.state)) === snap, 'second Alt+P changes nothing');
    await checkRight('Alt+P again');
    // drag Preview to the far left, then Alt+P brings it back to the right of the gallery
    wb.model.dropTab(prevTab().id, wb.model.groups[0].id, 'left');
    wb.commit();
    assert(wb.model.groupIndex(wb.model.groupOf(prevTab().id).id) < wb.model.groupIndex(galGroup().id), 'Preview moved left');
    focusGallery();
    altP();
    await checkRight('Alt+P after moving Preview left');
    step(`Alt+P shows Preview right of the gallery, focus kept (${JSON.stringify(kinds(wb))})`);
  }

  // 17. Alt+Q: knowledge graph right of the gallery, focus kept
  {
    wb.activate(galleryTabId);
    g.grid.focus({ preventScroll: true });
    key({ key: 'q', code: 'KeyQ', altKey: true });
    const gt = wb.model.findSingleton('graph');
    assert(gt, 'Alt+Q opened the graph');
    const gg = wb.model.groupOf(gt.id);
    assert(wb.model.groupIndex(gg.id) === wb.model.groupIndex(wb.model.groupOf(galleryTabId).id) + 1, 'graph right of the gallery ' + JSON.stringify(kinds(wb)));
    assert(gg.activeTabId === gt.id, 'graph is the active tab of its group');
    assert(wb.model.activeGroupId === wb.model.groupOf(galleryTabId).id, 'active group stays on the gallery');
    assert(document.activeElement === g.grid, 'keyboard focus stays in the gallery');
    await waitFor(() => wb.pane(gt.id).nodeCount() > 0, 10000, 'graph rendered after Alt+Q');
    step('Alt+Q shows the graph right of the gallery, focus kept ' + JSON.stringify(kinds(wb)));
  }

  // 18. 設定 and the editable keymap
  await settingsChecks({ wb, g, galleryTabId, step, report });

  // 15. layout serialize/restore roundtrip, then persist for phase 2
  const ser = JSON.parse(JSON.stringify(wb.serialize()));
  const back = LayoutModel.restore(ser, { caseInsensitive: state.info.platform === 'win32' }).serialize((t) => t.state);
  assert(sameJson(back, ser), 'in-process layout roundtrip');
  await wb.saveNow();
  report.layoutTabs = kinds(wb);
  step(`layout roundtrip ok and saved ${JSON.stringify(report.layoutTabs)}`);
}

function comparable(layout) {
  const l = JSON.parse(JSON.stringify(layout));
  for (const g of l.groups) for (const t of g.tabs) if (t.state) delete t.state.scrollTop;
  return l;
}

async function phase2({ wb, savedLayout, step, report }) {
  assert(savedLayout && Array.isArray(savedLayout.groups), 'a layout was persisted by phase 1');
  await Promise.all([...wb.panes.values()].map((p) => p.loadPromise || p.loading));
  const now = wb.serialize();
  report.restored = kinds(wb);
  assert(sameJson(comparable(now), comparable(savedLayout)), `restored layout differs:\n${JSON.stringify(comparable(now))}\n${JSON.stringify(comparable(savedLayout))}`);
  assert(wb.model.allTabs().some((t) => t.kind === 'image'), 'image tab restored');

  // keymap override from phase 1 survived the relaunch
  assert(bindings().get('graph.showRight') === 'Ctrl+Alt+P', 'override restored (' + bindings().get('graph.showRight') + ')');
  key({ key: ',', code: 'Comma', ctrlKey: true });
  const sdlg = await waitFor(() => document.querySelector('.modal .settings-dialog'), 3000, '設定 opened');
  assert(sdlg.querySelector('tr[data-command="graph.showRight"] kbd').textContent === 'Ctrl+Alt+P', 'settings shows the restored override');
  // 操作説明 renders keys from the live keymap
  sdlg.querySelector('.settings-nav-item[data-section="guide"]').click();
  const guide = sdlg.querySelector('.settings-panel .guide');
  assert(guide && [...guide.querySelectorAll('kbd')].some((k) => k.textContent === 'Ctrl+Alt+P'), '操作説明 shows the current (overridden) graph key');
  // 一般: real data path + version, showFiles wired to the sidebar
  sdlg.querySelector('.settings-nav-item[data-section="general"]').click();
  const paths = await api.appPaths();
  await waitFor(() => sdlg.querySelector('.gen-path').textContent === paths.userData, 3000, 'data path shown');
  assert(sdlg.querySelector('.gen-version').textContent === paths.version && /^\d+\.\d+\.\d+/.test(paths.version), 'version shown');
  const sf = sdlg.querySelector('.gen-show-files');
  const before = document.getElementById('show-files').checked;
  sf.click();
  assert(document.getElementById('show-files').checked === !before && state.settings.showFiles === !before, 'サイドバーにファイルを表示 toggles the sidebar');
  sf.click();
  assert(document.getElementById('show-files').checked === before, 'toggled back');
  sdlg.querySelector('.settings-nav-item[data-section="hotkeys"]').click();
  step('設定 › 操作説明 uses the keymap; 一般 shows ' + paths.userData.split(/[\\/]/).pop() + ' / v' + paths.version + ' and drives the sidebar');
  sdlg.querySelector('.kb-reset-all').click();
  assert(sameJson(toOverrides(bindings()), {}), 'すべて既定に戻す cleared all overrides');
  key({ key: 'Escape', code: 'Escape' });
  await waitFor(() => !document.querySelector('.modal .settings-dialog'), 3000, '設定 closed');
  await flushSettings();
  step('keymap override survived the relaunch; すべて既定に戻す ok');
  step(`second launch restored the layout ${JSON.stringify(report.restored)}`);
}


async function screenModeChecks({ root, tagId, step, report }) {
  const dlg = () => document.querySelector('.modal .screen-dialog');
  const openDlg = async () => {
    key({ key: 'O', code: 'KeyO', ctrlKey: true, altKey: true, shiftKey: true });
    return waitFor(dlg, 3000, 'screen dialog');
  };
  const startBtn = () => [...document.querySelectorAll('.modal .modal-foot .btn.primary')].find((b) => b.textContent === 'スクリーン 開始');
  const esc = () => key({ key: 'Escape', code: 'Escape' });
  const fullScreen = () => api.isFullScreen();

  // shortcut opens, Esc closes, reopens
  await openDlg();
  esc();
  await waitFor(() => !dlg(), 3000, 'dialog closed by Esc');
  let box = await openDlg();
  step('Ctrl+Alt+Shift+O opens スクリーン表示, Esc closes, reopens');

  // folder mode, 1 s interval
  box.querySelector('input[value="folder"]').click();
  const folderSel = box.querySelector('.screen-folder');
  await waitFor(() => [...folderSel.options].some((o) => samePath(o.value, root)), 5000, 'folder options');
  folderSel.value = [...folderSel.options].find((o) => samePath(o.value, root)).value;
  box.querySelector('.screen-include').checked = true;
  box.querySelector('.screen-interval').value = '1';
  box.querySelector('.screen-order').value = 'name';
  box.querySelector('.screen-loop').checked = true;
  const wasFs = await fullScreen();
  startBtn().click();
  const show = await waitFor(() => activeShow(), 8000, 'screen mode started');
  await waitForAsync(fullScreen, 5000, 'fullscreen on');
  assert(!dlg(), 'dialog closed after start');
  // crossfade must never show an undecoded/blank layer
  let blank = 0;
  let frames = 0;
  let sampling = true;
  const sample = () => {
    if (!sampling) return;
    frames++;
    for (const l of show.layers) {
      if (l.root.classList.contains('visible') && (!l.img.getAttribute('src') || !l.img.complete || !l.img.naturalWidth)) blank++;
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  await waitFor(() => show.shownCount >= 3, 8000, 'two automatic slide advances');
  sampling = false;
  assert(blank === 0, `slides painted ${blank} blank frames`);
  step(`folder mode: ${show.playlist.length} images, advanced ${show.shownCount - 1} slides at 1 s, 0 blank of ${frames} frames`);

  // Space pauses, →/← navigate, Space resumes
  key({ key: ' ', code: 'Space' });
  assert(show.paused, 'Space paused');
  const n = show.playlist.length;
  const i0 = show.playlist.index;
  key({ key: 'ArrowRight', code: 'ArrowRight' });
  await waitFor(() => show.playlist.index === (i0 + 1) % n && show.lastShown === show.playlist.current, 3000, '→ next');
  key({ key: 'ArrowLeft', code: 'ArrowLeft' });
  await waitFor(() => show.playlist.index === i0 && show.lastShown === show.playlist.current, 3000, '← prev');
  const c0 = show.shownCount;
  await sleep(1600);
  assert(show.shownCount === c0, 'no advance while paused');
  key({ key: ' ', code: 'Space' });
  assert(!show.paused, 'Space resumed');
  await waitFor(() => show.shownCount > c0, 4000, 'advances after resume');
  step('Space pause/resume, → and ← work');

  // Esc exits, restores fullscreen state, selects the last shown image
  const last = show.lastShown;
  esc();
  await waitFor(() => !activeShow() && !document.querySelector('.screen-overlay'), 3000, 'screen mode exited');
  await waitForAsync(async () => (await fullScreen()) === wasFs, 5000, 'fullscreen state restored');
  assert(state.selection.primary === last.path, 'last shown image selected');
  step(`Esc exited; fullscreen restored to ${wasFs}; last image selected (${last.name})`);

  // category mode starts with the tagged set
  box = await openDlg();
  box.querySelector('input[value="category"]').click();
  box.querySelector('.screen-tag').value = tagId;
  startBtn().click();
  const show2 = await waitFor(() => activeShow(), 8000, 'category screen mode');
  const tagged = (await api.listTagged()).filter((it) => it.tags.includes(tagId)).map((it) => it.path).sort();
  const inShow = show2.playlist.base.map((it) => it.path).sort();
  assert(sameJson(inShow, tagged) && tagged.length > 0, `category set ${JSON.stringify(inShow)} vs ${JSON.stringify(tagged)}`);
  await waitFor(() => show2.shownCount >= 1, 5000, 'category first slide');
  esc();
  await waitFor(() => !activeShow(), 3000, 'category exit');
  await waitForAsync(async () => (await fullScreen()) === wasFs, 5000, 'fullscreen restored after category');
  step(`category mode started with the ${tagged.length} tagged images`);

  // empty set: toast, no start, dialog stays open
  const empty = await api.addTag({ name: 'スモーク空', typeId: state.lib.tagTypes[0].id });
  setLib(empty.lib);
  box = await openDlg();
  box.querySelector('input[value="category"]').click();
  box.querySelector('.screen-tag').value = empty.tag.id;
  startBtn().click();
  await waitFor(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('表示できる画像がありません')), 5000, 'empty-set toast');
  await sleep(300);
  assert(!activeShow() && dlg(), 'empty set did not start and the dialog stayed open');
  esc();
  await waitFor(() => !dlg(), 3000, 'dialog closed');
  report.screen = { folderImages: show.playlist.length, categoryImages: tagged.length };
  step('empty set: toast shown, not started');
}

async function settingsChecks({ wb, g, galleryTabId, step, report }) {
  const dlg = () => document.querySelector('.modal .settings-dialog');
  const ctrlComma = () => key({ key: ',', code: 'Comma', ctrlKey: true });
  const esc = () => key({ key: 'Escape', code: 'Escape' });
  const row = (id) => dlg().querySelector('tr[data-command="' + id + '"]');
  const msgText = () => (dlg().querySelector('.kb-msg') || {}).textContent || '';
  const openIt = async () => { ctrlComma(); return waitFor(dlg, 3000, '設定 opened'); };
  const closeIt = async () => { esc(); await waitFor(() => !dlg(), 3000, '設定 closed'); };

  await openIt();
  await closeIt();
  await openIt();
  ctrlComma();
  await waitFor(() => !dlg(), 3000, 'Ctrl+, toggles 設定 closed');
  step('Ctrl+, opens 設定, Esc closes it, Ctrl+, toggles it');

  // Esc during capture cancels without closing the modal
  await openIt();
  row('preview.showRight').querySelector('.kb-change').click();
  assert(isCapturing(), 'capture mode');
  assert(row('preview.showRight').textContent.includes('キーを押してください'), 'capture prompt shown');
  esc();
  assert(!isCapturing() && dlg(), 'Esc cancelled the capture and kept the modal open');
  assert(bindings().get('preview.showRight') === 'Alt+P', 'binding unchanged after cancel');

  // rebind Alt+P -> Ctrl+Alt+P through the capture UI (modifier-only presses are ignored)
  row('preview.showRight').querySelector('.kb-change').click();
  key({ key: 'Control', code: 'ControlLeft', ctrlKey: true });
  assert(isCapturing(), 'modifier-only press keeps capturing');
  key({ key: 'p', code: 'KeyP', ctrlKey: true, altKey: true });
  assert(bindings().get('preview.showRight') === 'Ctrl+Alt+P', 'rebound to Ctrl+Alt+P');
  assert(row('preview.showRight').querySelector('kbd').textContent === 'Ctrl+Alt+P', 'table shows the new combo');

  // invalid combo is rejected inline
  row('tab.close').querySelector('.kb-change').click();
  key({ key: 'p', code: 'KeyP' });
  assert(bindings().get('tab.close') === 'Ctrl+W' && /Ctrl または Alt/.test(msgText()), 'bare key rejected with a message');
  await closeIt();

  // the new combo works, the old one does not
  const prev = () => wb.model.findSingleton('preview');
  if (prev()) wb.closeTab(prev().id);
  wb.activate(galleryTabId);
  g.grid.focus({ preventScroll: true });
  key({ key: 'p', code: 'KeyP', altKey: true });
  assert(!prev(), 'old Alt+P no longer opens Preview');
  key({ key: 'p', code: 'KeyP', ctrlKey: true, altKey: true });
  assert(prev(), 'Ctrl+Alt+P opens Preview');
  assert(wb.model.groupIndex(wb.model.groupOf(prev().id).id) === wb.model.groupIndex(wb.model.groupOf(galleryTabId).id) + 1, 'Preview right of the gallery');
  assert(document.activeElement === g.grid, 'focus kept');
  assert(document.getElementById('topbar-hint').textContent.includes('Ctrl+Alt+P'), 'top-bar hint follows the keymap');
  step('rebound Preview to Ctrl+Alt+P via capture: new combo works, Alt+P does not; Esc cancels capture; invalid key rejected');

  // conflict: graph -> Ctrl+Alt+P asks to swap
  await openIt();
  row('graph.showRight').querySelector('.kb-change').click();
  key({ key: 'p', code: 'KeyP', ctrlKey: true, altKey: true });
  await waitFor(() => dlg().querySelector('.kb-swap'), 2000, 'conflict prompt');
  assert(msgText().includes('Preview を右に表示 と重複しています。入れ替えますか？'), 'conflict message: ' + msgText());
  assert(bindings().get('graph.showRight') === 'Alt+Q', 'nothing changes before confirming');
  dlg().querySelector('.kb-swap').click();
  assert(bindings().get('graph.showRight') === 'Ctrl+Alt+P' && bindings().get('preview.showRight') === 'Alt+Q', 'bindings swapped');
  step('conflict detected and swapped (graph Ctrl+Alt+P, Preview Alt+Q)');

  // 既定に戻す: Preview back to Alt+P (free now)
  row('preview.showRight').querySelector('.kb-reset').click();
  assert(bindings().get('preview.showRight') === 'Alt+P', '既定に戻す restored Alt+P');
  assert(row('preview.showRight').querySelector('.kb-reset').disabled, 'reset disabled at default');
  await closeIt();
  await flushSettings();
  report.keybindings = toOverrides(bindings());
  assert(sameJson(report.keybindings, { 'graph.showRight': 'Ctrl+Alt+P' }), 'overrides ' + JSON.stringify(report.keybindings));
  const saved = (await api.getSettings()).keybindings;
  assert(sameJson(saved, { 'graph.showRight': 'Ctrl+Alt+P' }), 'persisted overrides ' + JSON.stringify(saved));
  step('既定に戻す ok; override persisted {graph.showRight: Ctrl+Alt+P}');
}
