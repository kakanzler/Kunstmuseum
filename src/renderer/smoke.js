// Smoke test sequence (KM_SMOKE=1). Phase 1 runs against a fresh userData;
// phase 2 is a second launch against the same userData and verifies that the
// persisted layout was restored. Operates only on the smoke fixtures.
import { api, state, setLib, samePath, on, pathUnder } from './state.js';
import { LayoutModel } from './layout-model.js';
import { addTagsToPaths, openTagManager } from './tags.js';
import { renameFolderTo } from './ops.js';

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

  // 3. tags + filter
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
  step(`second launch restored the layout ${JSON.stringify(report.restored)}`);
}

