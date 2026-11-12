'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_HOTKEYS = {
  nextTrack: 'Ctrl+Alt+Right',
  prevTrack: 'Ctrl+Alt+Left',
  nextAlbum: 'Ctrl+Alt+Shift+Right',
  prevAlbum: 'Ctrl+Alt+Shift+Left',
  togglePlay: 'Ctrl+Alt+Space',
  toggleMain: 'Ctrl+Alt+M',
  toggleMini: 'Ctrl+Alt+N',
  replay: 'Ctrl+Alt+R'
};

const LIKED_ID = 'fav_liked';

/** 默认只有一个内置歌曲收藏夹「喜欢」；红心的歌曲自动进入这里 */
const defaultFolders = () => ([
  { id: LIKED_ID, name: '喜欢', type: 'song', builtin: true, items: [] }
]);

const DEFAULT_SETTINGS = {
  port: 9222,
  browserPath: '',
  autoPlay: false,         // 切歌后自动播放：默认不勾选
  albumClickPlay: true,    // 点击资料库里的专辑时直接开始播放（关掉后只显示曲目，点播放才播）
  skipHidden: true,        // 隐藏的曲目播放时自动跳过
  playMode: 'all-loop',    // 播放顺序：one / album-loop / album-shuffle / all-loop / album-random / song-shuffle
  miniVisible: true,
  miniStyle: 'full',       // 'full' 完整样式 / 'compact' 简洁长条 / 'vertical' MP3样式
  miniEdgeHide: true,      // 贴屏幕边缘自动隐藏
  miniPeek: 3,             // 隐藏（收起）后露出的边缘宽度 px：越大越明显
  pollMs: 1000,
  hotkeys: { ...DEFAULT_HOTKEYS }
};

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'album-deck.json');
    this.data = {
      version: 1,
      albums: [],
      folders: defaultFolders(),
      queue: { mode: 'all-loop', items: [], pos: 0 },
      current: { albumId: null, trackIndex: 0 },
      settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      miniBounds: null
    };
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      if (fs.existsSync(this.file)) {
        const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = {
          ...this.data, ...j,
          current: { ...this.data.current, ...(j.current || {}) },
          settings: {
            ...this.data.settings, ...(j.settings || {}),
            hotkeys: { ...DEFAULT_HOTKEYS, ...((j.settings || {}).hotkeys || {}) }
          }
        };
      }
      // 旧配置升级：保证收藏夹结构与内置「喜欢」一定存在
      if (!Array.isArray(this.data.folders) || !this.data.folders.length) {
        this.data.folders = defaultFolders();
      } else {
        this.data.folders.forEach(f => { if (!Array.isArray(f.items)) f.items = []; });
        if (!this.data.folders.some(f => f.id === LIKED_ID)) {
          this.data.folders.unshift({ id: LIKED_ID, name: '喜欢', type: 'song', builtin: true, items: [] });
        }
        const liked = this.data.folders.find(f => f.id === LIKED_ID);
        liked.type = 'song'; liked.builtin = true;
      }
    } catch (e) { console.error('读取配置失败:', e); }
  }

  save() {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      return true;
    } catch (e) { console.error('保存配置失败:', e); return false; }
  }

  get albums() { return this.data.albums; }
  set albums(v) { this.data.albums = v; this.save(); }
  get folders() { return this.data.folders; }
  set folders(v) { this.data.folders = v; this.save(); }
  get settings() { return this.data.settings; }
  get current() { return this.data.current; }

  patch(obj) {
    Object.assign(this.data, obj);
    this.save();
  }
  patchSettings(obj) {
    this.data.settings = {
      ...this.data.settings, ...obj,
      hotkeys: { ...this.data.settings.hotkeys, ...(obj.hotkeys || {}) }
    };
    this.save();
  }
}

module.exports = { Store, DEFAULT_HOTKEYS, DEFAULT_SETTINGS, LIKED_ID, defaultFolders };
