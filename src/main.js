'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, Tray, shell, dialog, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const bili = require('./bilibili');
const { CdpController } = require('./controller');
const { Store, DEFAULT_HOTKEYS, LIKED_ID } = require('./store');
const geo = require('./mini-geometry');
const follow = require('./poll-follow');
const playing = require('./playing');
const sortMod = require('./sort-albums');
const { StatePublisher } = require('./state-packets');
const statePublisher = new StatePublisher();
const miniSize = geo.miniSize;

const ASSETS = path.join(__dirname, '..', 'assets');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 自检模式使用独立数据目录，绝不碰用户真实曲库
const PACK_CHECK = process.argv.includes('--deck-packcheck');
const SELF_TEST = PACK_CHECK || process.argv.some(a => ['--deck-fav', '--deck-deltest', '--deck-jumptest', '--deck-chtest', '--deck-singletest', '--deck-uitest', '--deck-modetest', '--deck-minitest', '--deck-imptest', '--deck-selecttest', '--deck-losttest', '--deck-sorttest', '--deck-looptest', '--deck-fqtest', '--deck-summontest', '--deck-repro'].includes(a));
if (SELF_TEST) {
  const os = require('os');
  const _dir = PACK_CHECK ? fs.mkdtempSync(path.join(os.tmpdir(), 'albumdeck-packcheck-')) : path.join(os.tmpdir(), 'albumdeck-favtest');
  app.setPath('userData', _dir);
  try { fs.rmSync(path.join(_dir, 'album-deck.json'), { force: true }); } catch (_) {}
  // 复现用：把真实曲库复制进隔离目录，不碰用户数据
  if (process.argv.includes('--deck-repro')) {
    try {
      fs.mkdirSync(_dir, { recursive: true });
      fs.copyFileSync(path.join(app.getPath('appData'), 'album-deck', 'album-deck.json'), path.join(_dir, 'album-deck.json'));
    } catch (e) { console.log('REPRO COPY FAILED:', e.message); }
  }
}

/* ---------------- 全局状态 ---------------- */

let store, cdp, mainWin, miniWin, tray = null;
let quitting = false;
let guardUntil = 0;          // 刚跳转后的保护期，避免轮询把高亮改回去
let playIntent = null;       // 本次点歌目标；加载期间锁定，完成后短暂校验历史进度恢复。
let manualPause = false;     // 用户暂停与视频自然结束后的暂停分开处理。
let stoppedTrack = null;     // 播完即停后保留本曲标题；再次按播放从本曲起点重播。
let transportRevision = 0, transportPending = 0;
/** 用户手动选中了某张专辑但还没播（关掉「点专辑直接播放」时）：轮询别把视图拽回正在播的那张 */
let selectionPin = null;     // { albumId, bvid }
let lastAdvance = 0;
let lastMenuSignature = '';
let pollTimer = null;
let pollInFlight = false, broadcastPending = false;
let autoConnectTick = 0;
let importBusy = false;

const playback = { t: 0, d: 0, paused: true, bvid: '', title: '' };
const conn = { connected: false, browser: '', port: 9222, message: '尚未连接浏览器' };
let message = '';
let messageAt = 0;

function settings() { return store.settings; }
function albums() { return store.albums; }
function folders() { return store.folders; }
function folderById(id) { return folders().find(f => f.id === id); }
function likedFolder() { return folderById(LIKED_ID); }
function songKey(bvid, start) { return `song:${bvid}:${Math.round(start || 0)}`; }
function albumKey(bvid) { return `album:${bvid}`; }

/** 曲目表增删改后统一重排：按起点排序、去重、重算每首的结束时间 */
function normalizeTracks(tracks, duration) {
  const seen = new Set();
  const out = (tracks || [])
    .filter(t => t && Number.isFinite(Number(t.start)) && Number(t.start) >= 0)
    .map(t => {
      const o = { name: String(t.name || '').trim() || '未命名曲目', start: Math.round(Number(t.start)) };
      if (t.hidden) o.hidden = true;   // 隐藏标记跟着曲目走，重排时不丢
      return o;
    })
    .sort((a, b) => a.start - b.start)
    .filter(t => !seen.has(t.start) && seen.add(t.start));
  out.forEach((t, i) => { t.end = i < out.length - 1 ? out[i + 1].start : (Number(duration) || 0); });
  return out;
}

/** 把 "05:01" / "1:05:30" / 301 统一转成秒 */
function parseTimeInput(v) {
  if (typeof v === 'number') return Math.max(0, Math.round(v));
  const parts = String(v || '').trim().replace(/：/g, ':').split(':').map(Number);
  if (!parts.length || parts.some(x => !Number.isFinite(x))) throw new Error('时间格式不对，请填 05:01 或 1:05:30');
  return Math.max(0, Math.round(parts.reduce((acc, x) => acc * 60 + x, 0)));
}
function currentAlbum() { return albums().find(a => a.id === store.current.albumId) || albums()[0] || null; }
function currentTrack() {
  const a = currentAlbum();
  if (!a || !a.tracks || !a.tracks.length) return null;
  return a.tracks[Math.min(store.current.trackIndex, a.tracks.length - 1)];
}

/** 真正在播放的专辑 / 曲目 / 进度（关掉「点专辑直接播放」后可能和选中项不同） */
function playingInfo() {
  const pending = playIntent && playIntent.loading ? playIntent : null;
  if (stoppedTrack && manualPause) {
    const album = albums().find(a => a.id === stoppedTrack.albumId && a.bvid === playback.bvid);
    const track = album && album.tracks[stoppedTrack.trackIndex];
    if (track) return { album, track, trackIndex: stoppedTrack.trackIndex,
      t: Math.min(playback.t, track.end || playback.t), d: playback.d, paused: true };
  }
  return playing.resolvePlaying({
    albums: albums(),
    playingBvid: pending ? pending.bvid : playback.bvid,
    playingT: pending ? pending.start : playback.t,
    playingD: playback.d,
    playingPaused: playback.paused,
    playingTitle: playback.title,
    currentAlbum: currentAlbum(),
    currentTrackIndex: store.current.trackIndex
  });
}
function setMessage(text) { message = text; messageAt = Date.now(); broadcast(); }

function snapshot() {
  const curAlbum = currentAlbum();
  const pb = { ...playback };
  // 选中的专辑和浏览器里正在放的不是同一张（关掉「点专辑直接播放」时就是这样）
  // → 进度归零、显示成暂停，避免拿另一张专辑的播放进度来算进度条
  if (curAlbum && pb.bvid && pb.bvid !== curAlbum.bvid) { pb.t = 0; pb.d = 0; pb.paused = true; }
  return {
    albums: albums(),
    folders: folders(),
    queue: store.data.queue ? {
      mode: store.data.queue.mode,
      pos: store.data.queue.pos,
      rev: store.data.queue.rev || 0,
      items: store.data.queue.items || [],
      source: store.data.queue.source || null
    } : { mode: settings().playMode || 'all-loop', pos: 0, rev: 0, items: [], source: null },
    current: { ...store.current, album: curAlbum, track: currentTrack() },
    playing: playingInfo(),
    playback: pb,
    conn: { ...conn },
    settings: settings(),
    dataRevision: store.revision || 0,
    playModes: PLAY_MODES,
    message: Date.now() - messageAt < 6000 ? message : '',
    importBusy
  };
}

function broadcast() {
  if (broadcastPending) return;
  broadcastPending = true;
  Promise.resolve().then(() => {
    broadcastPending = false;
    if (!store) return;
    const s = snapshot();
    for (const w of [mainWin, miniWin]) {
      if (w && !w.isDestroyed() && w.webContents && w.isVisible() && !w.isMinimized()) {
        w.webContents.send('state', statePublisher.packet(s, store.revision, w.webContents));
      }
    }
    updateTrayMenu(s);
  });
}

/* ---------------- 控制逻辑 ---------------- */

async function ensureConnection(preferBvid = '') {
  cdp.prefer360p = settings().prefer360p !== false;
  if (cdp.connected && cdp.ws && cdp.ws.readyState === 1) return true;
  await cdp.connect(preferBvid);
  conn.connected = true;
  conn.browser = cdp.browser || 'Chromium';
  conn.message = '已连接 ' + conn.browser;
  try { await cdp.state(); } catch (_) { /* 页面可能还在加载 */ }
  broadcast();
  return true;
}

/** 从收藏夹点歌：歌曲夹只播收藏的歌曲；专辑夹同时遵守专内播放范围。 */
async function playFolderItem(folderId, item) {
  const f = folderById(folderId);
  if (!f) { setMessage('收藏夹不存在'); return false; }
  let target = null;
  if (item) {
    const a = albums().find(x => x.bvid === item.bvid) || albums().find(x => x.id === item.albumId);
    if (a) {
      let idx = (a.tracks || []).findIndex(t => Math.abs((t.start || 0) - (item.start || 0)) < 2);
      if (idx < 0) idx = 0;
      target = { albumId: a.id, trackIndex: idx };
    }
  }
  const items = folderQueueItems(f, target || queueCurrent());
  if (!items.length) { setMessage('这个收藏夹里的歌都不在曲库里'); return false; }
  const mode = settings().playMode || 'all-loop';
  if (mode === 'album-shuffle' || mode === 'song-shuffle' || mode === 'album-random') shuffleArr(items);
  let pos = target ? items.findIndex(it => it.albumId === target.albumId && it.trackIndex === target.trackIndex) : -1;
  if (pos < 0) pos = 0;
  store.data.queue = { mode, items, pos, rev: Date.now(), source: { kind: 'folder', id: f.id, name: f.name } };
  store.save();
  const t = items[pos];
  const ok = await playAt(t.albumId, t.trackIndex);
  if (ok) setMessage(`正在播放 · ${(albums().find(a => a.id === t.albumId) || {}).tracks?.[t.trackIndex]?.name || ''}　收藏夹「${f.name}」${pos + 1}/${items.length}`);
  return ok;
}

async function playAt(albumId, index, opts = {}) {
  const album = albums().find(a => a.id === albumId);
  if (!album) { setMessage('找不到这张专辑'); return false; }
  transportRevision++;
  stoppedTrack = null;
  selectionPin = null;   // 真的开播了，取消"手动选中"锁定
  const tracks = album.tracks || [];
  const i = Math.max(0, Math.min(index, Math.max(0, tracks.length - 1)));
  const intent = { albumId, bvid: album.bvid, trackIndex: i, start: tracks[i] ? tracks[i].start : 0, loading: true, play: opts.play !== false };
  manualPause = !intent.play;
  playIntent = intent;
  // 先选中这张专辑，即使它还没有曲目表，右侧也要切过去显示空状态
  store.patch({ current: { albumId, trackIndex: i } });
  // 从收藏夹队列里跳出去播别的专辑 → 退出收藏夹队列，回到整库队列
  const q0 = store.data.queue;
  if (q0 && q0.source && !(q0.items || []).some(it => it.albumId === albumId && it.trackIndex === i)) {
    store.data.queue = { ...q0, source: null };
    rebuildQueue();
  }
  // 同步播放队列（专内模式换专辑时要重建；随机模式下只更新位置）
  ensureQueue();
  syncQueuePos();
  // 立即进入保护期：避免 seek 完成前的轮询用旧进度把高亮改回去
  guardUntil = Date.now() + 3500;
  broadcast();
  if (!tracks.length) {
    playIntent = null;
    setMessage('这张专辑还没有曲目表，可以点「按单曲填充」或编辑曲目');
    return false;
  }
  try {
    await ensureConnection(album.bvid);
    if (playIntent !== intent) return false;
    await cdp.setPauseAtEnd();
    if (playIntent !== intent) return false;
    // 用刚读到的网页 BV，避免网页已跳走时还按缓存的 BV 在错误视频上 seek。
    const browserState = await cdp.state();
    if (playIntent !== intent) return false;
    const bvidNow = browserState && browserState.bvid || '';
    let result;
    if (bvidNow === album.bvid && cdp.lastState && cdp.lastState.ok) {
      result = await cdp.seek(tracks[i].start, intent.play);
    } else {
      result = await cdp.openVideo(album.bvid, tracks[i].start, intent.play);
    }
    if (playIntent !== intent || (result && result.cancelled)) return false;
    if (result && result.userOverride) {
      intent.play = !result.paused;
      manualPause = !!result.paused;
    }
    intent.loading = false;
    intent.anchorAt = Date.now();
    intent.anchorT = result && Number.isFinite(result.t) ? result.t : tracks[i].start;
    intent.protectUntil = opts.protectUntil || Date.now() + 10000;
    playback.bvid = album.bvid;
    playback.t = result && Number.isFinite(result.t) ? result.t : tracks[i].start;
    playback.paused = !intent.play;
    guardUntil = Date.now() + 2200;
    setMessage(`${intent.play ? '正在播放' : '已暂停'} · ${tracks[i].name}`);
  } catch (e) {
    if (playIntent !== intent) return false;
    playIntent = null;
    setMessage('控制浏览器失败：' + (e.message || e));
    return false;
  }
  return true;
}

/* ---------------- 播放队列 / 播放顺序 ---------------- */

const PLAY_MODES = [
  { key: 'one', label: '专内单曲循环', short: '单曲循环', scope: '专内', endAction: 'repeat' },
  { key: 'album-loop', label: '专内循环播放', short: '专内循环', scope: '专内', endAction: 'next' },
  { key: 'album-shuffle', label: '专内随机播放', short: '专内随机', scope: '专内', endAction: 'next' },
  { key: 'all-loop', label: '全专循环播放', short: '全专循环', scope: '全库', endAction: 'next' },
  { key: 'album-random', label: '专辑随机播放', short: '专辑随机', scope: '全库', endAction: 'next' },
  { key: 'song-shuffle', label: '全专歌曲随机', short: '歌曲随机', scope: '全库', endAction: 'next' },
  { key: 'once', label: '播完即停', short: '播完即停', scope: '单曲', endAction: 'pause' }
];

