'use strict';
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const {
  app, BrowserWindow, Menu, protocol, net, nativeImage, ipcMain, dialog, shell, clipboard, screen, powerSaveBlocker,
} = require('electron');
const fsops = require('./fsops');
const { Store } = require('./store');

// ---------------------------------------------------------------------------
// Smoke-test mode: isolated userData, fixture folder, exit code 0/1.
// ---------------------------------------------------------------------------
const SMOKE = process.env.KM_SMOKE === '1';
if (SMOKE) {
  const ud = process.env.KM_SMOKE_USERDATA;
  if (!ud) {
    console.error('[smoke] KM_SMOKE_USERDATA is required so real user data is never touched');
    process.exit(1);
  }
  fs.mkdirSync(ud, { recursive: true });
  app.setPath('userData', ud);
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'kmimg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let store = null;
let mainWindow = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function assertInRoots(p, what = 'パス') {
  if (typeof p !== 'string' || !p) throw new Error(`${what}が不正です。`);
  if (!store.isInRoots(p)) throw new Error(`${what}が登録フォルダの外にあります: ${p}`);
  return path.resolve(p);
}

function userError(e) {
  // Re-throw with a user-facing Japanese message (the renderer toasts it).
  const msg = fsops.describeError(e);
  const err = new Error(msg);
  err.code = e && e.code;
  return err;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_ev, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      throw userError(e);
    }
  });
}

// ---------------------------------------------------------------------------
// kmimg:// protocol
// ---------------------------------------------------------------------------
const THUMB_MAX = 500;
const thumbCache = new Map(); // key → Buffer (Map preserves insertion order → LRU)
const thumbInflight = new Map();
let thumbActive = 0;
const thumbQueue = [];

function thumbLimit(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      thumbActive++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        thumbActive--;
        const next = thumbQueue.shift();
        if (next) next();
      });
    };
    if (thumbActive < 6) run();
    else thumbQueue.push(run);
  });
}

function cacheGet(key) {
  const v = thumbCache.get(key);
  if (v) {
    thumbCache.delete(key);
    thumbCache.set(key, v);
  }
  return v;
}

function cacheSet(key, buf) {
  thumbCache.set(key, buf);
  while (thumbCache.size > THUMB_MAX) thumbCache.delete(thumbCache.keys().next().value);
}

const forbidden = () => new Response('Forbidden', { status: 403 });
const CORS = { 'access-control-allow-origin': '*' };

function resolveRequestPath(url) {
  let p;
  try {
    p = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
  if (!p || !path.isAbsolute(p)) return null;
  p = path.resolve(p);
  if (!fsops.isSupported(p) || !store.isInRoots(p)) return null;
  return p;
}

async function serveFile(p) {
  const res = await net.fetch(pathToFileURL(p).toString());
  if (!res.ok) return new Response('Not found', { status: 404, headers: CORS });
  const headers = new Headers(res.headers);
  headers.set('access-control-allow-origin', '*');
  if (fsops.extOf(p) === '.svg') headers.set('content-type', 'image/svg+xml');
  return new Response(res.body, { status: 200, headers });
}

async function serveThumb(p) {
  const ext = fsops.extOf(p);
  if (fsops.PASSTHROUGH_EXTS.has(ext)) return serveFile(p);
  let st;
  try {
    st = await fsp.stat(p);
  } catch {
    return new Response('Not found', { status: 404, headers: CORS });
  }
  const key = `${p}|${st.mtimeMs}|${st.size}`;
  let buf = cacheGet(key);
  if (!buf) {
    let pending = thumbInflight.get(key);
    if (!pending) {
      pending = thumbLimit(async () => {
        const img = await nativeImage.createThumbnailFromPath(p, { width: 320, height: 320 });
        if (!img || img.isEmpty()) throw new Error('empty thumbnail');
        return img.toPNG();
      }).finally(() => thumbInflight.delete(key));
      thumbInflight.set(key, pending);
    }
    try {
      buf = await pending;
      cacheSet(key, buf);
    } catch {
      return serveFile(p); // thumbnail provider failed → full image
    }
  }
  return new Response(buf, { status: 200, headers: { 'content-type': 'image/png', ...CORS } });
}

function registerProtocol() {
  protocol.handle('kmimg', async (request) => {
    try {
      const url = new URL(request.url);
      const p = resolveRequestPath(url);
      if (!p) return forbidden();
      if (url.hostname === 'file') return await serveFile(p);
      if (url.hostname === 'thumb') return await serveThumb(p);
      return forbidden();
    } catch (e) {
      return new Response(String(e && e.message), { status: 500 });
    }
  });
}

// ---------------------------------------------------------------------------
// Folder watchers: one recursive fs.watch per registered root. Changed
// directories are batched over a 500 ms debounce and broadcast.
// ---------------------------------------------------------------------------
const watchers = new Map(); // normKey(root) → { root, watcher }
const changedDirs = new Set();
let changeTimer = null;

function queueChange(dir) {
  changedDirs.add(dir);
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    const dirs = [...changedDirs];
    changedDirs.clear();
    if (mainWindow && !mainWindow.isDestroyed() && dirs.length) mainWindow.webContents.send('fs:changed', dirs);
  }, 500);
}

