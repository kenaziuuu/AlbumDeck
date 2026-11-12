'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, arg) => ipcRenderer.invoke(channel, arg).then(r => {
  if (r && r.ok === false) throw new Error(r.error || '操作失败');
  return r && r.data;
});

contextBridge.exposeInMainWorld('deck', {
  state: () => call('state'),
  onState: cb => ipcRenderer.on('state', (_e, s) => cb(s)),
  onImportProgress: cb => ipcRenderer.on('import:progress', (_e, p) => cb(p)),
  onOpenQueue: cb => ipcRenderer.on('ui:openQueue', () => cb()),
  onOpenFav: cb => ipcRenderer.on('ui:openFav', () => cb()),
  onNewFav: cb => ipcRenderer.on('ui:newFav', (_e, item) => cb(item)),

  onTrayData: cb => ipcRenderer.on('tray:data', (_e, d) => cb(d)),
  trayAction: act => ipcRenderer.send('tray:action', act),
  trayExpand: expand => ipcRenderer.send('tray:expand', !!expand),
  trayResize: h => ipcRenderer.send('tray:resize', h),
  trayHide: () => ipcRenderer.send('tray:hide'),

  connect: () => call('conn:connect'),
  launch: () => call('conn:launch'),
  browserPath: () => call('conn:browserPath'),

  playAt: (albumId, index) => call('play:at', { albumId, index }),
  selectAlbum: albumId => call('play:select', { albumId }),
  next: () => call('play:next'),
  prev: () => call('play:prev'),
  setPlayMode: mode => call('play:setMode', mode),
  nextAlbum: () => call('play:albumNext'),
  prevAlbum: () => call('play:albumPrev'),
  togglePlay: () => call('play:toggle'),
  replay: () => call('play:replay'),
  seek: seconds => call('play:seek', { seconds }),
  openBvid: bvid => call('play:bvid', { bvid }),
  playFavorite: item => call('play:favorite', item),
  playFolder: (folderId, item) => call('play:folderItem', { folderId, item }),
  clearQueueSource: () => call('queue:clearSource'),

  addAlbums: list => call('library:addAlbums', list),
  reimport: bvid => call('library:reimport', { bvid }),
  setAlbums: list => call('library:setAlbums', list),
  updateAlbum: (id, patch) => call('library:updateAlbum', { id, patch }),
  deleteAlbum: id => call('library:deleteAlbum', { id }),
  resetSeed: () => call('library:resetSeed'),
  exportLibrary: () => call('library:export'),
  importFile: () => call('library:importFile'),
  addTrack: arg => call('library:addTrack', arg),
  removeTrack: arg => call('library:removeTrack', arg),
  toggleTrackHidden: (albumId, index) => call('library:toggleTrackHidden', { albumId, index }),
  reorderTracks: (albumId, from, to) => call('library:reorderTracks', { albumId, from, to }),
  reorderAlbums: (from, to) => call('library:reorderAlbums', { from, to }),
  sortAlbums: by => call('library:sortAlbums', { by }),
  fillSingle: albumId => call('library:fillSingle', { albumId }),

  favCreate: arg => call('fav:create', arg),
  favRename: arg => call('fav:rename', arg),
  favDelete: id => call('fav:delete', { id }),
  favClear: id => call('fav:clear', { id }),
  favLike: item => call('fav:like', { item }),
  favAdd: (folderId, item) => call('fav:add', { folderId, item }),
  favAddMany: (folderId, items) => call('fav:addMany', { folderId, items }),
  favRemove: (folderId, key) => call('fav:remove', { folderId, key }),
  reorderFav: (folderId, from, to) => call('fav:reorder', { folderId, from, to }),

  parseText: (text, duration) => call('bili:parseText', { text, duration }),
  resolve: input => call('bili:resolve', input),
  season: args => call('bili:season', args),
  search: keyword => call('bili:search', keyword),
  videoInfo: bvid => call('bili:videoInfo', bvid),
  chapters: bvid => call('bili:chapters', bvid),
  build: archives => call('bili:build', archives),

  getSettings: () => call('settings:get'),
  setSettings: patch => call('settings:set', patch),
  resetHotkeys: () => call('settings:resetHotkeys'),
  pickBrowser: () => call('settings:pickBrowser'),

  min: () => call('win:min'),
  max: () => call('win:max'),
  close: () => call('win:close'),
  toggleMini: () => call('win:toggleMini'),
  collapseMini: edge => call('win:miniCollapse', edge),
  showMain: () => call('win:showMain'),
  showQueue: () => call('win:showQueue'),
  showFav: () => call('win:showFav'),
  newFav: item => call('win:newFav', { item }),
  openPop: kind => call('mini:openPop', kind),
  closePop: () => call('pop:close'),
  popSize: arg => call('pop:size', arg),
  quit: () => call('win:quit'),

  openExternal: url => call('util:openExternal', url),
  openDataDir: () => call('util:openDataDir'),

  fmt: s => {
    const n = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), ss = n % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
             : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
});