function shuffleArr(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isHiddenItem(it) {
  const a = albums().find(x => x.id === it.albumId);
  const t = a && a.tracks && a.tracks[it.trackIndex];
  return !!(t && t.hidden);
}

/** 查看别的专辑时，队列仍以正在播放的曲目为准。 */
function queueCurrent() {
  const q = store.data.queue;
  if (selectionPin && store.current.albumId === selectionPin.albumId && q && q.items && q.items[q.pos]) {
    return q.items[q.pos];
  }
  return store.current;
}

/** 收藏夹里的条目 → 播放队列项（按收藏夹顺序；专辑项展开成整张曲目；不在曲库的跳过） */
function folderQueueItems(f, cur = queueCurrent()) {
  const items = [];
  for (const it of (f && f.items) || []) {
    const a = albums().find(x => x.bvid === it.bvid) || albums().find(x => x.id === it.albumId);
    if (!a || !a.tracks || !a.tracks.length) continue;
    if (it.kind === 'album') {
      a.tracks.forEach((_, i) => items.push({ albumId: a.id, trackIndex: i }));
      continue;
    }
    let idx = a.tracks.findIndex(t => Math.abs((t.start || 0) - (it.start || 0)) < 2);
    if (idx < 0) idx = 0;
    items.push({ albumId: a.id, trackIndex: idx });
  }
  const mode = settings().playMode || 'all-loop';
  if (mode === 'once') {
    const target = items.find(it => it.albumId === cur.albumId && it.trackIndex === cur.trackIndex) || items[0];
    return target ? [target] : [];
  }
  if (f && f.type === 'album' && (mode === 'one' || mode === 'album-loop' || mode === 'album-shuffle')) {
    const target = items.find(it => it.albumId === cur.albumId && it.trackIndex === cur.trackIndex)
      || items.find(it => it.albumId === cur.albumId) || items[0];
    return target ? items.filter(it => it.albumId === target.albumId && (mode !== 'one' || it.trackIndex === target.trackIndex)) : [];
  }
  return items;
}

/** 当前队列是不是"某个收藏夹"的队列 */
function folderQueueSource() {
  const q = store.data.queue;
  return q && q.source && q.source.kind === 'folder' ? q.source : null;
}

/** 退出收藏夹队列，回到按播放顺序的整库队列 */
function clearFolderQueue() {
  const q = store.data.queue;
  if (!q || !q.source) return false;
  store.data.queue = { ...q, source: null };
  rebuildQueue();
  syncQueuePos();
  return true;
}

/** 收藏夹内容变了 → 如果它正是当前播放队列，跟着重建 */
function syncFolderQueue(folderId) {
  const src = folderQueueSource();
  if (!src) return;
  if (folderId && src.id !== folderId) return;
  rebuildQueue(); syncQueuePos();
}

function rebuildQueue() {
  const mode = settings().playMode || 'all-loop';
  const cur = queueCurrent();
  // 收藏夹队列：曲库/收藏夹变了就按收藏夹重新生成，别退回整库顺序
  const src = folderQueueSource();
  if (src) {
    const f = folderById(src.id);
    const fitems = f ? folderQueueItems(f, cur) : [];
    if (fitems.length) {
      if (mode === 'album-shuffle' || mode === 'song-shuffle' || mode === 'album-random') shuffleArr(fitems);
      const q0 = store.data.queue;
      let pos = fitems.findIndex(it => it.albumId === cur.albumId && it.trackIndex === cur.trackIndex);
      if (pos < 0) pos = Math.max(0, Math.min(q0.pos || 0, fitems.length - 1));
      store.data.queue = { mode, items: fitems, pos, rev: Date.now(), source: { kind: 'folder', id: f.id, name: f.name } };
      store.save();
      return store.data.queue;
    }
    // 收藏夹没了 / 里面没歌了 → 退回整库队列
    store.data.queue = { ...(store.data.queue || {}), mode, source: null };
  }
  const curAlbum = albums().find(a => a.id === cur.albumId) || albums()[0];
  const items = [];
  if (curAlbum) {
    if (mode === 'one' || mode === 'once') {
      const idx = Math.max(0, Math.min(cur.trackIndex, (curAlbum.tracks || []).length - 1));
      items.push({ albumId: curAlbum.id, trackIndex: idx });
    } else if (mode === 'album-loop' || mode === 'album-shuffle') {
      const idxs = (curAlbum.tracks || []).map((_, i) => i);
      if (mode === 'album-shuffle') shuffleArr(idxs);
      idxs.forEach(i => items.push({ albumId: curAlbum.id, trackIndex: i }));
    } else if (mode === 'all-loop' || mode === 'song-shuffle') {
      for (const a of albums()) (a.tracks || []).forEach((_, i) => items.push({ albumId: a.id, trackIndex: i }));
      if (mode === 'song-shuffle') shuffleArr(items);
    } else if (mode === 'album-random') {
      const ids = albums().map(a => a.id);
      shuffleArr(ids);
      for (const id of ids) {
        const a = albums().find(x => x.id === id);
        (a.tracks || []).forEach((_, i) => items.push({ albumId: id, trackIndex: i }));
      }
    }
  }
  let pos = items.findIndex(it => it.albumId === cur.albumId && it.trackIndex === cur.trackIndex);
  if (pos < 0) pos = 0;
  store.data.queue = { mode, items, pos, rev: Date.now() };
  store.save();
  return store.data.queue;
}

function ensureQueue() {
  const mode = settings().playMode || 'all-loop';
  const q = store.data.queue;
  // 收藏夹队列也要检查播放模式，专内模式只保留当前专辑。
  const src = folderQueueSource();
  if (src) {
    const f = folderById(src.id);
    if (f && Array.isArray(q.items) && q.items.length) {
      if (q.mode !== mode) return rebuildQueue();
      // 收藏夹内容变了（增删歌）→ 重新生成一次，保证和收藏夹一致
      const fresh = folderQueueItems(f);
      const same = fresh.length === q.items.length &&
        fresh.every(it => q.items.some(x => x.albumId === it.albumId && x.trackIndex === it.trackIndex));
      if (!same) return rebuildQueue();
      return q;
    }
    return rebuildQueue();
  }
  // 手动选中某张专辑但还没播时，队列仍按"正在播的那张"算，别被选中项带偏
  const cur = queueCurrent();
  const albumScope = mode === 'one' || mode === 'once' || mode === 'album-loop' || mode === 'album-shuffle';
  const need = !q || !Array.isArray(q.items) || !q.items.length || q.mode !== mode ||
    (albumScope && q.items[0] && q.items[0].albumId !== cur.albumId) ||
    ((mode === 'one' || mode === 'once') && q.items[0] && q.items[0].trackIndex !== cur.trackIndex);
  return need ? rebuildQueue() : q;
}

function syncQueuePos() {
  const q = store.data.queue;
  if (!q || !q.items || !q.items.length) return;
  const pos = q.items.findIndex(it => it.albumId === store.current.albumId && it.trackIndex === store.current.trackIndex);
  if (pos >= 0 && pos !== q.pos) { q.pos = pos; store.save(); }
}

function refreshQueue() { rebuildQueue(); syncQueuePos(); }

function setPlayMode(mode) {
  if (!PLAY_MODES.some(m => m.key === mode)) throw new Error('未知的播放顺序');
  store.patchSettings({ playMode: mode });
  rebuildQueue(); syncQueuePos();
  broadcast();
  return mode;
}

/** 自然曲尾只执行该模式定义的动作，不能把网页结束暂停当作手动暂停。 */
async function finishTrack(restore = false) {
  const mode = PLAY_MODES.find(m => m.key === settings().playMode);
  if (!mode || mode.endAction !== 'pause') return nextTrack();
  const item = queueCurrent();
  const target = { albumId: item.albumId, trackIndex: item.trackIndex };
  manualPause = true;
  playIntent = null;
  let revision = ++transportRevision;
  transportPending++;
  try {
    if (restore) {
      const request = playAt(target.albumId, target.trackIndex, { play: false });
      revision = transportRevision;
      if (!await request) return;
    } else await cdp.togglePlay('pause');
    if (revision !== transportRevision) return;
    stoppedTrack = target;
    playback.paused = true;
    setMessage('本曲播放结束，已暂停');
  } finally { transportPending--; }
}

function nextTrack() {
  const mode = settings().playMode || 'all-loop';
  let q = ensureQueue();
  if (!q.items.length) return;
  if (mode === 'one') { const it = q.items[q.pos]; return playAt(it.albumId, it.trackIndex); }
  const skip = settings().skipHidden;
  let pos = q.pos, guard = 0;
  do {
    pos += 1;
    if (pos >= q.items.length) {
      if (mode === 'album-shuffle' || mode === 'song-shuffle' || mode === 'album-random') {
        q = rebuildQueue();
        pos = 0;
      } else pos = 0;
    }
    guard++;
  } while (guard <= q.items.length && skip && isHiddenItem(q.items[pos]));
  const it = q.items[pos];
  if (!it) return;
  q.pos = pos;
  return playAt(it.albumId, it.trackIndex);
}

function prevTrack() {
  const mode = settings().playMode || 'all-loop';
  const q = ensureQueue();
  if (!q.items.length) return;
  if (mode === 'one') { const it = q.items[q.pos]; return playAt(it.albumId, it.trackIndex); }
  const skip = settings().skipHidden;
  let pos = q.pos, guard = 0;
  do {
    pos -= 1;
    if (pos < 0) pos = q.items.length - 1;
    guard++;
  } while (guard <= q.items.length && skip && isHiddenItem(q.items[pos]));
  const it = q.items[pos];
  if (!it) return;
  q.pos = pos;
  return playAt(it.albumId, it.trackIndex);
}

function stepTrack(delta) { return delta > 0 ? nextTrack() : prevTrack(); }

function stepAlbum(delta) {
  if (!albums().length) return;
  // 收藏夹队列：按队列里的专辑分组跳（下一组的第一首）
  const q = store.data.queue;
  if (q && q.source && (q.items || []).length) {
    const order = [];
    for (const it of q.items) if (!order.includes(it.albumId)) order.push(it.albumId);
    const pl = playingInfo();
    const baseId = (pl && pl.album && pl.album.id) || store.current.albumId;
    let gi = order.indexOf(baseId);
    if (gi < 0) gi = 0;
    const target = order[(gi + delta + order.length) % order.length];
    const idx = q.items.findIndex(it => it.albumId === target);
    if (idx >= 0) { q.pos = idx; playAt(q.items[idx].albumId, q.items[idx].trackIndex); }
    return;
  }
  // 以"正在播的那张"为基准：手动选中别的专辑在看时，下一张专辑仍按播放中的那张算
  const baseId = playing.stepBaseAlbumId({
    albums: albums(),
    currentAlbumId: store.current.albumId,
    pin: selectionPin,
    playingBvid: playback.bvid
  });
  let idx = albums().findIndex(a => a.id === baseId);
  if (idx < 0) idx = 0;
  const next = (idx + delta + albums().length) % albums().length;
  const target = albums()[next];
  const list = target.tracks || [];
  let j = delta > 0 ? 0 : Math.max(0, list.length - 1);
  if (settings().skipHidden) {
    if (delta > 0) { while (j < list.length && list[j].hidden) j++; if (j >= list.length) j = 0; }
    else { while (j >= 0 && list[j].hidden) j--; if (j < 0) j = 0; }
  }
  playAt(target.id, j);
}

async function togglePlay() {
  const revision = ++transportRevision;
  transportPending++;
  try {
    const a = currentAlbum();
    const loaded = playback.bvid || (cdp.lastState && cdp.lastState.bvid) || '';
    // 暂停且选中另一张专辑时开播所选项；播完即停后按播放则重播本曲。
    if (a && loaded !== a.bvid && playback.paused) return playAt(a.id, store.current.trackIndex || 0);
    if (stoppedTrack && manualPause) return playAt(stoppedTrack.albumId, stoppedTrack.trackIndex);
    await ensureConnection();
    if (revision !== transportRevision) return;
    const r = await cdp.togglePlay();
    if (revision !== transportRevision) return;
    if (r && r.ok) {
      playback.paused = r.paused;
      manualPause = !!r.paused;
      if (playIntent) {
        playIntent.play = !r.paused;
        if (r.paused && playIntent.loading) { playIntent = null; cdp.cancelPendingPlay(); }
      }
      setMessage(r.paused ? '已暂停' : '继续播放');
    }
  } catch (e) { setMessage('控制浏览器失败：' + e.message); }
  finally { transportPending--; }
}

/** 拖动进度保持实际的播放 / 暂停状态。 */
async function seekTo(seconds) {
  const revision = ++transportRevision;
  transportPending++;
  playIntent = null;
  stoppedTrack = null;
  try {
    await ensureConnection();
    if (revision !== transportRevision) return false;
    const state = await cdp.state();
    if (revision !== transportRevision) return false;
    let play = !state.paused;
    const result = await cdp.seek(seconds, play);
    if (revision !== transportRevision || (result && result.cancelled)) return false;
    if (result && result.userOverride) play = !result.paused;
    manualPause = !play;
    playback.t = seconds;
    playback.paused = !play;
    guardUntil = Date.now() + 1500;
    broadcast();
    return true;
  } finally { transportPending--; }
}

/** 只切换当前专辑（显示曲目列表），不操作浏览器 */
function selectAlbum(albumId) {
  const album = albums().find(a => a.id === albumId);
  if (!album) { setMessage('找不到这张专辑'); return false; }
  const same = store.current.albumId === albumId;
  const maxIdx = Math.max(0, (album.tracks || []).length - 1);
  const idx = same ? Math.min(store.current.trackIndex || 0, maxIdx) : 0;
  // 记住"是我手动选的、还没播"，轮询不要把它拽回正在播放的那张
  selectionPin = { albumId, bvid: playback.bvid || '' };
  store.patch({ current: { albumId, trackIndex: idx } });
  // 不动播放队列：队列代表"正在播的那张"，这样歌播完还能正常接着放
  setMessage(`已选中「${album.title}」，点播放开始`);
  return true;
}

async function replay() {
  const a = currentAlbum();
  if (a) playAt(a.id, store.current.trackIndex);
}

/* ---------------- 轮询：进度、曲目自动跟随、自动连播 ---------------- */

async function pollOnce() {
  if (!cdp.connected) {
    autoConnectTick++;
    if (autoConnectTick % 3 === 0) {
      const v = await cdp.version();
      if (v) {
        try { await ensureConnection(currentAlbum() && currentAlbum().bvid); }
        catch (_) { /* 保持未连接 */ }
      }
    }
    return;
  }
  let s;
  const intentAtRead = playIntent;
  const wasLoading = !!(intentAtRead && intentAtRead.loading);
  const revisionAtRead = transportRevision, wasTransportPending = transportPending > 0;
  cdp.prefer360p = settings().prefer360p !== false;
  try { s = await cdp.state(); }
  catch (e) {
    if (intentAtRead !== playIntent || wasLoading || (playIntent && playIntent.loading) ||
        revisionAtRead !== transportRevision || wasTransportPending || transportPending > 0) return;
    conn.connected = false;
    conn.message = '连接中断，正在重试…';
    cdp.disconnect();
    broadcast();
    return;
  }
  if (!s) return;
  // 丢弃点歌前发出的旧轮询，以及尚未完成导航 / 定位时读到的历史播放进度。
  if (intentAtRead !== playIntent || wasLoading || (playIntent && playIntent.loading) ||
      revisionAtRead !== transportRevision || wasTransportPending || transportPending > 0) return;
  if (!s.paused) { manualPause = false; stoppedTrack = null; }
  else if (s.ended === false) {
    manualPause = true;
    if (playIntent) playIntent.play = false;
  }
  if (playIntent) {
    const intent = playIntent;
    if (Date.now() >= intent.protectUntil || (s.bvid && s.bvid !== intent.bvid)) {
      playIntent = null;
    } else if (!s.ok) {
      return;
    } else if (s.bvid === intent.bvid) {
      const elapsed = Math.max(0, (Date.now() - intent.anchorAt) / 1000);
      const rate = Math.max(1, Number(s.playbackRate) || 1);
      const t = Number(s.t) || 0;
      // B 站可能先接受 seek，再延迟恢复历史位置；实际播放不能瞬间多走几首歌。
      if (t < intent.start - 1 || t > intent.anchorT + elapsed * rate + 3) {
        await playAt(intent.albumId, intent.trackIndex, { protectUntil: intent.protectUntil, play: intent.play && !manualPause });
        return;
      }
    }
  }
  const previous = { ...playback };
  const browserChanged = playback.bvid !== (s.bvid || '');
  if (browserChanged) stoppedTrack = null;
  playback.t = s.t || 0;
  playback.d = s.d || 0;
  playback.paused = s.paused;
  playback.bvid = s.bvid || '';
  playback.title = s.title || '';

  if (Date.now() > guardUntil) {
    // 必须先判断原视频是否刚到曲尾，再让浏览器 BV 更新视图 / 重建队列。
    // 否则网页抢先自动切集时，专内循环也会被误当成手动切换到下一张专辑。
    const oldQueue = store.data.queue;
    const oldItem = oldQueue && oldQueue.items && oldQueue.items[oldQueue.pos];
    const oldAlbum = oldItem && albums().find(a => a.id === oldItem.albumId);
    if (!manualPause && browserChanged && oldAlbum && previous.bvid === oldAlbum.bvid &&
        playing.isVideoTail({ ...previous, pollMs: settings().pollMs })) {
      if (Date.now() - lastAdvance > 2500) {
        lastAdvance = Date.now();
        guardUntil = Date.now() + 6000;
        // 可能只是选中了另一张专辑查看；仍从原队列推进。
        store.patch({ current: { albumId: oldItem.albumId, trackIndex: oldItem.trackIndex } });
        selectionPin = null;
        await finishTrack(true);
      }
      broadcast();
      return;
    }
    const byBv = s.bvid ? albums().find(a => a.bvid === s.bvid) : null;
    const fd = follow.pollFollow({
      playingBvid: s.bvid || '',
      currentAlbumId: store.current.albumId,
      albumIdOfBvid: byBv ? byBv.id : null,
      pin: selectionPin
    });
    selectionPin = fd.pin;
    // 用户在 B 站里自己点了别的专辑 → 跟随（手动选中但没播时不跟随）
    if (fd.follow && byBv && byBv.tracks && byBv.tracks.length) {
      store.patch({ current: { albumId: byBv.id, trackIndex: 0 } });
    }
    // 首次连接或用户在浏览器里换了视频时，先接上真实进度，避免把旧队列位置当作曲尾。
    if (browserChanged && byBv && !s.ended && !fd.pinned) {
      const idx = playing.trackIndexAt(byBv, s.t);
      if (idx >= 0) {
        store.patch({ current: { albumId: byBv.id, trackIndex: idx } });
        const oldQueue = store.data.queue;
        if (folderQueueSource() && !oldQueue.items.some(it => it.albumId === byBv.id && it.trackIndex === idx)) clearFolderQueue();
        ensureQueue();
        syncQueuePos();
      }
    }
    // 先按队列中的当前曲目判断曲尾，再跟随视频时间更新高亮。
    // 长视频可能已自然进入未收藏的下一首，不能拿那一首的 end 判断本首是否结束。
    const q = byBv ? ensureQueue() : null;
    const queued = q && q.items[q.pos];
    const queuedTrack = queued && byBv && queued.albumId === byBv.id
      ? byBv.tracks[queued.trackIndex] : null;
    const playTr = queuedTrack || (byBv && byBv.tracks && byBv.tracks[playing.trackIndexAt(byBv, s.t)]);
    const endedNow = playing.isTrackEnded({ track: playTr, t: s.t, d: s.d, paused: s.paused, ended: s.ended,
      leadSeconds: settings().playMode === 'once' ? 0 : 0.5 });
    // video.ended 也覆盖视频结束后暂停、进度被页面重置的情况。
    if (byBv && endedNow) {
      if (!manualPause && Date.now() - lastAdvance > 2500) {
        lastAdvance = Date.now();
        guardUntil = Date.now() + 6000;
        await finishTrack();
      }
      broadcast();
      return;
    }
    const a = currentAlbum();
    if (a && a.bvid === s.bvid && a.tracks && a.tracks.length) {
      let idx = a.tracks.findIndex((tr, k) => s.t >= tr.start && (k === a.tracks.length - 1 || s.t < tr.end - 0.2));
      if (idx < 0 && s.t < a.tracks[0].start) idx = 0;
      // 自动同步不要落到隐藏曲目上，否则跳过之后高亮又会跳回被隐藏的条目
      if (settings().skipHidden && idx >= 0 && a.tracks[idx].hidden && idx !== store.current.trackIndex) idx = -1;
      // 暂停在曲尾时也不要把当前项改成队列外的曲目。
      if (q && idx >= 0 && !q.items.some(it => it.albumId === a.id && it.trackIndex === idx)) idx = -1;
      if (idx >= 0 && idx !== store.current.trackIndex) store.patch({ current: { ...store.current, trackIndex: idx } });
      if (!fd.pinned) syncQueuePos();
    }
  }
  broadcast();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try { await pollOnce(); } catch (_) {} finally { pollInFlight = false; }
  }, Math.max(400, settings().pollMs || 1000));
}