function watchRoot(root) {
  const key = fsops.normKey(root);
  if (watchers.has(key)) return;
  try {
    const w = fs.watch(root, { recursive: true }, (type, filename) => {
      if (!filename) { queueChange(root); return; }
      const full = path.join(root, String(filename));
      if (type !== 'change') { queueChange(path.dirname(full)); return; }
      // Reading an image (Preview, thumbnails, scans) updates its last-access
      // time, which Windows reports as 'change'; folders report their own
      // timestamp updates the same way. Ignore both, otherwise every
      // selection reloads the gallery and rebuilds all tiles (visible flash).
      fs.stat(full, (err, st) => {
        if (!err && fsops.isIgnorableChange(type, st)) return;
        queueChange(path.dirname(full));
      });
    });
    w.on('error', () => unwatchRoot(root));
    watchers.set(key, { root, watcher: w });
  } catch {
    /* missing or inaccessible root: not watched */
  }
}

function unwatchRoot(root) {
  const key = fsops.normKey(root);
  const e = watchers.get(key);
  if (!e) return;
  try { e.watcher.close(); } catch { /* ignore */ }
  watchers.delete(key);
}

/** Make the watcher set match the registered roots. */
function syncWatchers() {
  const want = new Map(store.getRoots().map((r) => [fsops.normKey(r), r]));
  for (const [key, e] of [...watchers]) if (!want.has(key)) unwatchRoot(e.root);
  for (const r of want.values()) watchRoot(r);
}

