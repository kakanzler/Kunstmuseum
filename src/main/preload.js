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
  addImageTags: call('images:addTags'),
  removeImageTags: call('images:removeTags'),
  graphData: call('graph:data'),

  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },
  screenEnter: call('screen:enter'),
  screenExit: call('screen:exit'),
  isFullScreen: call('win:isFullScreen'),

  smokeReport: (report) => ipcRenderer.send('smoke:report', report),
});
