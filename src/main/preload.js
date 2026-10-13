'use strict';
// Sandboxed preload: exposes a narrow, promise-based API to the renderer.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

function clean(err) {
  const msg = String((err && err.message) || err || '不明なエラー');
  return new Error(msg.replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, ''));
}

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args).catch((e) => { throw clean(e); });

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  appInfo: call('app:info'),
  warnings: call('app:warnings'),
  appPaths: call('app:paths'),
  openUserData: call('app:openUserData'),

  getSettings: call('settings:get'),
  setSettings: call('settings:set'),

  listRoots: call('roots:list'),
  addRootsDialog: call('roots:addDialog'),
  addRoots: call('roots:add'),
  removeRoot: call('roots:remove'),

  subdirs: call('fs:subdirs'),
  listDir: call('fs:listDir'),
  exists: call('fs:exists'),
  scan: call('fs:scan'),
  listTagged: call('fs:listTagged'),
  stat: call('fs:stat'),
  renameFile: call('fs:renameFile'),
  renameDir: call('fs:renameDir'),
  move: call('fs:move'),
  trash: call('fs:trash'),

  showItem: call('shell:showItem'),
  openPath: call('shell:openPath'),
  copyText: call('clipboard:write'),

  // cb(dirs: string[]) — directories whose contents changed (batched)
  onFsChanged: (cb) => {
    const fn = (_e, dirs) => cb(Array.isArray(dirs) ? dirs : [dirs]);
    ipcRenderer.on('fs:changed', fn);
    return () => ipcRenderer.removeListener('fs:changed', fn);
  },

  getLib: call('lib:get'),
  addTagType: call('lib:addType'),
  updateTagType: call('lib:updateType'),
  deleteTagType: call('lib:deleteType'),
  addTag: call('lib:addTag'),
  updateTag: call('lib:updateTag'),
  mergeTag: call('lib:mergeTag'),
  deleteTag: call('lib:deleteTag'),
  getImageTags: call('images:getTags'),
  bulkApplyTags: call('images:bulkApply'),
  restoreTags: call('images:restoreTags'),
  searchIndex: call('index:search'),
  addImageTags: call('images:addTags'),
  removeImageTags: call('images:removeTags'),
  getImageView: call('images:getView'),
  setImageView: call('images:setView'),
  getVideoThumbTime: call('videos:getThumbTime'),
  setVideoThumbTime: call('videos:setThumbTime'),
  // main asks for a video frame: handler({path, time}) → Promise<ArrayBuffer>
  onVideoFrameRequest: (handler) => {
    const fn = async (_e, req) => {
      try {
        const data = await handler({ path: req.path, time: req.time });
        ipcRenderer.send('vthumb:reply', { id: req.id, data: new Uint8Array(data) });
      } catch (err) {
        ipcRenderer.send('vthumb:reply', { id: req.id, error: String((err && err.message) || err) });
      }
    };
    ipcRenderer.on('vthumb:request', fn);
    return () => ipcRenderer.removeListener('vthumb:request', fn);
  },
  graphData: call('graph:data'),

  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },
  screenEnter: call('screen:enter'),
  screenExit: call('screen:exit'),
  isFullScreen: call('win:isFullScreen'),

  // 画像取得 (fotoget)
  fetchDefaults: call('fetch:defaults'),
  fetchRun: call('fetch:run'),
  fetchCancel: call('fetch:cancel'),
  fetchOpenOut: call('fetch:openOut'),
  // cb({id, stream, text}) / cb({id, code, cancelled, error})
  onFetchOutput: (cb) => {
    const fn = (_e, m) => cb(m);
    ipcRenderer.on('fetch:output', fn);
    return () => ipcRenderer.removeListener('fetch:output', fn);
  },
  onFetchDone: (cb) => {
    const fn = (_e, m) => cb(m);
    ipcRenderer.on('fetch:done', fn);
    return () => ipcRenderer.removeListener('fetch:done', fn);
  },

  smokeCopyFixture: call('smoke:copyFixture'), // only registered in smoke mode
  smokeWriteFixture: call('smoke:writeFixture'), // only registered in smoke mode
  smokeReport: (report) => ipcRenderer.send('smoke:report', report),
});