function stopAllWatchers() {
  for (const e of [...watchers.values()]) unwatchRoot(e.root);
  clearTimeout(changeTimer);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function libSnapshot() {
  return { tagTypes: store.listTagTypes(), tags: store.listTags(), usage: store.tagUsage() };
}

function rootsInfo() {
  return store.getRoots().map((r) => {
    let exists = false;
    try { exists = fs.statSync(r).isDirectory(); } catch { /* missing */ }
    return { path: r, name: path.basename(r) || r, exists };
  });
}

async function addRootPaths(paths) {
  const added = [];
  const rejected = [];
  for (const p of paths || []) {
    try {
      const st = await fsp.stat(p);
      if (!st.isDirectory()) { rejected.push(p); continue; }
      if (store.addRoot(p)) added.push(path.resolve(p));
    } catch {
      rejected.push(p);
    }
  }
  return { roots: rootsInfo(), added, rejected };
}

function registerIpc() {
  handle('app:info', () => ({
    platform: process.platform,
    smoke: SMOKE,
    smokeExpect: SMOKE ? Number(process.env.KM_SMOKE_EXPECT || 1) : 0,
    smokePhase: SMOKE ? Number(process.env.KM_SMOKE_PHASE || 1) : 0,
    version: app.getVersion(),
    exts: fsops.SUPPORTED_EXTS,
  }));
  handle('app:warnings', () => (store.loadWarning ? [store.loadWarning] : []));

  handle('settings:get', () => store.getSettings());
  handle('settings:set', (partial) => store.setSettings(partial));

  handle('roots:list', () => rootsInfo());
  handle('roots:addDialog', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'フォルダを追加',
      properties: ['openDirectory', 'multiSelections'],
    });
    if (r.canceled) return { roots: rootsInfo(), added: [], rejected: [] };
    const res = await addRootPaths(r.filePaths);
    syncWatchers();
    return res;
  });
  handle('roots:add', async (paths) => {
    const res = await addRootPaths(Array.isArray(paths) ? paths : []);
    syncWatchers();
    return res;
  });
  handle('roots:remove', (p) => {
    store.removeRoot(p);
    syncWatchers();
    return rootsInfo();
  });

  handle('fs:subdirs', async (dir) => fsops.listSubdirs(assertInRoots(dir, 'フォルダ')));
  handle('fs:listDir', async (dir) => fsops.listDir(assertInRoots(dir, 'フォルダ')));
  handle('fs:exists', async (paths) => {
    const out = {};
    await Promise.all((Array.isArray(paths) ? paths : []).map(async (p) => {
      if (typeof p !== 'string' || !store.isInRoots(p)) { out[p] = false; return; }
      try { out[p] = (await fsp.stat(p)).isFile(); } catch { out[p] = false; }
    }));
    return out;
  });
  handle('fs:scan', async (dir, recursive) => {
    const d = assertInRoots(dir, 'フォルダ');
    const items = await fsops.scanFolder(d, { recursive: !!recursive });
    for (const it of items) it.tags = store.getImageTags(it.path);
    return items;
  });
  handle('fs:listTagged', async () => {
    const out = [];
    const list = store.listTaggedImages().filter((e) => store.isInRoots(e.path));
    await Promise.all(list.map(async (e) => {
      try {
        const st = await fsp.stat(e.path);
        if (!st.isFile()) return;
        out.push({ path: e.path, name: path.basename(e.path), size: st.size, mtime: st.mtimeMs, ext: fsops.extOf(e.path), tags: e.tags });
      } catch { /* missing: ignored */ }
    }));
    return out;
  });
  handle('fs:stat', async (p) => {
    const f = assertInRoots(p, 'ファイル');
    const st = await fsp.stat(f);
    return { path: f, name: path.basename(f), size: st.size, mtime: st.mtimeMs, ext: fsops.extOf(f), tags: store.getImageTags(f) };
  });

  handle('fs:renameFile', async (p, newName) => {
    const src = assertInRoots(p, 'ファイル');
    const r = await fsops.renamePath(src, newName);
    if (r.changed) store.renameImageKey(r.from, r.to);
    return r;
  });
  handle('fs:renameDir', async (p, newName) => {
    const src = assertInRoots(p, 'フォルダ');
    // Windows keeps a handle on a watched directory: release the watchers of
    // roots at or below the renamed folder, then re-sync with the new paths.
    for (const e of [...watchers.values()]) if (store.isInside(src, e.root)) unwatchRoot(e.root);
    let r;
    try {
      r = await fsops.renamePath(src, newName);
      if (r.changed) store.renameFolderPrefix(r.from, r.to);
    } finally {
      syncWatchers();
    }
    return { ...r, roots: rootsInfo() };
  });
  handle('fs:move', async (paths, destDir) => {
    const dest = assertInRoots(destDir, '移動先');
    const srcs = (Array.isArray(paths) ? paths : []).map((p) => assertInRoots(p, '移動元'));
    const r = await fsops.moveFiles(srcs, dest);
    for (const m of r.moved) store.renameImageKey(m.from, m.to);
    return r;
  });

  handle('shell:showItem', (p) => { shell.showItemInFolder(assertInRoots(p)); return true; });
  handle('shell:openPath', async (p) => {
    const err = await shell.openPath(assertInRoots(p));
    if (err) throw new Error(err);
    return true;
  });
  handle('clipboard:write', (text) => { clipboard.writeText(String(text)); return true; });

  // tags
  handle('lib:get', () => libSnapshot());
  handle('lib:addType', (t) => { store.addTagType(t || {}); return libSnapshot(); });
  handle('lib:updateType', (id, t) => { store.updateTagType(id, t || {}); return libSnapshot(); });
  handle('lib:deleteType', (id, reassignTo) => { store.deleteTagType(id, reassignTo); return libSnapshot(); });
  handle('lib:addTag', (t) => ({ tag: store.addTag(t || {}), lib: libSnapshot() }));
  handle('lib:updateTag', (id, t) => { store.updateTag(id, t || {}); return libSnapshot(); });
  handle('lib:mergeTag', (src, dst) => { store.mergeTags(src, dst); return libSnapshot(); });
  handle('lib:deleteTag', (id) => { store.deleteTag(id); return libSnapshot(); });
  handle('images:getTags', (paths) => store.getTagsFor(Array.isArray(paths) ? paths : []));
  handle('images:addTags', (paths, tagIds) => ({
    tags: store.addTagsToImages((paths || []).map((p) => assertInRoots(p, '画像')), tagIds || []),
    lib: libSnapshot(),
  }));
  handle('images:removeTags', (paths, tagIds) => ({
    tags: store.removeTagsFromImages((paths || []).map((p) => assertInRoots(p, '画像')), tagIds || []),
    lib: libSnapshot(),
  }));
  handle('graph:data', (scopeDir) => {
    const images = store.listTaggedImages().filter((e) => (scopeDir ? store.isInside(scopeDir, e.path) : store.isInRoots(e.path)));
    return { ...libSnapshot(), images };
  });

  // スクリーン表示モード: fullscreen + no display sleep while active
  handle('screen:enter', () => {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('ウィンドウがありません。');
    if (!screenMode) {
      screenMode = {
        wasFullScreen: mainWindow.isFullScreen(),
        blockerId: powerSaveBlocker.start('prevent-display-sleep'),
      };
      mainWindow.setFullScreen(true);
    }
    return { wasFullScreen: screenMode.wasFullScreen };
  });
  handle('screen:exit', () => {
    endScreenMode();
    return true;
  });
  handle('win:isFullScreen', () => !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()));

  ipcMain.on('smoke:report', (_ev, report) => smokeFinish(report));
}