/* ---------------- 浏览器启动 ---------------- */

function findBrowser() {
  const custom = settings().browserPath;
  if (custom && fs.existsSync(custom)) return custom;
  const list = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe')
  ];
  return list.find(p => p && fs.existsSync(p)) || null;
}

async function launchBrowser() {
  const exe = findBrowser();
  if (!exe) throw new Error('没有找到 Edge / Chrome，请在设置里手动指定浏览器路径');
  const port = settings().port || 9222;
  const profile = path.join(app.getPath('userData'), 'browser-profile');
  const album = currentAlbum();
  const bvid = (album && album.bvid) || 'BV1Tw411G74d';
  const url = `https://www.bilibili.com/video/${bvid}/`;
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1280,860',
    url
  ];
  conn.message = '正在启动专用浏览器…';
  broadcast();
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await sleep(400);
    if (await cdp.version()) break;
  }
  if (!(await cdp.version())) throw new Error('浏览器启动了，但调试端口没有响应（若已有同配置窗口请先关闭它）');
  await ensureConnection(bvid);
  setMessage('专用浏览器已就绪，首次使用请在里面登录 B 站');
  return true;
}

/* ---------------- 全局快捷键 ---------------- */

const ACTIONS = {
  nextTrack: () => stepTrack(1),
  prevTrack: () => stepTrack(-1),
  nextAlbum: () => stepAlbum(1),
  prevAlbum: () => stepAlbum(-1),
  togglePlay: () => togglePlay(),
  replay: () => replay(),
  toggleMain: () => toggleMain(),
  toggleMini: () => toggleMini()
};

let hotkeyErrors = [];
function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyErrors = [];
  const hk = settings().hotkeys || DEFAULT_HOTKEYS;
  for (const [key, accel] of Object.entries(hk)) {
    if (!accel || !ACTIONS[key]) continue;
    try {
      const ok = globalShortcut.register(accel, ACTIONS[key]);
      if (!ok) hotkeyErrors.push(`${accel}（可能被其他软件占用）`);
    } catch (e) { hotkeyErrors.push(`${accel}：${e.message}`); }
  }
}

/* ---------------- 窗口 ---------------- */