// ---------------------------------------------------------------------------
// Screen mode state
// ---------------------------------------------------------------------------
let screenMode = null; // { wasFullScreen, blockerId }

function endScreenMode() {
  if (!screenMode) return;
  const { wasFullScreen, blockerId } = screenMode;
  screenMode = null;
  if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
  if (mainWindow && !mainWindow.isDestroyed() && !wasFullScreen) mainWindow.setFullScreen(false);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function restoreBounds() {
  const w = store.getSettings().window;
  const def = { width: 1400, height: 900 };
  if (!w || !w.width || !w.height) return { bounds: def, maximized: false };
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return w.x != null && w.y != null && w.x < a.x + a.width - 50 && w.x + w.width > a.x + 50 && w.y >= a.y - 10 && w.y < a.y + a.height - 50;
  });
  const bounds = { width: Math.max(800, w.width), height: Math.max(500, w.height) };
  if (visible) Object.assign(bounds, { x: w.x, y: w.y });
  return { bounds, maximized: !!w.maximized };
}

function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const b = mainWindow.getNormalBounds();
  store.setSettings({ window: { ...b, maximized: mainWindow.isMaximized() } });
}

function createWindow() {
  const { bounds, maximized } = restoreBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: '#0e0e0f',
    title: 'Kunstmuseum',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (maximized) mainWindow.maximize();
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});

  // Block in-page navigation and new windows (dropping a file must not navigate).
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      mainWindow.webContents.toggleDevTools();
      e.preventDefault();
    }
  });

  let boundsTimer = null;
  const queueBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 400);
  };
  mainWindow.on('resize', queueBounds);
  mainWindow.on('move', queueBounds);
  mainWindow.on('close', saveBounds);
  mainWindow.on('closed', () => {
    endScreenMode();
    mainWindow = null;
  });
  mainWindow.once('ready-to-show', () => {
    if (SMOKE) mainWindow.showInactive(); // visible so layout/IntersectionObserver run normally
    else mainWindow.show();
  });

  if (SMOKE) attachSmoke(mainWindow);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// ---------------------------------------------------------------------------
// Smoke harness
// ---------------------------------------------------------------------------
const smokeErrors = [];
let smokeDone = false;

function attachSmoke(win) {
  const wc = win.webContents;
  wc.on('console-message', (details) => {
    const level = details.level;
    const line = `[renderer:${level}] ${details.message} (${details.sourceId}:${details.lineNumber})`;
    console.log(line);
    if (level === 'error') smokeErrors.push(line);
  });
  wc.on('preload-error', (_e, p, err) => smokeErrors.push(`[preload-error] ${p}: ${err && err.message}`));
  wc.on('render-process-gone', (_e, d) => {
    smokeErrors.push(`[render-process-gone] ${d.reason}`);
    smokeFinish({ ok: false, note: 'renderer gone' });
  });
  wc.on('did-fail-load', (_e, code, desc) => smokeErrors.push(`[did-fail-load] ${code} ${desc}`));
  const timeout = Number(process.env.KM_SMOKE_TIMEOUT || 60000);
  setTimeout(() => smokeFinish({ ok: false, note: `timeout after ${timeout}ms` }), timeout).unref();
}

/** Checks the kmimg handler from main: outside-root → 403, inside → 200. */
async function smokeProtocolChecks(r) {
  const checks = {};
  const get = async (u) => {
    try { return (await net.fetch(u)).status; } catch (e) { return String(e.message); }
  };
  const outside = process.env.KM_SMOKE_OUTSIDE;
  if (outside) {
    checks.outsideFile = await get(`kmimg://file/${encodeURIComponent(outside)}`);
    checks.outsideThumb = await get(`kmimg://thumb/${encodeURIComponent(outside)}`);
  }
  const dir = process.env.KM_SMOKE_DIR;
  if (dir) {
    const items = await fsops.scanFolder(dir, { recursive: false });
    const txt = path.join(dir, 'notes.txt');
    checks.badExt = await get(`kmimg://file/${encodeURIComponent(txt)}`);
    if (items[0]) {
      checks.insideFile = await get(`kmimg://file/${encodeURIComponent(items[0].path)}`);
      checks.insideThumb = await get(`kmimg://thumb/${encodeURIComponent(items[0].path)}`);
    }
  }
  r.protocol = checks;
  const bad = [];
  if (outside && (checks.outsideFile !== 403 || checks.outsideThumb !== 403)) bad.push('outside-root not rejected');
  if (dir && checks.badExt !== 403) bad.push('unsupported extension not rejected');
  if (dir && (checks.insideFile !== 200 || checks.insideThumb !== 200)) bad.push('inside-root not served');
  if (bad.length) { r.ok = false; r.protocolErrors = bad; }
}

function smokeFinish(report) {
  if (!SMOKE || smokeDone) return;
  smokeDone = true;
  const r = report || {};
  const checks = r.ok ? smokeProtocolChecks(r).catch((e) => { r.ok = false; r.protocolErrors = [String(e)]; }) : Promise.resolve();
  // let late console messages arrive
  checks.then(() => new Promise((res) => setTimeout(res, 500))).then(() => {
    const ok = !!r.ok && smokeErrors.length === 0;
    console.log(`[smoke] report: ${JSON.stringify(r)}`);
    for (const e of smokeErrors) console.log(`[smoke] ERROR ${e}`);
    console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} (renderer errors: ${smokeErrors.length})`);
    try { store.flush(); } catch { /* ignore */ }
    app.exit(ok ? 0 : 1);
  });
}

process.on('uncaughtException', (e) => {
  console.error('[main] uncaught', e);
  if (SMOKE) { smokeErrors.push(`[main] ${e && e.stack}`); smokeFinish({ ok: false }); }
});
process.on('unhandledRejection', (e) => {
  console.error('[main] unhandled rejection', e);
  if (SMOKE) { smokeErrors.push(`[main] ${e && e.stack}`); smokeFinish({ ok: false }); }
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
const gotLock = SMOKE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    store = new Store(path.join(app.getPath('userData'), 'library.json'));
    try {
      const n = store.pruneMissing();
      if (n) console.log(`[store] pruned ${n} missing entries`);
    } catch (e) {
      console.error('[store] prune failed', e);
    }
    if (SMOKE && process.env.KM_SMOKE_DIR && process.env.KM_SMOKE_PHASE !== '2') {
      const d = path.resolve(process.env.KM_SMOKE_DIR);
      store.addRoot(d);
      store.setSettings({ lastFolder: d, includeSubfolders: true });
    }
    registerProtocol();
    registerIpc();
    syncWatchers();
    createWindow();
  });

  app.on('window-all-closed', () => {
    stopAllWatchers();
    try { store && store.flush(); } catch (e) { console.error('[store] save failed', e); }
    app.quit();
  });

  app.on('before-quit', () => {
    try { store && store.flush(); } catch { /* ignore */ }
  });
}