function createMain() {
  mainWin = new BrowserWindow({
    width: 1180, height: 760, minWidth: 980, minHeight: 620,
    frame: false, backgroundColor: '#0b0d13', show: false,
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  mainWin.once('ready-to-show', () => { mainWin.show(); });
  mainWin.on('close', e => {
    if (!quitting) { e.preventDefault(); mainWin.hide(); return; }
  });
  mainWin.on('closed', () => { mainWin = null; });
  mainWin.on('show', broadcast);
  mainWin.on('restore', broadcast);
  mainWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function createMini() {
  const wa = screen.getPrimaryDisplay().workArea;
  const sz = miniSize(settings().miniStyle);
  miniWin = new BrowserWindow({
    width: sz.width, height: sz.height,
    x: wa.x + wa.width - sz.width - 24,
    y: wa.y + wa.height - sz.height - 36,
    frame: false, resizable: false, movable: true, skipTaskbar: true,
    alwaysOnTop: true, show: false, backgroundColor: '#11131c',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  miniWin.setAlwaysOnTop(true, 'screen-saver');
  miniWin.loadFile(path.join(__dirname, 'mini.html'));
  miniWin.once('ready-to-show', () => { if (settings().miniVisible) miniWin.showInactive(); });
  miniWin.on('show', broadcast);
  miniWin.on('close', e => { if (!quitting) { e.preventDefault(); miniWin.hide(); } });
  miniWin.on('moved', () => {
    if (!miniWin || miniWin.isDestroyed() || miniCollapsed) return;
    // 卡片被拖走：弹窗跟着收起，避免浮在原处
    if (miniPopWin && !miniPopWin.isDestroyed() && miniPopWin.isVisible()) { hideMiniPop(); return; }
    store.data.miniBounds = miniWin.getBounds(); store.scheduleSave();
    if (!settings().miniEdgeHide) return;
    const edge = miniEdgeOf(miniWin.getBounds());
    if (edge) {
      clearTimeout(miniCollapseTimer);
      miniCollapseTimer = setTimeout(() => collapseMini(edge), 650);
    }
  });
  if (store.data.miniBounds) {
    try {
      const b = store.data.miniBounds;
      const sz2 = miniSize(settings().miniStyle);
      miniWin.setBounds({ x: b.x, y: b.y, width: sz2.width, height: sz2.height });
    } catch (_) {}
  }
  if (!miniWatchTimer) startMiniWatch();
}

/* ── 悬浮窗样式 / 贴边自动隐藏 ── */

let miniCollapsed = false, miniCollapsedEdge = '', miniExpandedBounds = null;
let miniCollapseTimer = null, miniExpandAt = 0, miniWatchTimer = null;
/** 悬浮窗弹出面板（收藏夹 / 播放列表 / 播放顺序）：独立小窗口，卡片尺寸不变 */
let miniPopWin = null, miniPopKind = '', miniPopHiddenAt = 0, miniPopShownAt = 0;
const miniPopLog = [];
function popLog(msg) { if (miniPopLog.length > 60) miniPopLog.shift(); miniPopLog.push(msg); }

/** 把窗口矩形夹进工作区，保证完整可见 */
/** 收起后露出的边缘宽度（px）：越大越明显，1~16 */
function miniPeek() {
  return Math.max(1, Math.min(16, Math.round(Number(settings().miniPeek) || 3)));
}

function clampToWorkArea(b) {
  return geo.clampToWorkArea(b, screen.getDisplayMatching(b).workArea);
}

function applyMiniStyle() {
  if (!miniWin || miniWin.isDestroyed()) return;
  hideMiniPop();
  const sz = geo.miniSize(settings().miniStyle);
  const b = miniWin.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;

  // 收起状态：尺寸一变，贴边位置必须按新尺寸重算，否则内容会被塞进旧尺寸里错位
  if (miniCollapsed) {
    miniWin.setBounds(geo.resizedCollapsedBounds(b, sz, miniCollapsedEdge || 'right', wa, miniPeek()));
    // 展开位置也要跟着换尺寸，并保证仍在屏幕内
    if (miniExpandedBounds) {
      miniExpandedBounds = geo.clampToWorkArea({ ...miniExpandedBounds, width: sz.width, height: sz.height }, wa);
    }
    return;
  }

  if (b.width === sz.width && b.height === sz.height) return;
  miniWin.setBounds(geo.resizedExpandedBounds(b, sz, wa));
}

function miniEdgeOf(b) {
  return geo.edgeOf(b, screen.getDisplayMatching(b).workArea);
}

/* ── 悬浮窗弹出面板：独立小窗口，贴着卡片浮在旁边，不改卡片尺寸 ── */

function ensureMiniPop() {
  if (miniPopWin && !miniPopWin.isDestroyed()) return miniPopWin;
  miniPopWin = new BrowserWindow({
    width: 320, height: 240, show: false, frame: false, resizable: false, movable: false,
    skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#11131c',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  miniPopWin.setAlwaysOnTop(true, 'screen-saver');
  // 点到别处（包括点卡片本身）就收起；保留 kind，方便同一个按钮再点一下当开关
  // 刚显示的 300ms 内忽略失焦：Windows 下 show()+focus() 偶尔会立刻回一次 blur，会把弹窗闪没
  miniPopWin.on('blur', () => {
    popLog('blur@' + Date.now());
    if (Date.now() - miniPopShownAt < 300) return;
    hideMiniPop(true);
  });
  miniPopWin.on('close', e => { if (!quitting) { e.preventDefault(); miniPopWin.hide(); } });
  miniPopWin.on('closed', () => { miniPopWin = null; });
  return miniPopWin;
}

function openMiniPop(kind) {
  if (!miniWin || miniWin.isDestroyed()) return { open: false };
  if (!miniWin.isVisible()) miniWin.showInactive();
  if (miniCollapsed) expandMini();
  const visible = miniPopWin && !miniPopWin.isDestroyed() && miniPopWin.isVisible();
  // 同一个按钮再点一次 = 收起（刚因失焦收起的那一下也算）
  if (miniPopKind === kind && (visible || Date.now() - miniPopHiddenAt < 320)) {
    hideMiniPop();
    return { open: false };
  }
  const w = ensureMiniPop();
  miniPopKind = kind;
  w.loadFile(path.join(__dirname, 'mini-pop.html'), { query: { kind } })
    .then(() => { popLog(`load:${kind}@${Date.now()}`); })
    .catch(e => { popLog(`loaderr:${kind}:${e.message}@${Date.now()}`); });
  return { open: true };
}

function hideMiniPop(keepKind) {
  if (miniPopWin && !miniPopWin.isDestroyed() && miniPopWin.isVisible()) {
    miniPopWin.hide();
    popLog('hide@' + Date.now());
  }
  miniPopHiddenAt = Date.now();
  if (!keepKind) miniPopKind = '';
}

/** 页面量好内容尺寸后由主进程定位并显示 */
function placeMiniPop(height, width) {
  if (!miniPopWin || miniPopWin.isDestroyed() || !miniWin || miniWin.isDestroyed()) return null;
  if (!miniPopKind) return null;
  const card = miniWin.getBounds();
  const wa = screen.getDisplayMatching(card).workArea;
  // 播放列表要宽（专辑名/歌名长）；收藏夹和顺序菜单按内容宽，最窄 180、最宽不超过卡片
  const wantW = miniPopKind === 'queue'
    ? Math.max(card.width, 300)
    : Math.min(card.width, 320, Math.max(180, Math.round(Number(width) || 0)));
  const lay = geo.popBounds(card, { width: wantW, height }, wa);
  miniPopWin.setBounds(lay.bounds);
  if (!miniPopWin.isVisible()) { miniPopShownAt = Date.now(); miniPopWin.show(); miniPopWin.focus(); popLog('show@' + Date.now() + ' url=' + miniPopWin.webContents.getURL().split('kind=')[1]); }
  return lay;
}

function collapseMini(edge, force) {
  if (!miniWin || miniWin.isDestroyed() || miniCollapsed) return;
  // 自动收起受「贴边隐藏」开关控制；手动收起（force）不受限
  if (!force && !settings().miniEdgeHide) return;
  if (!miniWin.isVisible()) return;
  hideMiniPop();
  const b = miniWin.getBounds();
  const p = screen.getCursorScreenPoint();
  // 鼠标还停在窗口上就不收，等它离开
  if (!force && p.x >= b.x - 10 && p.x <= b.x + b.width + 10 && p.y >= b.y - 10 && p.y <= b.y + b.height + 10) return;
  const wa = screen.getDisplayMatching(b).workArea;
  miniExpandedBounds = { ...b };
  miniCollapsedEdge = edge;
  miniCollapsed = true;
  miniWin.setBounds(geo.collapsedBounds(b, edge, wa, miniPeek()));
}

function expandMini() {
  if (!miniWin || miniWin.isDestroyed() || !miniCollapsed || !miniExpandedBounds) return;
  miniCollapsed = false;
  miniExpandAt = Date.now();
  miniWin.setBounds(miniExpandedBounds);
}

/** 手动把悬浮窗收起到指定侧边（left / right），不依赖「贴边隐藏」开关 */
function collapseMiniToEdge(edge) {
  if (!miniWin || miniWin.isDestroyed()) return;
  if (!miniWin.isVisible()) miniWin.showInactive();
  hideMiniPop();
  if (miniCollapsed) {
    miniCollapsed = false;
    if (miniExpandedBounds) miniWin.setBounds(miniExpandedBounds);
  }
  const b = miniWin.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const x = edge === 'left' ? wa.x : wa.x + wa.width - b.width;
  const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - b.height));
  miniWin.setBounds({ x, y, width: b.width, height: b.height });
  setTimeout(() => collapseMini(edge, true), 140);
}

function nearestSide() {
  if (!miniWin || miniWin.isDestroyed()) return 'right';
  const b = miniWin.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  return (b.x + b.width / 2) < (wa.x + wa.width / 2) ? 'left' : 'right';
}

function startMiniWatch() {
  if (miniWatchTimer) clearInterval(miniWatchTimer);
  miniWatchTimer = setInterval(() => {
    if (!miniWin || miniWin.isDestroyed()) return;
    if (!miniWin.isVisible()) return;
    if (miniPopWin && !miniPopWin.isDestroyed() && miniPopWin.isVisible()) return; // 弹窗开着时不做贴边收起 / 滑出判断
    const b = miniWin.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const p = screen.getCursorScreenPoint();
    if (miniCollapsed) {
      // 收起后滑出：手动收起也适用
      const band = miniPeek() + 5;
      const inBand = miniCollapsedEdge === 'left' ? p.x <= wa.x + band
        : miniCollapsedEdge === 'right' ? p.x >= wa.x + wa.width - band
        : p.y <= wa.y + band;
      const inSpan = p.y >= b.y - 6 && p.y <= b.y + b.height + 6;
      if (inBand && inSpan) expandMini();
    } else if (!settings().miniEdgeHide) {
      return;
    } else if (Date.now() - miniExpandAt > 1200) {
      const inside = p.x >= b.x - 10 && p.x <= b.x + b.width + 10 && p.y >= b.y - 10 && p.y <= b.y + b.height + 10;
      if (!inside) {
        const edge = miniEdgeOf(b);
        if (edge) collapseMini(edge);
      }
    }
  }, 200);
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMain();
  mainWin.show(); mainWin.focus();
}
function toggleMain() {
  if (!mainWin || mainWin.isDestroyed()) { showMain(); return; }
  if (mainWin.isVisible()) mainWin.hide(); else showMain();
}
/** 悬浮窗的「正常位置」：上次的位置（夹进工作区），没记录过就右下角默认位 */
function miniHomeBounds() {
  const sz = geo.miniSize(settings().miniStyle);
  const wa = screen.getPrimaryDisplay().workArea;
  const def = {
    x: wa.x + wa.width - sz.width - 24,
    y: wa.y + wa.height - sz.height - 36,
    width: sz.width, height: sz.height
  };
  const b = store.data.miniBounds;
  if (!b || typeof b.x !== 'number' || typeof b.y !== 'number') return def;
  const r = geo.clampToWorkArea({ x: b.x, y: b.y, width: sz.width, height: sz.height }, wa);
  // 离边缘留点余量，否则刚唤出就被「贴边自动隐藏」又收回去
  const m = miniPeek() + 6;
  r.x = Math.max(wa.x + m, Math.min(r.x, wa.x + wa.width - r.width - m));
  r.y = Math.max(wa.y + m, Math.min(r.y, wa.y + wa.height - r.height - m));
  return r;
}

/** 悬浮窗是不是"藏起来了"：窗口隐藏，或已收起到边缘只剩一条 */
function miniIsHidden() {
  if (!miniWin || miniWin.isDestroyed()) return true;
  return !miniWin.isVisible() || miniCollapsed;
}

/** 唤出悬浮窗，并回到正常位置（不是留在边缘那条缝） */
function summonMini() {
  if (!miniWin || miniWin.isDestroyed()) createMini();
  hideMiniPop();
  miniCollapsed = false;
  miniExpandedBounds = null;
  miniWin.setBounds(miniHomeBounds());
  miniWin.showInactive();
  miniExpandAt = Date.now();   // 给一点缓冲，别马上又被贴边隐藏
  store.patchSettings({ miniVisible: true });
  broadcast();
  return true;
}

/**
 * 开启 / 关闭悬浮窗：
 * 藏起来了（隐藏或收到边缘）→ 唤出并回到正常位置；正常显示中 → 直接关闭
 */
function toggleMini() {
  if (miniIsHidden()) return summonMini();
  hideMiniPop();
  miniWin.hide();
  store.patchSettings({ miniVisible: false });
  broadcast();
  return true;
}

/* ---------------- 托盘 ---------------- */

function hkText(accel) {
  return String(accel || '')
    .replace(/Right/g, '→').replace(/Left/g, '←').replace(/Up/g, '↑').replace(/Down/g, '↓')
    .replace(/Space/g, '空格').replace(/\+/g, ' + ');
}

/** 窄菜单数据：只放文字，快捷键通过 hover 浮窗显示 */
function trayData(s) {
  const hk = s.settings.hotkeys || {};
  const tip = k => hkText(hk[k]);
  return {
    connected: !!s.conn.connected,
    browser: s.conn.browser || '',
    trackName: s.current.track ? s.current.track.name : '',
    items: [
      { label: '上一首', act: 'prev', tip: tip('prevTrack') },
      { label: '下一首', act: 'next', tip: tip('nextTrack') },
      { label: '播放 / 暂停', act: 'toggle', tip: tip('togglePlay') },
      { label: '上一张专辑', act: 'prevAlbum', tip: tip('prevAlbum') },
      { label: '下一张专辑', act: 'nextAlbum', tip: tip('nextAlbum') },
      { sep: true },
      { label: '显示主窗口', act: 'showMain', tip: tip('toggleMain') },
      { label: '迷你悬浮窗', act: 'mini', tip: tip('toggleMini'), checked: !!(miniWin && !miniWin.isDestroyed() && miniWin.isVisible() && !miniCollapsed) },
      { label: '收起到侧边', act: 'collapse' },
      { sep: true },
      { label: '退出', act: 'quit', danger: true }
    ]
  };
}

let trayMenuWin = null;

function createTrayMenuWin() {
  trayMenuWin = new BrowserWindow({
    width: 200, height: 340, frame: false, transparent: true, resizable: false,
    movable: false, skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  trayMenuWin.setAlwaysOnTop(true, 'screen-saver');
  trayMenuWin.loadFile(path.join(__dirname, 'tray.html'));
  trayMenuWin.on('blur', () => hideTrayMenu());
  trayMenuWin.on('closed', () => { trayMenuWin = null; });
}

function showTrayMenu() {
  if (!trayMenuWin || trayMenuWin.isDestroyed()) createTrayMenuWin();
  const s = snapshot();
  const data = trayData(s);
  const p = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(p).workArea;
  const itemH = data.items.reduce((a, it) => a + (it.sep ? 11 : 28), 0);
  const height = Math.min(600, 53 + (data.trackName ? 27 : 0) + itemH + 14);
  // 预留右侧浮窗空间，保证 hover 展开后仍在屏幕内
  const x = Math.max(wa.x + 4, Math.min(p.x - 100, wa.x + wa.width - 376));
  const y = Math.max(wa.y + 4, Math.min(p.y - 20, wa.y + wa.height - height - 4));
  trayMenuWin.setBounds({ x: Math.round(x), y: Math.round(y), width: 200, height: Math.round(height) });
  const reveal = () => {
    if (!trayMenuWin || trayMenuWin.isDestroyed()) return;
    trayMenuWin.webContents.send('tray:data', data);
    trayMenuWin.show();
    trayMenuWin.focus();
  };
  // 首次创建时页面还没加载完，直接 send 会丢数据
  if (trayMenuWin.webContents.isLoading()) {
    trayMenuWin.webContents.once('did-finish-load', reveal);
  } else {
    reveal();
  }
}

function hideTrayMenu() {
  if (!trayMenuWin || trayMenuWin.isDestroyed()) return;
  const b = trayMenuWin.getBounds();
  trayMenuWin.hide();
  if (b.width !== 200) trayMenuWin.setBounds({ x: b.x, y: b.y, width: 200, height: b.height });
}

function updateTrayMenu(s) {
  if (!tray || tray.isDestroyed()) return;
  const tip = '唱片台 · ' + (s.current.track ? s.current.track.name : 'AlbumDeck');
  if (tip !== lastMenuSignature) { lastMenuSignature = tip; tray.setToolTip(tip); }
  // 菜单打开期间不刷新：每秒 broadcast 会重建 DOM，把 hover 的快捷键浮窗打断
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
  tray.on('click', () => toggleMain());
  tray.on('double-click', () => showMain());
  tray.on('right-click', () => showTrayMenu());
  updateTrayMenu(snapshot());
}

/* ---------------- IPC ---------------- */

const ok = data => ({ ok: true, data });
const fail = e => ({ ok: false, error: String((e && e.message) || e) });

function registerIpc() {
  const h = (channel, fn) => ipcMain.handle(channel, async (_e, arg) => {
    try { return ok(await fn(arg)); } catch (e) { console.error(channel, e); return fail(e); }
  });

  h('state', () => snapshot());
  h('conn:connect', async () => { await ensureConnection(currentAlbum() && currentAlbum().bvid); return snapshot(); });
  h('conn:launch', async () => { await launchBrowser(); return snapshot(); });
  h('conn:browserPath', () => findBrowser() || '');

  h('play:at', async ({ albumId, index }) => playAt(albumId, index));
  h('play:select', ({ albumId }) => selectAlbum(albumId));
  h('play:next', async () => stepTrack(1));
  h('play:prev', async () => stepTrack(-1));
  h('play:albumNext', async () => stepAlbum(1));
  h('play:albumPrev', async () => stepAlbum(-1));
  h('play:setMode', mode => setPlayMode(mode));
  h('play:toggle', async () => togglePlay());
  h('play:replay', async () => replay());
  h('play:seek', async ({ seconds }) => seekTo(seconds));
  h('play:bvid', async ({ bvid }) => {
    try {
      const revision = ++transportRevision;
      playIntent = null; stoppedTrack = null; manualPause = false;
      await ensureConnection(bvid);
      if (revision !== transportRevision) return false;
      const result = await cdp.openVideo(bvid, 0, true);
      return revision === transportRevision && !(result && result.cancelled);
    }
    catch (e) { setMessage('打开失败：' + e.message); return false; }
  });

  h('library:addAlbums', async (list) => {
    const exist = new Set(albums().map(a => a.bvid));
    let added = 0;
    for (const a of list) {
      if (!a || !a.bvid || exist.has(a.bvid)) continue;
      exist.add(a.bvid);
      albums().push(a);
      added++;
    }
    store.save(); refreshQueue(); broadcast();
    // 回传 bvid → albumId，供「导入到收藏夹」直接构造收藏项
    const ids = {};
    for (const a of list) {
      const found = albums().find(x => x.bvid === a.bvid);
      if (found) ids[a.bvid] = found.id;
    }
    return { added, total: albums().length, ids };
  });

  /** 重新导入某个视频：收藏夹里「已不在曲库」的项靠它救回来（也会把收藏项重新接上） */
  h('library:reimport', async ({ bvid }) => {
    if (!bvid) throw new Error('缺少 BV 号');
    const info = await bili.getVideoInfo(bvid);
    const built = await bili.buildAlbumsFromArchives([info], () => {}, 1);
    const fresh = built && built[0];
    if (!fresh) throw new Error('没有取到视频信息');

    const old = albums().find(a => a.bvid === bvid);
    let album;
    if (old) {
      // 已存在：原地刷新，保留原 id，避免队列和收藏项失效
      old.title = fresh.title || old.title;
      old.duration = fresh.duration || old.duration;
      old.pic = fresh.pic || old.pic;
      old.aid = fresh.aid || old.aid;
      if ((fresh.tracks || []).length) {
        old.tracks = fresh.tracks;
        old.tracksSource = fresh.tracksSource;
        old.tracksOk = true;
      }
      album = old;
    } else {
      albums().push(fresh);
      album = fresh;
    }

    // 把收藏夹里指向这个 bvid 的项重新接上（专辑 id 变了、曲目索引也可能变）
    let fixed = 0, lost = 0;
    for (const f of folders()) {
      for (const it of (f.items || [])) {
        if (it.bvid !== bvid) continue;
        it.albumId = album.id;
        if (it.kind === 'album') {
          it.title = album.title;
          it.duration = album.duration || 0;
        } else {
          const i = (album.tracks || []).findIndex(t => Math.abs(t.start - it.start) < 2);
          if (i >= 0) {
            const t = album.tracks[i];
            it.trackIndex = i;
            it.name = t.name;
            it.albumTitle = album.title;
            it.duration = Math.max(0, (t.end || 0) - t.start);
          } else {
            lost++;
          }
        }
        fixed++;
      }
    }
    store.save(); refreshQueue(); broadcast();
    return { albumId: album.id, title: album.title, tracks: (album.tracks || []).length, fixed, lost, existed: !!old };
  });
  h('library:setAlbums', async (list) => { store.albums = list; refreshQueue(); broadcast(); return true; });
  /** 按歌名 / 年份 / 歌手自动排序专辑 */
  h('library:sortAlbums', ({ by }) => {
    store.albums = sortMod.sortAlbums(albums(), by);
    store.save(); refreshQueue(); broadcast();
    return store.albums.length;
  });  h('library:updateAlbum', async ({ id, patch }) => {
    const a = albums().find(x => x.id === id);
    if (!a) throw new Error('专辑不存在');
    if (patch.tracks) {
      patch = { ...patch, tracks: normalizeTracks(patch.tracks, patch.duration || a.duration || 0) };
      patch.tracksOk = patch.tracks.length > 0;
    }
    Object.assign(a, patch);
    if (a.id === store.current.albumId && a.tracks) {
      store.current.trackIndex = Math.min(store.current.trackIndex, Math.max(0, a.tracks.length - 1));
    }
    store.save(); refreshQueue(); broadcast(); return true;
  });
  /** 往专辑里加入一首单曲 */
  h('library:addTrack', async ({ albumId, name, start }) => {
    const a = albums().find(x => x.id === albumId);
    if (!a) throw new Error('专辑不存在');
    const sec = parseTimeInput(start);
    a.tracks = normalizeTracks([...(a.tracks || []), { name, start: sec }], a.duration || 0);
    a.tracksOk = a.tracks.length > 0;
    store.save(); refreshQueue(); broadcast(); return a.tracks.length;
  });
  /** 曲目表为空时，按「整段视频 = 一首单曲」填充（名字用视频标题） */
  h('library:fillSingle', async ({ albumId }) => {
    const a = albums().find(x => x.id === albumId);
    if (!a) throw new Error('专辑不存在');
    let duration = a.duration || 0, videoTitle = '';
    try {
      const info = await bili.getVideoInfo(a.bvid);
      duration = duration || info.duration || 0;
      videoTitle = info.title || '';
    } catch (_) { /* 网络失败就用专辑名兜底 */ }
    a.duration = duration;
    a.tracks = [{ name: bili.cleanTrackName(videoTitle || a.title), start: 0, end: duration }];
    a.tracksOk = true;
    store.save(); refreshQueue(); broadcast();
    return a.tracks.length;
  });
  /** 隐藏 / 恢复一首单曲（隐藏后播放时自动跳过，可随时恢复） */
  /** 调整专辑顺序（影响侧边栏顺序和播放队列的专辑顺序） */
  h('library:reorderAlbums', ({ from, to }) => {
    const list = albums();
    const n = list.length;
    from = Number(from); to = Number(to);
    if (n < 2 || from < 0 || from >= n || to < 0 || to >= n || from === to) return false;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    store.save();
    refreshQueue();
    broadcast();
    return true;
  });
  /** 调整专辑内曲目顺序（只改播放顺序，不改时间戳） */
  h('library:reorderTracks', ({ albumId, from, to }) => {
    const a = albums().find(x => x.id === albumId);
    if (!a || !Array.isArray(a.tracks)) return false;
    const n = a.tracks.length;
    from = Number(from); to = Number(to);
    if (n < 2 || from < 0 || from >= n || to < 0 || to >= n || from === to) return false;
    // 记住当前正在播的那首，重排后按 start 找回它的新索引
    const curStart = a.id === store.current.albumId && a.tracks[store.current.trackIndex]
      ? a.tracks[store.current.trackIndex].start : null;
    const [moved] = a.tracks.splice(from, 1);
    a.tracks.splice(to, 0, moved);
    if (curStart != null) {
      const ni = a.tracks.findIndex(t => t.start === curStart);
      if (ni >= 0 && ni !== store.current.trackIndex) {
        store.patch({ current: { ...store.current, trackIndex: ni } });
      }
    }
    store.save();
    refreshQueue();     // 播放列表顺序跟着变
    broadcast();
    return true;
  });
  h('library:toggleTrackHidden', async ({ albumId, index }) => {
    const a = albums().find(x => x.id === albumId);
    if (!a || !a.tracks || !a.tracks[index]) throw new Error('曲目不存在');
    const t = a.tracks[index];
    t.hidden = !t.hidden;
    store.save();
    const wasCurrent = a.id === store.current.albumId && Number(index) === Number(store.current.trackIndex);
    broadcast();
    if (t.hidden && wasCurrent && settings().skipHidden) nextTrack();
    return { hidden: !!t.hidden };
  });
  /** 从专辑里删除一首单曲 */
  h('library:removeTrack', async ({ albumId, index }) => {
    const a = albums().find(x => x.id === albumId);
    if (!a || !a.tracks || !a.tracks[index]) throw new Error('曲目不存在');
    a.tracks.splice(index, 1);
    a.tracks = normalizeTracks(a.tracks, a.duration || 0);
    a.tracksOk = a.tracks.length > 0;
    if (a.id === store.current.albumId) {
      store.current.trackIndex = Math.min(store.current.trackIndex, Math.max(0, a.tracks.length - 1));
    }
    store.save(); refreshQueue(); broadcast(); return a.tracks.length;
  });
  h('library:deleteAlbum', async ({ id }) => {
    store.albums = albums().filter(a => a.id !== id);
    if (!albums().some(a => a.id === store.current.albumId)) {
      store.patch({ current: { albumId: albums()[0] ? albums()[0].id : null, trackIndex: 0 } });
    }
    refreshQueue(); broadcast(); return true;
  });
  h('library:resetSeed', async () => {
    store.albums = loadSeed();
    store.patch({ current: { albumId: store.albums[0] ? store.albums[0].id : null, trackIndex: 0 } });
    refreshQueue(); broadcast(); return true;
  });
  h('library:export', async () => {
    const r = await dialog.showSaveDialog(mainWin, { title: '导出曲库', defaultPath: 'album-deck-library.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, JSON.stringify({ albums: albums(), folders: folders() }, null, 2), 'utf8');
    return r.filePath;
  });
  h('library:importFile', async () => {
    const r = await dialog.showOpenDialog(mainWin, { title: '导入曲库', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return 0;
    const j = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    const list = Array.isArray(j) ? j : (j.albums || []);
    const exist = new Set(albums().map(a => a.bvid));
    let n = 0;
    for (const a of list) if (a.bvid && !exist.has(a.bvid)) { albums().push(a); exist.add(a.bvid); n++; }
    if (Array.isArray(j.folders)) {
      const ids = new Set(folders().map(f => f.id));
      for (const f of j.folders) {
        if (!f || !f.id || f.id === LIKED_ID || ids.has(f.id)) continue;
        folders().push({ id: f.id, name: f.name || '未命名', type: f.type === 'album' ? 'album' : 'song', builtin: false, items: Array.isArray(f.items) ? f.items : [] });
        ids.add(f.id);
      }
    }
    store.save(); refreshQueue(); broadcast(); return n;
  });

  /* ---------------- 收藏夹 ---------------- */
  h('fav:create', ({ name, type }) => {
    const n = String(name || '').trim().slice(0, 24) || '新收藏夹';
    const f = {
      id: 'fav_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: n, type: type === 'album' ? 'album' : 'song', builtin: false, items: []
    };
    store.folders = [...folders(), f];
    broadcast(); return f;
  });
  h('fav:rename', ({ id, name }) => {
    const f = folderById(id); if (!f) throw new Error('收藏夹不存在');
    f.name = String(name || '').trim().slice(0, 24) || f.name;
    store.save(); broadcast(); return f;
  });
  h('fav:delete', ({ id }) => {
    const f = folderById(id);
    if (!f) return false;
    if (f.builtin) throw new Error('内置「喜欢」收藏夹不能删除');
    store.folders = folders().filter(x => x.id !== id);
    store.save();
    if ((folderQueueSource() || {}).id === id) clearFolderQueue();
    broadcast(); return true;
  });
  h('fav:clear', ({ id }) => {
    const f = folderById(id); if (!f) return false;
    f.items = []; store.save(); syncFolderQueue(id); broadcast(); return true;
  });
  /** 红心：切换歌曲在内置「喜欢」收藏夹中的状态 */
  h('fav:like', ({ item }) => {
    const f = likedFolder();
    const key = songKey(item.bvid, item.start);
    const i = f.items.findIndex(x => x.key === key);
    let liked;
    if (i >= 0) { f.items.splice(i, 1); liked = false; }
    else {
      f.items.push({ ...item, key, kind: 'song' });
      liked = true;
    }
    store.save(); syncFolderQueue(f.id); broadcast(); return { liked, key };
  });
  /** 一键收藏：把歌曲/专辑加入指定收藏夹 */
  h('fav:add', ({ folderId, item }) => {
    const f = folderById(folderId); if (!f) throw new Error('收藏夹不存在');
    const key = item.kind === 'album' ? albumKey(item.bvid) : songKey(item.bvid, item.start);
    if (f.items.some(x => x.key === key)) return { added: false, key };
    f.items.push({ ...item, key });
    store.save(); syncFolderQueue(f.id); broadcast(); return { added: true, key };
  });
  h('fav:addMany', ({ folderId, items }) => {
    const f = folderById(folderId); if (!f) throw new Error('收藏夹不存在');
    let added = 0;
    for (const item of (items || [])) {
      const key = item.kind === 'album' ? albumKey(item.bvid) : songKey(item.bvid, item.start);
      if (f.items.some(x => x.key === key)) continue;
      f.items.push({ ...item, key });
      added++;
    }
    store.save(); syncFolderQueue(f.id); broadcast(); return { added };
  });
  h('fav:remove', ({ folderId, key }) => {
    const f = folderById(folderId); if (!f) return false;
    f.items = f.items.filter(x => x.key !== key);
    store.save(); syncFolderQueue(f.id); broadcast(); return true;
  });
  /** 调整收藏夹里的条目顺序 */
  h('fav:reorder', ({ folderId, from, to }) => {
    const f = folderById(folderId); if (!f || !Array.isArray(f.items)) return false;
    const n = f.items.length;
    from = Number(from); to = Number(to);
    if (n < 2 || from < 0 || from >= n || to < 0 || to >= n || from === to) return false;
    const [moved] = f.items.splice(from, 1);
    f.items.splice(to, 0, moved);
    store.save(); syncFolderQueue(f.id); broadcast(); return true;
  });
  /** 从收藏夹里点歌：整个收藏夹变成播放列表 */
  h('play:folderItem', async ({ folderId, item } = {}) => playFolderItem(folderId, item));
  /** 退出收藏夹队列，回到按播放顺序的整库队列 */
  h('queue:clearSource', () => { const r = clearFolderQueue(); broadcast(); return r; });
  /** 从收藏夹里点歌：按 bvid 找回专辑、按起点找回曲目 */
  h('play:favorite', async (item) => {
    let a = albums().find(x => x.id === item.albumId) || albums().find(x => x.bvid === item.bvid);
    if (!a) { setMessage('这首歌曲对应的专辑已不在曲库里'); return false; }
    let i = (a.tracks || []).findIndex(t => Math.abs(t.start - item.start) < 2);
    if (i < 0) i = 0;
    return playAt(a.id, i);
  });

  h('bili:parseText', ({ text, duration }) => bili.parseTimestamps(text, duration));
  h('bili:resolve', async (input) => {
    const r = await bili.resolveInput(input);
    const compact = {
      kind: r.kind,
      info: r.info ? { bvid: r.info.bvid, aid: r.info.aid, title: r.info.title, duration: r.info.duration, pic: r.info.pic } : null,
      mid: r.mid, seasonId: r.seasonId,
      seasons: (r.seasons || []).map(s => ({ type: s.type, id: s.id, title: s.title, count: s.count })),
      archives: (r.archives || []).map(a => ({ bvid: a.bvid, aid: a.aid, title: a.title, duration: a.duration, pic: a.pic })),
      bvids: r.bvids || [],
      keyword: r.keyword || ''
    };
    return compact;
  });
  h('bili:season', async ({ mid, id, type }) => {
    const list = type === 'series' ? await bili.getSeriesArchives(mid, id) : await bili.getSeasonArchives(mid, id);
    return list.map(a => ({ bvid: a.bvid, aid: a.aid, title: a.title, duration: a.duration, pic: a.pic }));
  });
  h('bili:search', async (keyword) => bili.searchVideos(keyword));
  h('bili:videoInfo', async (bvid) => bili.getVideoInfo(bvid));
  h('bili:chapters', async (bvid) => bili.getChapters(bvid));
  h('bili:build', async (archives) => {
    if (importBusy) throw new Error('正在导入中，请稍候');
    importBusy = true; broadcast();
    try {
      const progress = (done, total, a) => {
        for (const w of [mainWin, miniWin]) {
          if (w && !w.isDestroyed()) w.webContents.send('import:progress', {
            done, total, title: a.title, tracks: a.tracks.length, ok: a.tracksOk, source: a.tracksSource || ''
          });
        }
      };
      return await bili.buildAlbumsFromArchives(archives, progress, 3);
    } finally { importBusy = false; broadcast(); }
  });

  h('settings:get', () => ({ ...settings(), hotkeyErrors: [...hotkeyErrors], browserFound: findBrowser() || '' }));
  h('settings:set', (patch) => {
    const oldPort = settings().port;
    store.patchSettings(patch);
    if (patch.port && patch.port !== oldPort) cdp.setPort(patch.port);
    if (patch.prefer360p != null) {
      cdp.prefer360p = settings().prefer360p !== false;
      if (cdp.connected) cdp.state().catch(() => {});
    }
    if (patch.hotkeys) registerHotkeys();
    if (patch.pollMs) startPolling();
    if (patch.browserPath) cdp.browser = undefined;
    if (patch.miniStyle) applyMiniStyle();
    if (patch.playMode) { rebuildQueue(); syncQueuePos(); }
    if (patch.miniEdgeHide === false && miniCollapsed) expandMini();
    if (patch.miniVisible === true && miniIsHidden()) summonMini();
    if (patch.miniVisible === false && miniWin && !miniWin.isDestroyed() && miniWin.isVisible()) { miniCollapsed = false; miniWin.hide(); }
    // 改「隐藏后露出」宽度：收起状态下立刻按新宽度重新贴边
    if (patch.miniPeek != null && miniCollapsed && miniWin && !miniWin.isDestroyed() && miniExpandedBounds) {
      const wa2 = screen.getDisplayMatching(miniExpandedBounds).workArea;
      miniWin.setBounds(geo.collapsedBounds(miniExpandedBounds, miniCollapsedEdge, wa2, miniPeek()));
    }
    broadcast();
    return settings();
  });
  h('settings:resetHotkeys', () => {
    store.patchSettings({ hotkeys: { ...DEFAULT_HOTKEYS } });
    registerHotkeys(); broadcast();
    return settings().hotkeys;
  });
  h('settings:pickBrowser', async () => {
    const r = await dialog.showOpenDialog(mainWin, { title: '选择浏览器 exe', properties: ['openFile'], filters: [{ name: '浏览器', extensions: ['exe'] }] });
    if (r.canceled || !r.filePaths[0]) return '';
    store.patchSettings({ browserPath: r.filePaths[0] });
    broadcast();
    return r.filePaths[0];
  });

  h('win:min', () => mainWin && mainWin.minimize());
  h('win:max', () => { if (!mainWin) return; mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize(); });
  h('win:close', () => mainWin && mainWin.hide());
  h('win:toggleMini', () => toggleMini());
  h('win:miniCollapse', (edge) => {
    const target = (edge === 'left' || edge === 'right') ? edge : nearestSide();
    collapseMiniToEdge(target);
    return target;
  });
  h('win:showMain', () => showMain());
  /** 主窗口可能刚被重建，等页面加载完再发指令，避免消息丢失 */
  function sendToMainWhenReady(channel, data) {
    setTimeout(() => {
      if (!mainWin || mainWin.isDestroyed()) return;
      const wc = mainWin.webContents;
      if (wc.isLoading()) wc.once('did-finish-load', () => wc.send(channel, data));
      else wc.send(channel, data);
    }, 140);
  }
  /** 悬浮窗「播放列表」按钮：打开主窗口并展开播放列表 */
  h('win:showQueue', () => { showMain(); sendToMainWhenReady('ui:openQueue'); return true; });
  /** 悬浮窗「收藏」按钮：打开主窗口并弹出收藏夹选择 */
  h('win:showFav', () => { showMain(); sendToMainWhenReady('ui:openFav'); return true; });
  /** 悬浮窗弹出面板：收藏夹 / 播放列表 / 播放顺序（独立小窗口，卡片不变） */
  h('mini:openPop', kind => openMiniPop(String(kind || 'fav')));
  h('pop:close', () => { hideMiniPop(); return true; });
  /** 弹窗页面量好内容高度后回调：定位 + 显示 */
  h('pop:size', ({ height, width } = {}) => {
    const lay = placeMiniPop(Number(height) || 240, Number(width) || 0);
    return lay ? { side: lay.side, bounds: lay.bounds } : null;
  });
  /** 悬浮窗里选「新建收藏夹」才唤起主窗口，并直接把待收藏项带过去 */
  h('win:newFav', ({ item } = {}) => { showMain(); sendToMainWhenReady('ui:newFav', item || null); return true; });
  h('win:quit', () => { quitting = true; app.quit(); });

  h('util:openExternal', (url) => { shell.openExternal(url); return true; });
  h('util:openDataDir', () => { shell.openPath(app.getPath('userData')); return true; });
  h('util:fmtTime', (s) => bili.fmtTime(s));

  /* ---- 自定义托盘菜单（窄菜单 + hover 浮出快捷键） ---- */
  ipcMain.on('tray:action', (_e, act) => {
    hideTrayMenu();
    if (act === 'prev') stepTrack(-1);
    else if (act === 'next') stepTrack(1);
    else if (act === 'toggle') togglePlay();
    else if (act === 'prevAlbum') stepAlbum(-1);
    else if (act === 'nextAlbum') stepAlbum(1);
    else if (act === 'showMain') showMain();
    else if (act === 'mini') toggleMini();
    else if (act === 'collapse') collapseMiniToEdge(nearestSide());
    else if (act === 'quit') { quitting = true; app.quit(); }
  });
  ipcMain.on('tray:expand', (_e, expand) => {
    if (!trayMenuWin || trayMenuWin.isDestroyed() || !trayMenuWin.isVisible()) return;
    const b = trayMenuWin.getBounds();
    const w = expand ? 372 : 200;
    if (b.width === w) return;
    trayMenuWin.setBounds({ x: b.x, y: b.y, width: w, height: b.height });
  });
  ipcMain.on('tray:resize', (_e, h) => {
    if (!trayMenuWin || trayMenuWin.isDestroyed() || !trayMenuWin.isVisible()) return;
    const b = trayMenuWin.getBounds();
    const nh = Math.max(80, Math.min(600, Math.round(Number(h) || b.height)));
    if (Math.abs(b.height - nh) < 2) return;
    const wa = screen.getDisplayMatching(b).workArea;
    const y = Math.min(b.y, wa.y + wa.height - nh - 4);
    trayMenuWin.setBounds({ x: b.x, y, width: b.width, height: nh });
  });
  ipcMain.on('tray:hide', () => hideTrayMenu());
}

/* ---------------- 首启曲库 ---------------- */

function loadSeed() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ASSETS, 'seed-library.json'), 'utf8'));
    return j.albums || [];
  } catch (_) {
    // 兜底：截图里那张专辑
    const txt = `On The Road(Demo1)00:00\n我要的幸福01:25\n坏天气05:01\n零缺点09:32\n开始懂了13:12\n中间地带17:44\n相信22:15\n累赘26:46\n难得一见30:01\n害怕34:14\n星期一天气晴我离开你38:17\nOn The Road(Demo2)42:37`;
    return [{
      id: 'seed_fallback', title: '孙燕姿 2000《我要的幸福》', bvid: 'BV1Tw411G74d', aid: 325370829,
      duration: 2630, tracks: bili.parseTimestamps(txt, 2630), tracksOk: true
    }];
  }
}

/* ---------------- 启动 ---------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
  app.setAppUserModelId('com.albumdeck.app');
  app.whenReady().then(() => {
    store = new Store(app.getPath('userData'));
    // 自检用不存在的端口，避免误连并打断用户正在播放的浏览器
    if (SELF_TEST) store.patchSettings({ port: 9339 });
    cdp = new CdpController(settings().port || 9222);
    cdp.prefer360p = settings().prefer360p !== false;
    if (!store.albums.length) {
      store.albums = loadSeed();
      store.patch({ current: { albumId: store.albums[0] ? store.albums[0].id : null, trackIndex: 0 } });
    }
    rebuildQueue();   // 初始化播放队列
    // 打包验证：只加载隐藏主页面，使用隔离曲库，不连接真实浏览器或注册全局快捷键。
    if (PACK_CHECK) {
      registerIpc();
      const checkWindow = new BrowserWindow({ show: false, webPreferences: {
        preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false
      } });
      checkWindow.loadFile(path.join(__dirname, 'index.html')).then(async () => {
        const state = await checkWindow.webContents.executeJavaScript('window.deck.state()');
        let rows = 0;
        for (let i = 0; i < 30; i++) {
          rows = await checkWindow.webContents.executeJavaScript('document.querySelectorAll("#albumList .album-item").length');
          if (rows === state.albums.length && rows > 0) break;
          await sleep(100);
        }
        if (!state.albums.length || rows !== state.albums.length) throw new Error('主页面未正常渲染曲库');
        const settingsUi = await checkWindow.webContents.executeJavaScript(`(() => {
          document.querySelector('#btnSettings').click();
          return { opened: document.querySelector('#settingsModal').classList.contains('show'),
            obsolete: !!document.querySelector('#sAutoPlay'), prefer360p: document.querySelector('#sPrefer360p').checked };
        })()`);
        if (!settingsUi.opened || settingsUi.obsolete || !settingsUi.prefer360p) throw new Error('设置页面或默认播放开关状态不正确');
        console.log('PACK_CHECK_OK', JSON.stringify({ version: app.getVersion(), albums: state.albums.length, rows }));
        app.exit(0);
      }).catch(error => { console.error('PACK_CHECK_FAILED', error); app.exit(1); });
      return;
    }
    conn.port = settings().port || 9222;
    registerIpc();
    createMain();
    if (settings().miniVisible) createMini();
    createTray();
    registerHotkeys();
    startPolling();
    // 启动时尝试连接已在运行的调试浏览器
    cdp.version().then(v => { if (v) ensureConnection().catch(() => {}); }).catch(() => {});
    setTimeout(() => broadcast(), 800);

    // 开发自检：--deck-shot 会截取两个窗口后退出
    // 开发自检：--deck-e2e 连接已运行的调试浏览器并执行一次真实切歌
    if (process.argv.includes('--deck-e2e')) {
      setTimeout(async () => {
        const log = [];
        try {
          await ensureConnection();
          log.push('connected: ' + conn.browser);
          const a = albums()[0];
          log.push('album: ' + (a && a.title));
          await playAt(a.id, 2);                       // 第 3 首 = 坏天气 05:01
          await sleep(1800);
          log.push('cdp state: ' + JSON.stringify(await cdp.state()));
          log.push('current: ' + JSON.stringify(store.current));
          const b = albums()[1];
          if (b) {
            log.push('switch album -> ' + b.bvid + ' ' + b.title);
            await playAt(b.id, 0);
            await sleep(2000);
            log.push('after switch: ' + JSON.stringify(await cdp.state()));
            log.push('current2: ' + JSON.stringify(store.current));
          }
          log.push('hotkeyErrors: ' + JSON.stringify(hotkeyErrors));
        } catch (e) { log.push('ERR: ' + (e && e.message)); }
        fs.writeFileSync(path.join(__dirname, '..', 'tools', 'e2e.log'), log.join('\n'), 'utf8');
        app.exit(0);
      }, 1200);
    }

    if (process.argv.includes('--deck-shot')) {
      setTimeout(async () => {
        try {
          /* 复现：把真实曲库放进隔离目录，看主进程 snapshot / 渲染进程拿到的 state 有没有报错 */
          if (process.argv.includes('--deck-repro')) {
            const out = {};
            if (mainWin.webContents.isLoading()) await new Promise(r => mainWin.webContents.once('did-finish-load', r));
            try {
              const s = snapshot();
              out.snapshotAlbums = s.albums.length;
              out.snapshotQueue = { len: (s.queue.items || []).length, source: s.queue.source };
              out.snapshotPlaying = { album: s.playing && s.playing.album && s.playing.album.id, ext: !!(s.playing && s.playing.external) };
            } catch (e) { out.snapshotError = String((e && e.stack) || e); }
            try {
              out.renderer = await mainWin.webContents.executeJavaScript(
                `window.deck.state().then(s => ({ ok: true, albums: s.albums.length })).catch(e => ({ ok: false, err: String((e && e.message) || e) }))`);
            } catch (e) { out.rendererError = String((e && e.message) || e); }
            out.domAlbums = await mainWin.webContents.executeJavaScript(`document.querySelectorAll('#albumList .album-item').length`);
            out.domCount = await mainWin.webContents.executeJavaScript(`document.querySelector('#albumCount').textContent`);
            out.stateGot = await mainWin.webContents.executeJavaScript('window.__stateGot || 0');
            out.renderErr = await mainWin.webContents.executeJavaScript('window.__renderErr || ""');
            out.loadErr = await mainWin.webContents.executeJavaScript('window.__loadErr || ""');
            console.log('REPRO:', JSON.stringify(out));
            setTimeout(() => { quitting = true; app.quit(); }, 300);
            return;
          }
          if (process.argv.includes('--deck-fav')) {
            const script = `(async () => {
              const s = await window.deck.state();
              const a = s.albums[0], t = a.tracks[1];
              const song = { kind:'song', bvid:a.bvid, start:t.start, name:t.name, albumTitle:a.title,
                             albumId:a.id, trackIndex:1, duration:t.end - t.start };
              const r1 = await window.deck.favLike(song);
              const f = await window.deck.favCreate({ name:'深夜循环', type:'album' });
              const r2 = await window.deck.favAdd(f.id, { kind:'album', bvid:a.bvid, title:a.title, albumId:a.id, duration:a.duration });
              const n1 = await window.deck.addTrack({ albumId:a.id, name:'测试单曲', start:'07:10' });
              const sMid = await window.deck.state();
              const testIdx = sMid.albums[0].tracks.findIndex(t => t.name === '测试单曲');
              const n2 = await window.deck.removeTrack({ albumId:a.id, index:testIdx });
              const s2 = await window.deck.state();
              document.querySelector('.side-tab[data-view=folder]').click();
              return { liked:r1, folder:f, added:r2, afterAddTrack:n1, afterRemoveTrack:n2,
                       folders:s2.folders.map(x=>({name:x.name,type:x.type,count:x.items.length})),
                       firstAlbumTracks:s2.albums[0].tracks.length };
            })()`;
            const res = await mainWin.webContents.executeJavaScript(script);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'fav-test.json'), JSON.stringify(res, null, 2), 'utf8');
            console.log('FAV TEST OK');
          }
          /* 「导入到收藏夹」全链路：解析链接 → 勾选 → 选夹子 → 导入 → 收藏夹里真的有曲目 */
          if (process.argv.includes('--deck-imptest')) {
            const script = `(async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const q = s => document.querySelector(s);
              const out = {};
              q('#btnImport').click();
              await wait(400);
              document.querySelector('.tab[data-tab="link"]').click();
              await wait(200);
              out.btnDisabledAtStart = q('#btnBuildFav').disabled;
              q('#linkInput').value = 'https://www.bilibili.com/video/BV1Tw411G74d/';
              q('#btnResolve').click();
              for (let i = 0; i < 120 && q('#btnBuildFav').disabled; i++) await wait(200);
              out.candidates = q('#candCount').textContent;
              out.btnEnabled = !q('#btnBuildFav').disabled;

              q('#btnBuildFav').click();
              await wait(500);
              out.pickerShown = q('#popMenu').classList.contains('show');
              out.pickerItems = [...document.querySelectorAll('#popMenu [data-imp-fid]')].map(b => b.textContent.replace(/\\s+/g, ' ').trim());
              out.hasNewBtn = !!q('#popMenu [data-imp-new]');

              const first = q('#popMenu [data-imp-fid]');
              const folderName = first ? first.textContent.trim() : '';
              if (first) first.click();
              for (let i = 0; i < 200; i++) {
                await wait(300);
                const t = q('#importProgress').textContent || '';
                if (t.includes('完成')) break;
              }
              out.progress = (q('#importProgress').textContent || '').replace(/\\s+/g, ' ').trim();
              const s = await window.deck.state();
              const f = s.folders.find(x => folderName.includes(x.name)) || s.folders[0];
              out.folder = { name: f ? f.name : '', count: f ? f.items.length : -1 };
              out.sampleItem = f && f.items[0] ? { name: f.items[0].name, start: f.items[0].start, albumId: !!f.items[0].albumId } : null;
              out.albumInLibrary = s.albums.some(a => a.bvid === 'BV1Tw411G74d');

              /* 第二阶段：新建收藏夹并导入（候选和勾选还在，重开导入面板即可） */
              await wait(1200);
              q('#btnImport').click();
              await wait(400);
              document.querySelector('.tab[data-tab="link"]').click();
              await wait(200);
              q('#importProgress').innerHTML = '';
              q('#btnBuildFav').click();
              await wait(400);
              out.newBtnInPicker = !!q('#popMenu [data-imp-new]');
              q('#popMenu [data-imp-new]').click();
              await wait(400);
              out.folderModalShown = q('#folderModal').classList.contains('show');
              q('#fName').value = '导入测试夹';
              q('#btnSaveFolder').click();
              for (let i = 0; i < 200; i++) {
                await wait(300);
                if ((q('#importProgress').textContent || '').includes('完成')) break;
              }
              out.progress2 = (q('#importProgress').textContent || '').replace(/\\s+/g, ' ').trim();
              const s2 = await window.deck.state();
              const f2 = s2.folders.find(x => x.name === '导入测试夹');
              out.newFolder = { exists: !!f2, count: f2 ? f2.items.length : -1 };
              out.folderModalClosed = !q('#folderModal').classList.contains('show');
              return out;
            })()`;
            const res = await mainWin.webContents.executeJavaScript(script);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'import-test.json'), JSON.stringify(res, null, 2), 'utf8');
            console.log('IMPORT TEST:', JSON.stringify(res));
            if (!process.argv.includes('--deck-minitest')) {
              setTimeout(() => { quitting = true; app.quit(); }, 300);
              return;
            }
            await mainWin.webContents.executeJavaScript(`document.querySelector('#importModal').classList.remove('show')`);
          }
          /* 关掉「点击专辑直接播放」后：点专辑只切视图、不动浏览器，点播放才开播 */
          if (process.argv.includes('--deck-selecttest')) {
            const script = `(async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const q = s => document.querySelector(s);
              const out = {};
              await window.deck.setSettings({ albumClickPlay: false });
              await window.deck.setPlayMode('album-loop');
              await wait(400);
              const q0 = (await window.deck.state()).queue.items[0];
              out.queueAlbumBefore = q0 && q0.albumId;
              const st0 = await window.deck.state();
              const target = st0.albums.find(a => a.id !== st0.current.albumId) || st0.albums[0];
              const row = [...document.querySelectorAll('#albumList .album-item')].find(el => el.dataset.id === target.id);
              out.target = target.title;
              out.rowFound = !!row;
              out.bvidBefore = st0.playback.bvid;
              row.click();
              await wait(700);
              const st1 = await window.deck.state();
              out.currentAfter = st1.current.albumId === target.id;
              out.trackIndex = st1.current.trackIndex;
              out.message = st1.message;
              out.paused = st1.playback.paused;
              out.t = st1.playback.t;
              out.bvidAfter = st1.playback.bvid;
              out.listTitle = q('#listTitle').textContent;
              out.trackRows = document.querySelectorAll('#trackList .track-row').length;
              out.playIconPaused = q('#playIcon').innerHTML.includes('M8 5l11 7');
              const q1 = st1.queue.items[0];
              out.queueAlbumAfter = q1 && q1.albumId;
              out.queueStaysPlaying = out.queueAlbumBefore === out.queueAlbumAfter;
              await window.deck.setSettings({ albumClickPlay: true });
              return out;
            })()`;
            const res = await mainWin.webContents.executeJavaScript(script);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'select-test.json'), JSON.stringify(res, null, 2), 'utf8');
            console.log('SELECT TEST:', JSON.stringify(res));
            if (!process.argv.includes('--deck-minitest') && !process.argv.includes('--deck-imptest')) {
              setTimeout(() => { quitting = true; app.quit(); }, 300);
              return;
            }
          }
          /* 收藏夹里「已不在曲库」的项：右键看来源 + 重新导入并重新接上 */
          if (process.argv.includes('--deck-losttest')) {
            const script = `(async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const q = s => document.querySelector(s);
              const out = {};
              const st = await window.deck.state();
              const a = st.albums[0], t = a.tracks[0];
              const f = await window.deck.favCreate({ name: '找回测试', type: 'song' });
              await window.deck.favAdd(f.id, { kind: 'song', bvid: a.bvid, start: t.start, name: t.name,
                albumTitle: a.title, albumId: a.id, trackIndex: 0, duration: Math.max(0, (t.end || 0) - t.start) });
              await window.deck.deleteAlbum(a.id);
              await wait(500);
              out.albumGone = !(await window.deck.state()).albums.some(x => x.bvid === a.bvid);

              document.querySelector('.side-tab[data-view=folder]').click();
              await wait(400);
              const fi = [...document.querySelectorAll('#albumList [data-fid]')].find(el => el.dataset.fid === f.id);
              if (fi) fi.click();
              await wait(500);
              const row = q('#trackList .track-row[data-fkey]');
              out.rowFound = !!row;
              out.badge = !!(row && row.querySelector('.fav-badge'));
              if (row) row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 400 }));
              await wait(400);
              out.menuShown = q('#popMenu').classList.contains('show');
              out.menuText = (q('#popMenu').textContent || '').replace(/\\s+/g, ' ').trim();
              out.hasSource = !!q('#popMenu [data-fsrc=open]');
              out.hasReimport = !!q('#popMenu [data-fsrc=reimport]');
              if (q('#popMenu [data-fsrc=reimport]')) q('#popMenu [data-fsrc=reimport]').click();
              for (let i = 0; i < 120; i++) {
                await wait(500);
                if ((await window.deck.state()).albums.some(x => x.bvid === a.bvid)) break;
              }
              const s2 = await window.deck.state();
              out.albumBack = s2.albums.some(x => x.bvid === a.bvid);
              const f2 = s2.folders.find(x => x.name === '找回测试');
              const it = f2 && f2.items[0];
              out.item = it ? { albumId: it.albumId, trackIndex: it.trackIndex, name: it.name } : null;
              out.itemLinked = !!(it && s2.albums.some(x => x.id === it.albumId));
              await wait(700);
              out.badgeAfter = !!document.querySelector('#trackList .fav-badge');

              /* 资料库里的专辑行 / 曲目行也能右键看来源 */
              document.querySelector('.side-tab[data-view=library]').click();
              await wait(400);
              const albRow = document.querySelector('#albumList .album-item');
              if (albRow) albRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
              await wait(300);
              out.libAlbumMenu = q('#popMenu').classList.contains('show');
              out.libAlbumText = (q('#popMenu').textContent || '').replace(/\\s+/g, ' ').trim();
              out.libAlbumHasReimport = !!q('#popMenu [data-fsrc=reimport]');
              const trRow = document.querySelector('#trackList .track-row');
              if (trRow) trRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 400 }));
              await wait(300);
              out.libTrackMenu = q('#popMenu').classList.contains('show');
              out.libTrackText = (q('#popMenu').textContent || '').replace(/\\s+/g, ' ').trim();
              return out;
            })()`;
            const res = await mainWin.webContents.executeJavaScript(script);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'lost-test.json'), JSON.stringify(res, null, 2), 'utf8');
            console.log('LOST TEST:', JSON.stringify(res));
            if (!process.argv.includes('--deck-minitest') && !process.argv.includes('--deck-imptest')) {
              setTimeout(() => { quitting = true; app.quit(); }, 300);
              return;
            }
          }
          /* 专辑排序：右键按钮弹出「按歌名 / 时间 / 歌手」 */
          if (process.argv.includes('--deck-sorttest')) {
            const script = `(async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const q = s => document.querySelector(s);
              const out = {};
              const titles = async () => (await window.deck.state()).albums.map(a => a.title);
              const yearOf = t => { const m = String(t).match(/(?:19|20)\\d{2}/); return m ? Number(m[0]) : 9999; };

              out.before = await titles();
              const btn = q('#btnSortAlbums');
              out.btnVisible = !!btn && !btn.hidden;
              if (btn) btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 60 }));
              await wait(300);
              out.menuShown = q('#popMenu').classList.contains('show');
              out.menuItems = [...document.querySelectorAll('#popMenu [data-sortalb]')].map(b => b.dataset.sortalb);

              q('#popMenu [data-sortalb=year]').click();
              await wait(700);
              out.byYear = await titles();
              out.byYearAsc = out.byYear.every((t, i) => i === 0 || yearOf(out.byYear[i - 1]) <= yearOf(t));

              await window.deck.sortAlbums('name');
              await wait(600);
              out.byName = await titles();
              out.sameSet = out.byName.slice().sort().join('|') === out.before.slice().sort().join('|');
              out.nameChanged = out.byName.join('|') !== out.before.join('|');

              await window.deck.sortAlbums('artist');
              await wait(600);
              out.byArtist = await titles();
              out.rows = document.querySelectorAll('#albumList .album-item').length;
              out.noScale = !document.querySelector('#albumScale');
              return out;
            })()`;
            const res = await mainWin.webContents.executeJavaScript(script);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'sort-test.json'), JSON.stringify(res, null, 2), 'utf8');
            console.log('SORT TEST:', JSON.stringify(res));
            if (!process.argv.includes('--deck-minitest') && !process.argv.includes('--deck-imptest')) {
              setTimeout(() => { quitting = true; app.quit(); }, 300);
              return;
            }
          }
          /* 全专循环：最后一张专辑的最后一首放完 → 回到第一张第一首 */
          if (process.argv.includes('--deck-looptest')) {
            const script = `(async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const out = {};
              await window.deck.setPlayMode('all-loop');
              await wait(500);
              const st = await window.deck.state();
              const last = st.albums[st.albums.length - 1];
              out.albumCount = st.albums.length;
              out.firstAlbum = st.albums[0].title;
              out.lastAlbum = last.title;
              await window.deck.playAt(last.id, (last.tracks || []).length - 1);
              await wait(800);
              const b = await window.deck.state();
              out.atLast = { album: b.current.albumId === last.id, trackIndex: b.current.trackIndex, queuePos: b.queue.pos, queueLen: b.queue.items.length };
              await window.deck.next();
              await wait(900);
              const a = await window.deck.state();
              out.after = { albumId: a.current.albumId, trackIndex: a.current.trackIndex, queuePos: a.queue.pos };
              out.wrapped = a.current.albumId === st.albums[0].id && a.current.trackIndex === 0;
              // 恢复示例曲库 → 应该只有两张
              await window.deck.resetSeed();
              await wait(600);
              const sr = await window.deck.state();
              out.seedAlbums = sr.albums.map(x => x.title);
              out.seedCount = sr.albums.length;
              return out;
            })()`;
            const res = await mainWin.webContents.executeJavaScript(script);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'loop-test.json'), JSON.stringify(res, null, 2), 'utf8');
            console.log('LOOP TEST:', JSON.stringify(res));
            if (!process.argv.includes('--deck-minitest') && !process.argv.includes('--deck-imptest')) {
              setTimeout(() => { quitting = true; app.quit(); }, 300);
              return;
            }
          }
          /* 收藏夹队列：点收藏夹里的歌 → 播放列表只剩这个收藏夹的曲目 */
          if (process.argv.includes('--deck-fqtest')) {
            const script = `(async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const out = {};
              await window.deck.setPlayMode('all-loop');
              await wait(400);
              let st = await window.deck.state();
              const A = st.albums[0], B = st.albums[st.albums.length - 1];
              const f = await window.deck.favCreate({ name: '队列测试夹', type: 'song' });
              const mk = (a, i) => ({ kind: 'song', bvid: a.bvid, start: a.tracks[i].start, name: a.tracks[i].name,
                albumTitle: a.title, albumId: a.id, trackIndex: i, duration: 60 });
              await window.deck.favAdd(f.id, mk(A, 2));
              await window.deck.favAdd(f.id, mk(A, 5));
              await window.deck.favAdd(f.id, mk(B, 0));
              await wait(300);
              st = await window.deck.state();
              out.folderItems = (st.folders.find(x => x.id === f.id) || {}).items.length;
              await window.deck.playFolder(f.id, mk(A, 5));
              await wait(900);
              st = await window.deck.state();
              out.queueLen = st.queue.items.length;
              out.sourceName = st.queue.source && st.queue.source.name;
              out.pos = st.queue.pos;
              out.playingTrack = st.playing && st.playing.track && st.playing.track.name;
              const last = st.queue.items[st.queue.items.length - 1];
              await window.deck.playAt(last.albumId, last.trackIndex);
              await wait(700);
              await window.deck.next();
              await wait(900);
              st = await window.deck.state();
              out.wrapPos = st.queue.pos;
              out.wrapSourceKept = !!(st.queue.source);
              const other = st.albums.find(a => a.id !== last.albumId) || st.albums[0];
              await window.deck.playAt(other.id, 1);
              await wait(900);
              st = await window.deck.state();
              out.sourceCleared = !st.queue.source;
              out.libraryQueueLen = st.queue.items.length;
              // 专辑收藏夹：点专辑展开曲目 → 子曲目可播放 / 隐藏，队列 = 这个收藏夹的专辑的歌
              const af = await window.deck.favCreate({ name: '专辑测试夹', type: 'album' });
              await window.deck.favAdd(af.id, { kind: 'album', bvid: A.bvid, title: A.title, albumId: A.id, duration: A.duration || 0 });
              await wait(500);
              const tab = document.querySelector('.side-tab[data-view="folder"]');
              if (tab) tab.click();
              await wait(400);
              const fi = document.querySelector('.folder-item[data-fid="' + af.id + '"]');
              if (fi) fi.click();
              await wait(500);
              out.albumFolderRows = document.querySelectorAll('#trackList .track-row').length;
              document.querySelector('#trackList .track-row').click();
              await wait(500);
              out.albumFolderSubRows = document.querySelectorAll('#trackList .fav-sub-track').length;
              out.arrowOpen = !!document.querySelector('.row-btn.fav-arrow.open');
              const subs = document.querySelectorAll('#trackList .fav-sub-track');
              if (subs[2]) subs[2].click();
              await wait(1000);
              st = await window.deck.state();
              out.albumFolderQueue = st.queue.items.length;
              out.albumFolderSource = st.queue.source && st.queue.source.name;
              out.albumFolderPos = st.queue.pos;
              out.albumFolderTrack = st.playing && st.playing.track && st.playing.track.name;
              const hBefore = (st.albums.find(a => a.id === A.id).tracks || []).filter(t => t.hidden).length;
              const hideBtn = document.querySelector('#trackList .fav-sub-track [data-fat-hide]');
              if (hideBtn) hideBtn.click();
              await wait(700);
              st = await window.deck.state();
              out.hiddenSynced = (st.albums.find(a => a.id === A.id).tracks || []).filter(t => t.hidden).length === hBefore + 1;
              return out;
            })()`;
            const res = await mainWin.webContents.executeJavaScript(script);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'fq-test.json'), JSON.stringify(res, null, 2), 'utf8');
            console.log('FOLDER QUEUE TEST:', JSON.stringify(res));
            setTimeout(() => { quitting = true; app.quit(); }, 300);
            return;
          }
          /* 开启/关闭悬浮窗：藏起来（隐藏或收到边缘）→ 唤出并回正常位置；正常显示 → 关闭 */
          if (process.argv.includes('--deck-summontest')) {
            const out = {};
            if (!miniWin.isVisible()) miniWin.showInactive();
            await sleep(400);
            store.data.miniBounds = { x: 900, y: 480 };
            const home = miniHomeBounds();
            miniWin.setBounds(home);
            await sleep(300);
            out.home = { x: home.x, y: home.y };
            // 收起到左边（等价于「贴边隐藏」）
            collapseMini('left', true);
            await sleep(300);
            out.collapsed = { collapsed: miniCollapsed, visible: miniWin.isVisible(), x: miniWin.getBounds().x };
            // 快捷键 / 托盘：唤出并回到正常位置
            toggleMini();
            await sleep(400);
            const b1 = miniWin.getBounds();
            out.summoned = {
              visible: miniWin.isVisible(), collapsed: miniCollapsed,
              atHome: b1.x === home.x && b1.y === home.y, x: b1.x, y: b1.y
            };
            // 再按一次：关闭
            toggleMini();
            await sleep(300);
            out.closed = { visible: miniWin.isVisible(), miniVisible: settings().miniVisible };
            // 再按一次：重新唤出，位置仍是正常位置
            toggleMini();
            await sleep(400);
            const b2 = miniWin.getBounds();
            out.reopened = { visible: miniWin.isVisible(), atHome: b2.x === home.x && b2.y === home.y, collapsed: miniCollapsed };
            // 露出宽度：设成 10px 后收起，右侧只留 10px
            const waB = screen.getDisplayMatching(home).workArea;
            store.patchSettings({ miniPeek: 10 });
            collapseMini('right', true);
            await sleep(300);
            const px = miniWin.getBounds().x;
            // 高 DPI 下 setBounds 会因物理像素取整差 1px，允许 ±2
            out.peek10 = { x: px, right: waB.x + waB.width, ok: Math.abs(px - (waB.x + waB.width - 10)) <= 2 };
            // 收起状态下唤出，也要回到正常位置
            toggleMini();
            await sleep(400);
            const b3 = miniWin.getBounds();
            out.summonFromCollapsed = { atHome: b3.x === home.x && b3.y === home.y, collapsed: miniCollapsed };
            // 隐藏期间不发送全量状态，恢复显示时仍须显示最新曲库。
            mainWin.hide(); miniWin.hide();
            const track = currentTrack(), oldName = track.name;
            track.name = '隐藏后更新的曲目'; store.save(); broadcast();
            await sleep(100);
            showMain(); summonMini(); await sleep(300);
            out.restoredState = {
              main: await mainWin.webContents.executeJavaScript("document.querySelector('#nowTrack').textContent"),
              mini: await miniWin.webContents.executeJavaScript("document.querySelector('#mName').textContent")
            };
            if (out.restoredState.main !== track.name || out.restoredState.mini !== track.name) throw new Error('隐藏窗口恢复后状态未更新');
            track.name = oldName; store.save(); broadcast();
            console.log('SUMMON TEST:', JSON.stringify(out));
            setTimeout(() => { quitting = true; app.quit(); }, 300);
            return;
          }
          if (miniWin && !miniWin.isVisible()) miniWin.showInactive();
          broadcast();
          await sleep(600);
          if (process.argv.includes('--deck-minitest')) {
            if (miniWin.webContents.isLoading()) await new Promise(r => miniWin.webContents.once('did-finish-load', r));
            const out = {};
            const inWin = (w, code) => w.webContents.executeJavaScript(code);
            const popVisible = () => !!(miniPopWin && !miniPopWin.isDestroyed() && miniPopWin.isVisible());
            const popRect = () => (popVisible() ? miniPopWin.getBounds() : null);
            /** 轮询等待弹窗出现 / 消失，返回耗时（ms），超时 -1 */
            const waitPop = async (want, ms = 6000) => {
              const t0 = Date.now();
              while (Date.now() - t0 < ms) {
                if (popVisible() === want) return Date.now() - t0;
                await sleep(80);
              }
              return -1;
            };
            const card0 = miniWin.getBounds();
            out.card0 = { x: card0.x, y: card0.y, w: card0.width, h: card0.height };

            /* 1) 卡片：控制行左对齐 + ☆ 在 ♡ 右边 */
            out.layout = await inWin(miniWin, `(() => {
              const row = document.querySelector('.m-controls'), heart = document.querySelector('#mHeart'),
                    fav = document.querySelector('#mFav'), bar = document.querySelector('.m-bar');
              const rh = heart.getBoundingClientRect(), rf = fav.getBoundingClientRect();
              return { justify: getComputedStyle(row).justifyContent,
                rowLeft: Math.round(row.getBoundingClientRect().left),
                barLeft: Math.round(bar.getBoundingClientRect().left),
                favRightOfHeart: rf.left >= rh.right - 1,
                fits: row.scrollWidth <= row.clientWidth + 1,
                buttons: row.querySelectorAll('button').length };
            })()`);

            /* 2) ☰ 播放列表：弹出独立小窗，卡片尺寸不变 */
            await inWin(miniWin, `document.querySelector('#mQueue').click()`);
            out.queue = { openMs: await waitPop(true) };
            await sleep(300);
            out.queue.visible = popVisible();
            out.queue.pop = popRect();
            out.queue.card = miniWin.getBounds();
            out.queue.dom = await inWin(miniPopWin, `(() => {
              const box = document.querySelector('#ppBody'), g = document.querySelector('.pg.current');
              return { title: document.querySelector('#ppTitle').textContent,
                groups: document.querySelectorAll('.pg').length,
                open: document.querySelectorAll('.pg.open').length,
                tracks: document.querySelectorAll('.pt').length,
                current: !!g,
                currentTop: g ? Math.round(g.getBoundingClientRect().top - box.getBoundingClientRect().top) : null,
                scrollTop: Math.round(box.scrollTop) };
            })()`);
            await inWin(miniPopWin, `(() => { const t = document.querySelectorAll('.pt')[1]; if (t) t.click(); return true; })()`);
            out.queue.closedMs = await waitPop(false);

            /* 3) ☆ 收藏：弹出收藏夹列表，点一次加入、再点一次取消 */
            const cnt0 = folders()[0] ? folders()[0].items.length : 0;
            await inWin(miniWin, `document.querySelector('#mFav').click()`);
            out.fav = { openMs: await waitPop(true) };
            await sleep(300);
            out.fav.visible = popVisible();
            out.fav.pop = popRect();
            out.fav.dom = await inWin(miniPopWin, `(() => ({
              title: document.querySelector('#ppTitle').textContent,
              folders: document.querySelectorAll('[data-fid]').length,
              hasNew: !!document.querySelector('[data-newfav]'),
              onCount: document.querySelectorAll('[data-fid].on').length }))()`);
            await inWin(miniPopWin, `(() => { const f = document.querySelector('[data-fid]'); if (f) f.click(); return true; })()`);
            await waitPop(false);
            out.fav.countAfterAdd = folders()[0] ? folders()[0].items.length : 0;

            // 再打开：该项应已点亮（任意收藏夹都算），点它应取消
            await inWin(miniWin, `document.querySelector('#mFav').click()`);
            await waitPop(true);
            await sleep(300);
            out.fav.onAfterAdd = await inWin(miniPopWin, `!!document.querySelector('[data-fid].on')`);
            out.fav.iconOn = await inWin(miniWin, `document.querySelector('#mFav').classList.contains('on')`);
            await inWin(miniPopWin, `(() => { const f = document.querySelector('[data-fid].on') || document.querySelector('[data-fid]'); if (f) f.click(); return true; })()`);
            await waitPop(false);
            out.fav.countAfterRemove = folders()[0] ? folders()[0].items.length : 0;
            out.fav.removed = out.fav.countAfterRemove === cnt0;

            /* 4) 右键播放顺序：弹出全部方式 */
            await inWin(miniWin, `document.querySelector('#mMode').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
            out.mode = { openMs: await waitPop(true) };
            await sleep(300);
            out.mode.pop = popRect();
            out.mode.cardW = card0.width;
            out.mode.dom = await inWin(miniPopWin, `(() => ({
              count: document.querySelectorAll('[data-mode]').length,
              current: document.querySelectorAll('.pi.on').length }))()`);
            await inWin(miniPopWin, `(() => { const m = [...document.querySelectorAll('[data-mode]')].find(x => !x.classList.contains('on')); if (m) m.click(); return true; })()`);
            await waitPop(false);
            out.mode.applied = settings().playMode;

            /* 5) 卡片挪到屏幕上方 → 弹窗改在卡片下方 */
            miniWin.setBounds({ x: 60, y: 60, width: card0.width, height: card0.height });
            await sleep(500);
            await inWin(miniWin, `document.querySelector('#mQueue').click()`);
            await waitPop(true);
            await sleep(300);
            const pb = popRect(), cb = miniWin.getBounds();
            out.below = { pop: pb, card: cb, below: !!pb && pb.y >= cb.y + cb.height };
            await inWin(miniPopWin, `document.querySelector('#ppClose').click()`);
            out.below.closedMs = await waitPop(false);

            out.log = miniPopLog.slice();
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'mini-test.json'), JSON.stringify(out, null, 2), 'utf8');
            console.log('MINI TEST:', JSON.stringify(out));
            setTimeout(() => { quitting = true; app.quit(); }, 300);
            return;
          }
          fs.writeFileSync(path.join(__dirname, '..', 'tools', 'shot.png'), (await mainWin.capturePage()).toPNG());
          if (process.argv.includes('--deck-jumptest')) {
            await sleep(400);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'shot-jump.png'), (await mainWin.capturePage()).toPNG());
          }
          if (miniWin && !miniWin.isDestroyed()) {
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'shot-mini.png'), (await miniWin.capturePage()).toPNG());
          }
          if (process.argv.includes('--deck-modetest')) {
            const script = `(async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const out = {};
              const st = await window.deck.state();
              const a0 = st.albums[0];
              const totalTracks = st.albums.reduce((n, a) => n + (a.tracks || []).length, 0);
              await window.deck.playAt(a0.id, 0);
              await wait(400);
              const qinfo = async () => {
                const s = await window.deck.state();
                return {
                  mode: s.queue.mode, len: s.queue.items.length, pos: s.queue.pos,
                  albumCount: new Set(s.queue.items.map(i => i.albumId)).size,
                  first3: s.queue.items.slice(0, 3).map(i => i.albumId.slice(-4) + ':' + i.trackIndex),
                  current: s.current.albumId.slice(-4) + ':' + s.current.trackIndex
                };
              };
              for (const m of ['one', 'album-loop', 'album-shuffle', 'all-loop', 'album-random', 'song-shuffle']) {
                await window.deck.setPlayMode(m);
                await wait(400);
                out[m] = await qinfo();
              }
              out.meta = { album0: a0.id.slice(-4), album0Tracks: (a0.tracks || []).length, totalTracks, albums: st.albums.length };

              document.querySelector('#btnQueue').click();
              await wait(500);
              out.ui = {
                panelShown: document.querySelector('#queuePanel').classList.contains('show'),
                groups: document.querySelectorAll('#qpList .qp-group').length,
                openGroups: document.querySelectorAll('#qpList .qp-group.open').length,
                tracks: document.querySelectorAll('#qpList .qp-track').length,
                modeText: document.querySelector('#qpMode').textContent,
                btnText: document.querySelector('#btnPlayMode').textContent.trim()
              };
              const curGroup = document.querySelector('#qpList .qp-group.current');
              out.ui.currentGroup = !!curGroup;
              if (curGroup) {
                const titleEl = curGroup.querySelector('.qp-title');
                out.ui.colorOpen = getComputedStyle(titleEl).color;
                curGroup.querySelector('.qp-album').click();
                await wait(250);
                out.ui.foldedOpen = curGroup.classList.contains('open');
                out.ui.foldedCurrent = curGroup.classList.contains('current');
                out.ui.colorFolded = getComputedStyle(titleEl).color;
                out.ui.bgFolded = getComputedStyle(curGroup.querySelector('.qp-album')).backgroundColor;
              }
              out.ui.afterCollapse = document.querySelectorAll('#qpList .qp-group.open').length;
              document.querySelector('#btnPlayMode').click();
              await wait(500);
              const s3 = await window.deck.state();
              out.ui.afterModeClick = s3.settings.playMode;
              return out;
            })()`;
            const res = await mainWin.webContents.executeJavaScript(script);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'mode-test.json'), JSON.stringify(res, null, 2), 'utf8');
            console.log('MODE TEST', JSON.stringify(res));
            // 切回默认的全专循环，展示完整播放列表后截图
            await mainWin.webContents.executeJavaScript("window.deck.setPlayMode('all-loop')");
            await sleep(500);
            await mainWin.webContents.executeJavaScript("document.querySelector('#queuePanel').classList.add('show')");
            mainWin.show(); mainWin.focus();
            await sleep(900);
            await mainWin.webContents.capturePage();
            await sleep(400);
            await mainWin.webContents.capturePage();
            await sleep(400);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'shot-queue.png'), (await mainWin.webContents.capturePage()).toPNG());
          }
          if (process.argv.includes('--deck-uitest')) {
            const res = {};
            res.main = await mainWin.webContents.executeJavaScript(`(async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const hasBtn = !!document.querySelector('#btnMiniMenu');
              const s = await window.deck.state();
              const a = s.current.album;
              await window.deck.toggleTrackHidden(a.id, 2);
              await wait(500);
              const row = document.querySelector('#trackList .track-row[data-i="2"]');
              const btn = row && row.querySelector('[data-hide-index]');
              const cs = row ? getComputedStyle(row.querySelector('.track-name')) : null;
              const info = {
                hasClass: !!(row && row.classList.contains('hidden-track')),
                btn: btn ? btn.textContent.trim() : '',
                decoration: cs ? cs.textDecorationLine : '',
                opacity: row ? getComputedStyle(row).opacity : ''
              };
              await window.deck.toggleTrackHidden(a.id, 2);
              await wait(400);
              const back = document.querySelector('#trackList .track-row[data-i="2"]');
              const restored = !!(back && !back.classList.contains('hidden-track'));

              // 跳过开关：开 → 从 1 到 3；关 → 从 1 到 2
              await window.deck.toggleTrackHidden(a.id, 2);
              await window.deck.playAt(a.id, 1);
              await wait(400);
              await window.deck.next();
              await wait(600);
              const skippedTo = (await window.deck.state()).current.trackIndex;
              await window.deck.setSettings({ skipHidden: false });
              await window.deck.playAt(a.id, 1);
              await wait(400);
              await window.deck.next();
              await wait(600);
              const noSkipTo = (await window.deck.state()).current.trackIndex;
              await window.deck.setSettings({ skipHidden: true });
              await window.deck.toggleTrackHidden(a.id, 2);
              await window.deck.playAt(a.id, 0);
              return { hasBtn, info, restored, skippedTo, noSkipTo };
            })()`);

            // 紧凑悬浮窗（先挪到屏幕中间，避免贴边自动收起干扰尺寸读取）
            const wam = screen.getPrimaryDisplay().workArea;
            miniWin.setBounds({ x: wam.x + 200, y: wam.y + 200, width: 340, height: 126 });
            await sleep(300);
            await mainWin.webContents.executeJavaScript("window.deck.setSettings({miniStyle:'compact'})");
            await sleep(900);
            res.miniCompact = {
              bounds: miniWin.getBounds(),
              style: settings().miniStyle,
              expect: miniSize(settings().miniStyle),
              collapsed: miniCollapsed,
              bodyClass: await miniWin.webContents.executeJavaScript('document.body.className'),
              compactDisplay: await miniWin.webContents.executeJavaScript('getComputedStyle(document.querySelector("#miniCompact")).display'),
              fullDisplay: await miniWin.webContents.executeJavaScript('getComputedStyle(document.querySelector("#miniFull")).display')
            };
            await sleep(400);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'shot-mini-compact.png'), (await miniWin.webContents.capturePage()).toPNG());

            // 完整悬浮窗
            await mainWin.webContents.executeJavaScript("window.deck.setSettings({miniStyle:'full'})");
            await sleep(700);
            res.miniFull = { bounds: miniWin.getBounds(), bodyClass: await miniWin.webContents.executeJavaScript('document.body.className') };
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'shot-mini-full.png'), (await miniWin.webContents.capturePage()).toPNG());

            // 托盘菜单
            showTrayMenu();
            await sleep(600);
            res.tray = { bounds: trayMenuWin.getBounds(), visible: trayMenuWin.isVisible() };
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'shot-tray.png'), (await trayMenuWin.webContents.capturePage()).toPNG());
            res.trayHover = await trayMenuWin.webContents.executeJavaScript(`(async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const items = document.querySelectorAll('.m-item');
              items[0].dispatchEvent(new MouseEvent('mouseenter'));
              await wait(400);
              const tip = document.querySelector('#tip');
              return { itemCount: items.length, tipText: tip.textContent, tipShown: tip.classList.contains('show'),
                       menuWidth: Math.round(document.querySelector('.menu').getBoundingClientRect().width) };
            })()`);
            await sleep(300);
            res.trayAfterHover = trayMenuWin.getBounds();
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'shot-tray-tip.png'), (await trayMenuWin.webContents.capturePage()).toPNG());
            hideTrayMenu();
            await sleep(300);
            res.trayHidden = { visible: trayMenuWin.isVisible(), width: trayMenuWin.getBounds().width };

            // 贴边自动隐藏
            const wa0 = screen.getPrimaryDisplay().workArea;
            miniWin.setBounds({ x: wa0.x, y: wa0.y + 200, width: 341, height: 126 });
            await sleep(250);
            const edge = miniEdgeOf(miniWin.getBounds());
            collapseMini('left', true);
            await sleep(350);
            const cb = miniWin.getBounds();
            expandMini();
            await sleep(350);
            const eb = miniWin.getBounds();
            res.edgeHide = { edge, collapsedX: cb.x, workAreaX: wa0.x, collapsed: cb.x < wa0.x, expandedX: eb.x, restored: Math.abs(eb.x - wa0.x) <= 2 };

            // 窗口被拖出屏幕边缘时也要判定为贴边并收起
            miniWin.setBounds({ x: wa0.x + wa0.width - 80, y: wa0.y + 300, width: 341, height: 126 });
            await sleep(400);
            const overflowEdge = miniEdgeOf(miniWin.getBounds());
            collapseMini('right', true);
            await sleep(400);
            const ob = miniWin.getBounds();
            res.overflowEdge = { edge: overflowEdge, collapsedX: ob.x, rightHidden: ob.x >= wa0.x + wa0.width - 6 };
            expandMini();
            await sleep(300);

            // 手动收起到左 / 右侧
            await mainWin.webContents.executeJavaScript("window.deck.collapseMini('left')");
            await sleep(800);
            const lb = miniWin.getBounds();
            await mainWin.webContents.executeJavaScript("window.deck.collapseMini('right')");
            await sleep(900);
            const rb = miniWin.getBounds();
            expandMini();
            await sleep(400);
            const eb2 = miniWin.getBounds();
            res.manualCollapse = {
              leftX: lb.x, rightX: rb.x, workRight: wa0.x + wa0.width,
              leftCollapsed: lb.x < wa0.x,
              rightCollapsed: rb.x >= wa0.x + wa0.width - 8,
              restoredX: eb2.x
            };

            // 设置弹窗（滚到悬浮窗区块）
            await mainWin.webContents.executeJavaScript(`(async () => {
              document.querySelector('#btnSettings').click();
              await new Promise(r => setTimeout(r, 300));
              const body = document.querySelector('#settingsModal .settings-body');
              const h3s = [...body.querySelectorAll('h3')];
              const target = h3s.find(h => h.textContent.includes('悬浮窗'));
              if (target) body.scrollTop = target.offsetTop - 120;
            })()`);
            await sleep(500);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'shot-settings.png'), (await mainWin.webContents.capturePage()).toPNG());
            await mainWin.webContents.executeJavaScript("document.querySelector('#settingsModal').classList.remove('show')");

            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'ui-test.json'), JSON.stringify(res, null, 2), 'utf8');
            console.log('UI TEST', JSON.stringify(res));
          }
          if (process.argv.includes('--deck-singletest')) {
            const script = `(async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const bvid = 'BV1NM411A7Po';
              const st0 = await window.deck.state();
              const before = st0.albums.length;

              // A. 只贴视频链接、不填任何时间戳，走导入面板
              document.querySelector('#btnImport').click();
              await wait(250);
              document.querySelector('#pBvid').value = bvid;
              document.querySelector('#pTitle').value = '';
              document.querySelector('#pText').value = '';
              document.querySelector('#btnAddPaste').click();
              let alb = null;
              for (let i = 0; i < 60; i++) {
                await wait(300);
                const s = await window.deck.state();
                if (s.albums.length > before) { alb = s.albums[s.albums.length - 1]; break; }
              }
              if (!alb) return { error: '导入没有产生新专辑', before };
              const imported = { title: alb.title, tracks: alb.tracks.length,
                                 name: alb.tracks[0] && alb.tracks[0].name,
                                 start: alb.tracks[0] && alb.tracks[0].start,
                                 end: alb.tracks[0] && alb.tracks[0].end };

              // B. 清空曲目 → 点这张专辑 → 用「按单曲填充」恢复
              await window.deck.updateAlbum(alb.id, { tracks: [], tracksOk: false });
              await wait(400);
              const row = document.querySelector('.album-item[data-id="' + alb.id + '"]');
              if (row) row.click();
              await wait(600);
              const emptyText = (document.querySelector('#trackList .empty') || {}).textContent || '';
              const btn = document.querySelector('#btnFillSingle');
              const hasBtn = !!btn;
              if (btn) btn.click();
              await wait(900);
              const st2 = await window.deck.state();
              const a2 = st2.albums.find(x => x.id === alb.id);
              return { before, after: st2.albums.length, imported, hasBtn,
                       emptyText: emptyText.replace(/\\s+/g, ' ').trim().slice(0, 50),
                       filled: { tracks: a2.tracks.length, name: a2.tracks[0] && a2.tracks[0].name,
                                 end: a2.tracks[0] && a2.tracks[0].end } };
            })()`;
            const res = await mainWin.webContents.executeJavaScript(script);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'single-test.json'), JSON.stringify(res, null, 2), 'utf8');
            console.log('SINGLE TEST', JSON.stringify(res));
          }
          if (process.argv.includes('--deck-chtest')) {
            const script = `(async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const st0 = await window.deck.state();
              const before = st0.albums.length;
              document.querySelector('#btnImport').click();
              await wait(200);
              document.querySelector('#pBvid').value = 'BV1AuWE6pEqv';
              document.querySelector('#pTitle').value = 'The Jacksons 1980《Triumph》';
              document.querySelector('#btnLoadChapters').click();
              for (let i = 0; i < 60; i++) { await wait(300); if (!document.querySelector('#btnLoadChapters').disabled) break; }
              const text = document.querySelector('#pText').value;
              const lines = text.split('\\n').filter(Boolean);
              const preview = document.querySelectorAll('#pPreview .preview-row').length;
              document.querySelector('#btnAddPaste').click();
              let added = null;
              for (let i = 0; i < 60; i++) {
                await wait(300);
                const s = await window.deck.state();
                if (s.albums.length > before) {
                  const a = s.albums[s.albums.length - 1];
                  added = { title: a.title, tracks: a.tracks.length,
                            first: a.tracks[0] && a.tracks[0].name,
                            last: a.tracks[a.tracks.length - 1] && a.tracks[a.tracks.length - 1].name };
                  break;
                }
              }
              // 再验证：清空曲目后，用专辑 ⋯ 菜单的「从视频章节补全曲目」恢复
              const s2 = await window.deck.state();
              const alb = s2.albums[s2.albums.length - 1];
              await window.deck.updateAlbum(alb.id, { tracks: [], tracksOk: false });
              await wait(400);
              const cleared = (await window.deck.state()).albums.find(x => x.id === alb.id).tracks.length;
              const row = [...document.querySelectorAll('.album-item')]
                .find(el => (el.querySelector('.album-meta b') || {}).textContent && el.querySelector('.album-meta b').textContent.includes('Triumph'));
              let menuFilled = 0, menuError = '';
              if (!row) menuError = '找不到专辑行';
              else {
                row.querySelector('[data-more]').click();
                await wait(200);
                const item = document.querySelector('#popMenu [data-am="chapters"]');
                if (!item) menuError = '菜单里没有章节项';
                else {
                  item.click();
                  for (let i = 0; i < 50; i++) {
                    await wait(300);
                    const t = (await window.deck.state()).albums.find(x => x.id === alb.id);
                    if (t.tracks.length > 0) { menuFilled = t.tracks.length; break; }
                  }
                }
              }
              return { before, chapterLines: lines.length, firstLine: lines[0] || '', preview, added,
                       after: (await window.deck.state()).albums.length, cleared, menuFilled, menuError };
            })()`;
            const res = await mainWin.webContents.executeJavaScript(script);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'ch-test.json'), JSON.stringify(res, null, 2), 'utf8');
            console.log('CH TEST', JSON.stringify(res));
          }
          if (process.argv.includes('--deck-jumptest')) {
            const script = `(async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const st0 = await window.deck.state();
              const target = st0.albums[2];
              const f = await window.deck.favCreate({ name: '跳转测试', type: 'album' });
              await window.deck.favAdd(f.id, { kind:'album', bvid:target.bvid, title:target.title,
                                              albumId:target.id, duration:target.duration });
              await wait(150);
              document.querySelector('.side-tab[data-view=folder]').click();
              await wait(150);
              const fi = [...document.querySelectorAll('.folder-item')].find(x => x.textContent.includes('跳转测试'));
              if (!fi) return { error: '找不到新建的专辑收藏夹' };
              fi.click();
              await wait(200);
              const snap = () => ({
                tab: document.querySelector('.side-tab.active').dataset.view,
                title: document.querySelector('#listTitle').textContent,
                rows: document.querySelectorAll('#trackList .track-row').length,
                firstRow: document.querySelector('#trackList .track-name')
                  ? document.querySelector('#trackList .track-name').textContent.trim().slice(0, 40) : '',
                activeAlbum: document.querySelector('.album-item.active .album-meta b')
                  ? document.querySelector('.album-item.active .album-meta b').textContent.trim() : '',
                searchValue: document.querySelector('#albumSearch').value
              });
              const before = snap();
              const row = document.querySelector('#trackList .track-row[data-fkind="album"]');
              if (!row) return { error: '收藏夹里没有专辑行', before };
              row.click();
              await wait(800);
              const st1 = await window.deck.state();
              const list = document.querySelector('#albumList');
              const el = list.querySelector('.album-item.active');
              const lr = list.getBoundingClientRect();
              const er = el ? el.getBoundingClientRect() : null;
              return { targetTitle: target.title, targetTracks: target.tracks.length, before,
                       after: snap(), currentAlbumTitle: st1.current.album ? st1.current.album.title : '',
                       activeVisible: er ? (er.top >= lr.top - 2 && er.bottom <= lr.bottom + 2) : false,
                       scrollTop: Math.round(list.scrollTop) };
            })()`;
            const res = await mainWin.webContents.executeJavaScript(script);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'jump-test.json'), JSON.stringify(res, null, 2), 'utf8');
            console.log('JUMP TEST', JSON.stringify(res));
          }
          if (process.argv.includes('--deck-deltest')) {
            const openScript = `(async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const st0 = await window.deck.state();
              const before = st0.albums.length, targetTitle = st0.albums[0].title;
              const more = document.querySelector('.album-item [data-more]');
              if (!more) return { error: '找不到专辑的 ⋯ 按钮', before };
              more.click();
              await wait(150);
              const del = document.querySelector('#popMenu [data-am="delete"]');
              if (!del) return { error: '菜单里没有「删除这张专辑」', before };
              del.click();
              await wait(250);
              const pop = document.querySelector('#popMenu');
              const r = pop.getBoundingClientRect();
              return { before, targetTitle,
                       visible: pop.classList.contains('show'),
                       hasConfirm: !!pop.querySelector('[data-confirm="1"]'),
                       text: pop.textContent.replace(/\\s+/g, ' ').trim().slice(0, 100),
                       rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) } };
            })()`;
            const openRes = await mainWin.webContents.executeJavaScript(openScript);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'shot-confirm.png'), (await mainWin.capturePage()).toPNG());
            const confirmScript = `(async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const btn = document.querySelector('#popMenu [data-confirm="1"]');
              if (!btn) return { confirmed: false };
              btn.click();
              await wait(450);
              return { confirmed: true, after: (await window.deck.state()).albums.length };
            })()`;
            const confirmRes = await mainWin.webContents.executeJavaScript(confirmScript);
            const trackScript = `(async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const st = await window.deck.state();
              const a = st.current.album;
              if (!a || !a.tracks.length) return { trackError: '没有可删的单曲' };
              const beforeTracks = a.tracks.length, name = a.tracks[0].name;
              const btn = document.querySelector('#trackList [data-del-index="0"]');
              if (!btn) return { trackError: '找不到曲目行的 ✕' };
              btn.click();
              await wait(250);
              const pop = document.querySelector('#popMenu');
              const visible = pop.classList.contains('show');
              const hasConfirm = !!pop.querySelector('[data-confirm="1"]');
              if (hasConfirm) pop.querySelector('[data-confirm="1"]').click();
              await wait(400);
              const st2 = await window.deck.state();
              return { trackName: name, beforeTracks, trackConfirmVisible: visible, trackHasConfirm: hasConfirm,
                       afterTracks: st2.current.album ? st2.current.album.tracks.length : 0 };
            })()`;
            const trackRes = await mainWin.webContents.executeJavaScript(trackScript);
            const result = { ...openRes, ...confirmRes, ...trackRes, removed: openRes.before - (confirmRes.after || openRes.before) };
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'del-test.json'), JSON.stringify(result, null, 2), 'utf8');
            console.log('DEL TEST', JSON.stringify(result));
          }
          if (process.argv.includes('--deck-fav')) {
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'shot-fav.png'), (await mainWin.capturePage()).toPNG());
            await mainWin.webContents.executeJavaScript("document.querySelector('.side-tab[data-view=library]').click()");
            await sleep(400);
            fs.writeFileSync(path.join(__dirname, '..', 'tools', 'shot-favlib.png'), (await mainWin.capturePage()).toPNG());
          }
          fs.writeFileSync(path.join(__dirname, '..', 'tools', 'diag.json'), JSON.stringify({
            albums: albums().length, hotkeyErrors, browserFound: findBrowser() || '',
            dataFile: store.file, seedTracks: (albums()[0] && albums()[0].tracks || []).length
          }, null, 2));
          console.log('SHOT OK');
        } catch (e) { console.error('SHOT FAIL', e); app.exit(1); return; }
        app.exit(0);
      }, 2600);
    }
  });
  app.on('will-quit', () => { store && store.flush(); globalShortcut.unregisterAll(); cdp && cdp.disconnect(); });
  app.on('window-all-closed', e => { /* 常驻托盘，不退出 */ });
}
