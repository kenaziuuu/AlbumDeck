window.addEventListener('error', e => { window.__loadErr = String(e.message) + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno; });
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const fmt = s => window.deck.fmt(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = { albums: [], folders: [], current: {}, playback: {}, conn: {}, settings: { hotkeys: {} }, message: '' };
let sideSig = '', listSig = '', lastMsg = '';
let connSig = '';
const decodeState = DeckState.createDecoder();
let likedIndex = new Set(), albumFavIndex = new Set(), songFolderIndex = new Map();
let albumById = new Map(), albumByBvid = new Map(), albumPositions = new Map();
let candidates = [], selected = new Set(), curMid = null;
let editingId = null;
let miniStyleChoice = 'full';
let queueOpen = false, queueSig = '';
let sortMode = false, sortKey = '', dragFrom = -1;
let sortAlbums = false, albumDragFrom = -1;

const LIKED_ID = 'fav_liked';
let viewMode = 'library';                 // 'library' | 'folder'
let activeFolderId = LIKED_ID;
let popItem = null, popFolder = null, popAction = null, popAnchor = null, popShownAt = 0;
let folderModalMode = 'create', folderModalType = 'song', folderEditingId = null, pendingAddItem = null;
let pendingImportFolder = false;   // 新建收藏夹是为了「导入到收藏夹」时置位
let pickSelected = new Set(), pickItems = [];
/** 专辑收藏夹里哪些专辑是展开的（key = 收藏项 key） */
const favAlbumOpen = new Set();

/* ---------- 状态渲染 ---------- */

function render(progressOnly = false) {
  const hk = S.settings.hotkeys || {};
  renderConn();
  renderNow();
  if (!progressOnly) {
    renderSideHead(); renderSideList(); renderList(); renderPlayMode();
  }
  if (queueOpen) renderQueue();
  if (!progressOnly) $('#hotkeyHint').innerHTML = `全局：`
    + `${kbd(hk.prevTrack)}上一首　${kbd(hk.nextTrack)}下一首　${kbd(hk.prevAlbum)}上张专辑　${kbd(hk.nextAlbum)}下张专辑　${kbd(hk.togglePlay)}播放/暂停　${kbd(hk.toggleMini)}悬浮窗　${kbd(hk.toggleMain)}主窗口`;
  if (S.message && S.message !== lastMsg) { toast(S.message); lastMsg = S.message; }
  if (!S.message) lastMsg = '';
}

/* ---------- 收藏夹小工具 ---------- */

const allFolders = () => S.folders || [];
const likedFolder = () => allFolders().find(f => f.id === LIKED_ID) || { items: [] };
const activeFolder = () => allFolders().find(f => f.id === activeFolderId) || allFolders()[0] || null;
const songKey = (bvid, start) => `song:${bvid}:${Math.round(start || 0)}`;
const albumKey = bvid => `album:${bvid}`;
const isLiked = (bvid, start) => likedIndex.has(songKey(bvid, start));
/** 这首歌所在的歌曲收藏夹（可能多个） */
const songFoldersOf = (bvid, start) => songFolderIndex.get(songKey(bvid, start)) || [];
const isSongFaved = (bvid, start) => songFoldersOf(bvid, start).length > 0;
/** 「正在播放」用的专辑 / 曲目：跟着真正在播的那张走，而不是当前查看的那张 */
const nowAlbum = () => (S.playing && S.playing.album) || S.current.album;
const nowTrack = () => (S.playing && S.playing.track) || null;
const isAlbumFaved = bvid => albumFavIndex.has(albumKey(bvid));
const albumExists = bvid => albumByBvid.has(bvid);

function indexLibrary() {
  likedIndex = new Set(likedFolder().items.map(x => x.key));
  albumFavIndex = new Set(); songFolderIndex = new Map();
  for (const f of allFolders()) for (const item of f.items || []) {
    if (f.type === 'album') albumFavIndex.add(item.key);
    else {
      let list = songFolderIndex.get(item.key);
      if (!list) songFolderIndex.set(item.key, list = []);
      list.push(f);
    }
  }
  albumById = new Map(S.albums.map(a => [a.id, a]));
  albumByBvid = new Map(S.albums.map(a => [a.bvid, a]));
  albumPositions = new Map(S.albums.map((a, i) => [a.id, i]));
}

function songItem(a, t, i) {
  return {
    kind: 'song', bvid: a.bvid, start: t.start, name: t.name, albumTitle: a.title,
    albumId: a.id, trackIndex: i, duration: Math.max(0, (t.end || 0) - t.start)
  };
}
function albumItem(a) {
  return { kind: 'album', bvid: a.bvid, title: a.title, albumId: a.id, duration: a.duration || 0 };
}

function kbd(k) {
  if (!k) return '';
  const p = String(k).replace(/Right/g, '→').replace(/Left/g, '←').replace(/Up/g, '↑').replace(/Down/g, '↓');
  return `<kbd>${esc(p)}</kbd>`;
}

function renderConn() {
  const on = !!S.conn.connected;
  const sig = [on, S.conn.browser, S.conn.port].join('|');
  if (sig === connSig) return;
  connSig = sig;
  $('#connDot').className = 'dot' + (on ? ' on' : '');
  $('#connTitle').textContent = on ? '已连接 · ' + (S.conn.browser || 'Chromium') : '未连接浏览器';
  $('#connSub').textContent = on ? `调试端口 ${S.conn.port || 9222} · 可全局切歌` : '点击启动一个专用的浏览器窗口';
  $('#tbStatus').innerHTML = on
    ? `<b>● 浏览器已连接</b> &nbsp;|&nbsp; 全局快捷键已启用`
    : `○ 未连接浏览器 &nbsp;|&nbsp; 启动后即可用快捷键切歌`;
  $('#btnLaunch').textContent = on ? '重新打开浏览器' : '启动专用浏览器';
}

function lastEnd(a) {
  const t = a.tracks || [];
  return t.length ? (t[t.length - 1].end || 0) : 0;
}

function renderSideHead() {
  $$('.side-tab').forEach(t => t.classList.toggle('active', t.dataset.view === viewMode));
  $('#albumCount').textContent = viewMode === 'library' ? S.albums.length : allFolders().length;
  $('#albumSearch').placeholder = viewMode === 'library' ? '搜索专辑 / 歌手' : '搜索收藏夹';
  $('#btnImport').textContent = viewMode === 'library' ? '＋ 导入专辑 / 合集' : '＋ 新建收藏夹';
}

/** 专辑排序模式：右侧露出编号刻度，把专辑拖到某个编号上就排到那张专辑下面 */
function setSortAlbums(on) {
  sortAlbums = !!on;
  if (on && ($('#albumSearch').value || '').trim()) {
    // 清掉过滤词，否则显示的编号和曲库里的真实索引对不上
    $('#albumSearch').value = '';
  }
  $('#albumListWrap').classList.toggle('sorting', on);
  $('#albumList').querySelectorAll('.album-item').forEach(el => { el.draggable = on; });
  const b = $('#btnSortAlbums');
  b.classList.toggle('on', on);
  b.textContent = on ? '✓' : '⇅';
  b.title = on ? '完成排序' : '调整专辑顺序（右键可按歌名 / 时间 / 歌手排序）';
  sideSig = '';
  renderSideList();
  if (on) toast('拖拽专辑改变顺序；右键这个按钮可以按歌名 / 时间 / 歌手自动排序');
}

function renderSideList() {
  if (sortAlbums && viewMode !== 'library') {
    // 切到收藏夹时静默退出排序模式（不递归回 setSortAlbums）
    sortAlbums = false;
    $('#albumListWrap').classList.remove('sorting');
    $('#btnSortAlbums').classList.remove('on');
    $('#btnSortAlbums').textContent = '⇅';
    $('#btnSortAlbums').title = '调整专辑顺序（右键可按歌名 / 时间 / 歌手排序）';
  }
  $('#btnSortAlbums').hidden = !sortAlbums && (viewMode !== 'library' || S.albums.length < 2);
  const q = ($('#albumSearch').value || '').trim().toLowerCase();
  const favedAlbums = allFolders().filter(f => f.type === 'album')
    .flatMap(f => (f.items || []).map(i => i.key)).join(',');
  const sig = viewMode + '|' + q + '|' + (sortAlbums ? 'S' : '') + '|' +
    (viewMode === 'library'
      ? S.albums.map(a => `${a.id}:${a.title}:${(a.tracks || []).length}`).join('|') + '#' + S.current.albumId + '#' + favedAlbums
      : allFolders().map(f => `${f.id}:${f.name}:${f.type}:${(f.items || []).length}:${f.builtin ? 1 : 0}`).join('|') + '#' + activeFolderId);
  if (sig === sideSig) {
    if (viewMode === 'library') $$('.album-item').forEach(el => el.classList.toggle('active', el.dataset.id === S.current.albumId));
    return;
  }
  sideSig = sig;
  const keepScroll = $('#albumList').scrollTop;
  $('#albumList').innerHTML = viewMode === 'library' ? renderLibrarySide(q) : renderFolderSide(q);
  $('#albumList').scrollTop = keepScroll;
  if (viewMode === 'library') {
    if (!sortAlbums) ensureActiveVisible();
  }
}

/** 重建侧边栏后，把当前专辑滚到可见区域（收藏夹跳转时用得到） */
function ensureActiveVisible() {
  const list = $('#albumList');
  const el = list.querySelector('.album-item.active');
  if (!el) return;
  const lr = list.getBoundingClientRect(), er = el.getBoundingClientRect();
  if (er.top < lr.top + 4 || er.bottom > lr.bottom - 4) {
    list.scrollTop += (er.top - lr.top) - (lr.height / 2 - er.height / 2);
  }
}

function renderLibrarySide(q) {
  const list = S.albums.filter(a => !q || (a.title || '').toLowerCase().includes(q));
  return list.length ? list.map(a => {
    const i = albumPositions.get(a.id);
    const faved = isAlbumFaved(a.bvid);
    return `<div class="album-item ${a.id === S.current.albumId ? 'active' : ''}" data-id="${esc(a.id)}" data-idx="${i}" draggable="${sortAlbums ? 'true' : 'false'}" title="${sortAlbums ? '拖到某个编号上，就排到那张专辑下面' : '点击切换到这张专辑并播放第一首'}">
      <div class="album-idx">${i + 1}</div>
      <div class="album-meta"><b>${esc(a.title)}</b><small>${(a.tracks || []).length} 首 · ${fmt(a.duration || lastEnd(a))}</small></div>
      <button class="album-star ${faved ? 'on' : ''}" data-star="${esc(a.id)}" title="☆ 收藏这张专辑">${faved ? '★' : '☆'}</button>
      <button class="album-more" data-more="${esc(a.id)}" title="更多操作">⋯</button>
    </div>`;
  }).join('') : `<div class="empty">${S.albums.length ? '没有匹配的专辑' : '还没有专辑<br>点下方「导入专辑」开始'}</div>`;
}

function renderFolderSide(q) {
  const match = f => !q || f.name.toLowerCase().includes(q) || (f.type === 'song' ? '歌曲' : '专辑').includes(q);
  const group = (title, list, type) => {
    let html = `<div class="folder-group"><span>${title}</span><span class="pill">${list.length}</span></div>`;
    if (!list.length) return html + `<div class="folder-empty-tip">暂无，点下方按钮新建</div>`;
    return html + list.map(f => `<div class="folder-item ${f.id === activeFolderId ? 'active' : ''}" data-fid="${esc(f.id)}">
      <div class="folder-icon ${f.type === 'album' ? 'album' : ''}">${f.type === 'album' ? '▤' : (f.builtin ? '♥' : '♡')}</div>
      <div class="f-name">${esc(f.name)}${f.builtin ? '<span class="fav-badge">默认</span>' : ''}</div>
      <div class="f-num">${(f.items || []).length}</div>
      <button class="folder-more" data-fmore="${esc(f.id)}" title="管理收藏夹">⋯</button>
    </div>`).join('');
  };
  return group('♥ 歌曲收藏夹', allFolders().filter(f => f.type === 'song' && match(f)), 'song')
    + group('▤ 专辑收藏夹', allFolders().filter(f => f.type === 'album' && match(f)), 'album')
    + `<button class="folder-add" id="btnNewFolder">＋ 新建收藏夹</button>
       <div class="folder-empty-tip">给歌曲点 ♥ 会自动进入「喜欢」；点 ☆ 可收藏到任意收藏夹。</div>`;
}

function renderNow() {
  // 「正在播放」卡片跟着**真正在播的**走：手动选中别的专辑看曲目时，这里仍显示在播的那首
  const p = S.playing || {};
  const ext = !!p.external;            // 浏览器里放的是曲库外的视频
  const a = ext ? null : (p.album || S.current.album);
  const t = p.track || null;
  const pb = { t: p.t || 0, d: p.d || 0, paused: p.paused !== false };
  $('#nowTrack').textContent = t ? t.name : '选择一首歌';
  $('#nowAlbum').textContent = a ? `${a.title || ''} · ${a.bvid || ''} · ${fmt(a.duration || lastEnd(a))}`
    : (ext ? '曲库外的视频（不在曲库）' : '—');
  const cover = $('#cover');
  if (a && a.pic) {
    cover.classList.add('has-img');
    if (cover.dataset.pic !== a.pic) {
      cover.dataset.pic = a.pic;
      cover.innerHTML = `<img src="${esc(String(a.pic).replace(/^http:/, 'https:'))}" alt="">`;
    }
  } else {
    cover.classList.remove('has-img');
    if (cover.dataset.pic !== 'none') { cover.dataset.pic = 'none'; cover.innerHTML = `<div class="cover-inner">♫</div>`; }
  }

  const total = t ? Math.max(1, (t.end || (pb.d || 0)) - t.start) : 1;
  const pos = t ? Math.max(0, Math.min(total, (pb.t || 0) - t.start)) : 0;
  const pct = Math.max(0, Math.min(100, pos / total * 100));
  $('#barFill').style.width = pct + '%';
  $('#barHandle').style.left = pct + '%';
  $('#timeNow').textContent = fmt(pos);
  $('#timeTotal').textContent = fmt(total);
  const icon = $('#playIcon');
  if (icon.dataset.paused !== String(pb.paused)) {
    icon.dataset.paused = String(pb.paused);
    icon.innerHTML = pb.paused ? `<path d="M8 5l11 7-11 7z"/>` : `<path d="M7 5h4v14H7zM14 5h4v14h-4z"/>`;
  }
  $('#btnEditAlbum').style.display = a ? '' : 'none';
  $('#btnOpenBili').style.display = a ? '' : 'none';

  const lk = !!(a && t && isLiked(a.bvid, t.start));
  const faved = !!(a && t && isSongFaved(a.bvid, t.start));
  $('#btnLikeNow').style.display = (a && t) ? '' : 'none';
  $('#btnFavNow').style.display = (a && t) ? '' : 'none';
  $('#btnLikeNow').classList.toggle('on', lk);
  $('#btnLikeNow').textContent = lk ? '♥ 已红心' : '♡ 红心';
  $('#btnFavNow').classList.toggle('on', faved);
  $('#btnFavNow').textContent = faved ? '★ 已收藏' : '☆ 收藏';
}

/* ── 调整顺序（拖拽） ── */

/** 当前列表对应的目标：某张专辑的曲目表，或某个收藏夹 */
function listTarget() {
  if (viewMode === 'library') {
    const a = S.current.album;
    return a ? { kind: 'album', id: a.id } : null;
  }
  const f = activeFolder();
  return f ? { kind: 'folder', id: f.id } : null;
}

function setSortMode(on) {
  sortMode = !!on;
  const t = listTarget();
  sortKey = on && t ? `${t.kind}:${t.id}` : '';
  // 排序时把专辑展开都收起来，避免子曲目行打乱拖拽索引
  if (on && favAlbumOpen.size) { favAlbumOpen.clear(); listSig = ''; }
  const list = $('#trackList');
  list.classList.toggle('sorting', on);
  list.querySelectorAll('.track-row').forEach(r => { r.draggable = on; });
  const b = $('#btnSort');
  b.classList.toggle('on', on);
  b.textContent = on ? '✓ 完成排序' : '⇅ 调整顺序';
  if (on) toast('拖拽条目调整顺序，调好后点「✓ 完成排序」');
}

/** 视图或目标变了就自动退出排序模式 */
function syncSortMode() {
  if (!sortMode) return;
  const t = listTarget();
  const key = t ? `${t.kind}:${t.id}` : '';
  if (key !== sortKey) setSortMode(false);
}

function renderList() {
  syncSortMode();
  const likedKeys = likedFolder().items.map(x => x.key).join(',');
  if (viewMode === 'library') {
    $('#listTitle').textContent = '曲目列表';
    $('#btnAddTrack').hidden = false;
    $('#folderTools').hidden = true;
    const a = S.current.album;
    $('#btnSort').hidden = !sortMode && ((a && a.tracks) || []).length < 2;
    const sig = `lib|${a ? a.id : 'none'}|${((a && a.tracks) || []).map(t => t.name + t.start + t.end + (t.hidden ? 'h' : '')).join(',')}|${likedKeys}`;
    if (sig !== listSig) {
      listSig = sig;
      const tracks = (a && a.tracks) || [];
      const hiddenCount = tracks.filter(t => t.hidden).length;
      $('#trackCount').textContent = tracks.length
        ? `共 ${tracks.length} 首${hiddenCount ? ` · 已隐藏 ${hiddenCount}` : ''}` : '';
      $('#trackList').innerHTML = tracks.length ? tracks.map((t, i) => {
        const dur = (t.end || 0) - t.start;
        const on = a && isLiked(a.bvid, t.start);
        const hid = !!t.hidden;
        return `<div class="track-row ${hid ? 'hidden-track' : ''}" data-i="${i}" draggable="${sortMode ? 'true' : 'false'}">
          <div class="track-no">${String(i + 1).padStart(2, '0')}</div>
          <div class="track-name">${esc(t.name)}</div>
          <div class="track-time">${fmt(t.start)}</div>
          <div class="track-dur">${dur > 0 ? fmt(dur) : '—'}</div>
          <button class="row-btn heart ${on ? 'on' : ''}" data-like-index="${i}" title="红心 → 歌曲收藏夹「喜欢」">♥</button>
          <button class="row-btn star ${isSongFaved(a.bvid, t.start) ? 'on' : ''}" data-fav-index="${i}" title="收藏到收藏夹（已在任意收藏夹里就点亮）">${isSongFaved(a.bvid, t.start) ? '★' : '☆'}</button>
          <button class="row-btn restore ${hid ? 'on' : ''}" data-hide-index="${i}" title="${hid ? '恢复显示这首' : '隐藏这首（播放时自动跳过）'}">${hid ? '○' : '✕'}</button>
        </div>`;
      }).join('') : `<div class="empty">这张专辑还没有曲目表<br>
        <button class="btn ghost small" id="btnFillSingle" style="margin:10px 0 8px">按单曲填充（用视频名称）</button><br>
        也可以点「编辑曲目」里的「从视频章节读取」，或手动「＋ 加入单曲」</div>`;
    }
    $$('.track-row').forEach(el => el.classList.toggle('active', Number(el.dataset.i) === Number(S.current.trackIndex)));
    return;
  }

  // 收藏夹视图
  const f = activeFolder();
  $('#btnAddTrack').hidden = true;
  $('#folderTools').hidden = false;
  $('#btnSort').hidden = !sortMode && ((f && f.items) || []).length < 2;
  $('#btnPickItems').textContent = f && f.type === 'album' ? '＋ 加入专辑' : '＋ 加入单曲';
  $('#btnFolderDelete').style.display = f && f.builtin ? 'none' : '';
  $('#listTitle').textContent = f ? f.name : '收藏夹';
  $('#trackCount').textContent = f ? `${(f.items || []).length} 项 · ${f.type === 'album' ? '专辑收藏夹' : '歌曲收藏夹'}` : '';
  const libSig = S.albums.map(x => (x.tracks || []).length + 'h' + (x.tracks || []).filter(t => t.hidden).length).join(',');
  const favSig = S.folders.map(x => x.items.length).join('/');
  const openSig = [...favAlbumOpen].sort().join(',');
  const pl0 = S.playing || {};
  const pSig = (pl0.album && pl0.album.id ? pl0.album.id : '') + ':' + (pl0.trackIndex || 0);
  const sig = `folder|${f ? f.id : 'none'}|${f ? (f.items || []).map(i => i.key).join(',') : ''}|${likedKeys}|${libSig}|${favSig}|${openSig}|${pSig}`;
  if (sig !== listSig) {
    listSig = sig;
    const items = (f && f.items) || [];
    const rows = [];
    items.forEach((it, i) => {
      const isSong = it.kind !== 'album';
      const lib = albumByBvid.get(it.bvid) || albumById.get(it.albumId);
      const missing = !lib;
      const name = isSong ? it.name : it.title;
      const cnt = lib ? (lib.tracks || []).length : 0;
      const dur = isSong ? it.duration : 0;
      const total = it.duration || (lib && lib.duration) || 0;
      const open = !isSong && favAlbumOpen.has(it.key) && !!lib;
      const sub = isSong ? (it.albumTitle || '')
        : `整张专辑 · ${cnt ? cnt + ' 首' : '—'} · 点击展开曲目`;
      rows.push(`<div class="track-row ${open ? 'fav-album-open' : ''}" data-fkey="${esc(it.key)}" data-fkind="${it.kind}" draggable="${sortMode ? 'true' : 'false'}" title="${missing ? '已不在曲库 · 右键可查看来源 / 重新导入' : (isSong ? '播放这首歌曲（右键可查看来源）' : '点击展开这张专辑的曲目（右键可查看来源）')}">
        <div class="track-no">${String(i + 1).padStart(2, '0')}</div>
        <div class="track-name">${esc(name)}${missing ? '<span class="fav-badge">已不在曲库</span>' : ''}<span class="fav-sub">${esc(sub)}</span></div>
        <div class="track-time">${isSong ? fmt(it.start) : (cnt ? `${cnt} 首` : '—')}</div>
        <div class="track-dur">${isSong ? (dur > 0 ? fmt(dur) : '—') : (total ? fmt(total) : '—')}</div>
        ${isSong
          ? `<button class="row-btn heart ${isLiked(it.bvid, it.start) ? 'on' : ''}" data-flike="${esc(it.key)}" title="切换红心">♥</button>`
          : `<button class="row-btn fav-arrow ${open ? 'open' : ''}" data-fexpand="${esc(it.key)}" title="${open ? '收起曲目' : '展开曲目'}">▶</button>`}
        <button class="row-btn star ${isSong && isSongFaved(it.bvid, it.start) ? 'on' : ''}" data-ffav="${esc(it.key)}" title="也收藏到其它收藏夹">☆</button>
        <button class="row-btn" data-fdel="${esc(it.key)}" title="从这个收藏夹移除">✕</button>
      </div>`);
      // 专辑展开：列出曲目，红心 / 收藏 / 隐藏都直接操作曲库里的同一份数据
      if (open) {
        (lib.tracks || []).forEach((t, ti) => {
          const tDur = (t.end || 0) - t.start;
          const liked = isLiked(lib.bvid, t.start);
          const faved = isSongFaved(lib.bvid, t.start);
          const isNow = !!(pl0.album && pl0.album.id === lib.id && pl0.trackIndex === ti);
          rows.push(`<div class="track-row fav-sub-track ${t.hidden ? 'hidden-track' : ''} ${isNow ? 'active' : ''}" data-fkey="${esc(it.key)}" data-ti="${ti}" data-fat="1" draggable="false" title="播放这首（右键可查看来源）">
            <div class="track-no">${String(ti + 1).padStart(2, '0')}</div>
            <div class="track-name">${esc(t.name)}</div>
            <div class="track-time">${fmt(t.start)}</div>
            <div class="track-dur">${tDur > 0 ? fmt(tDur) : '—'}</div>
            <button class="row-btn heart ${liked ? 'on' : ''}" data-fat-like="${ti}" title="红心 → 歌曲收藏夹「喜欢」">♥</button>
            <button class="row-btn star ${faved ? 'on' : ''}" data-fat-fav="${ti}" title="收藏到收藏夹（已在任意收藏夹里就点亮）">${faved ? '★' : '☆'}</button>
            <button class="row-btn restore ${t.hidden ? 'on' : ''}" data-fat-hide="${ti}" title="${t.hidden ? '恢复显示这首' : '隐藏这首（播放时自动跳过）'}">${t.hidden ? '○' : '✕'}</button>
          </div>`);
        });
      }
    });
    $('#trackList').innerHTML = rows.length ? rows.join('') : `<div class="empty">${f && f.builtin
      ? '还没有红心的歌曲<br>在「资料库」里给歌曲点 ♥，就会自动出现在这里'
      : '这个收藏夹还是空的<br>点上方「＋ 加入单曲」从曲库挑选'}</div>`;
  }
}

/** 从收藏夹跳回资料库，定位到该专辑并显示它的曲目列表 */
async function jumpToAlbum(a) {
  viewMode = 'library';
  $('#albumSearch').value = '';        // 清掉过滤词，保证目标专辑一定可见
  sideSig = ''; listSig = '';
  render();                            // 先切视图，点击后立刻有反馈
  if (S.settings.albumClickPlay === false) await window.deck.selectAlbum(a.id);
  else await window.deck.playAt(a.id, 0);
  render();
  ensureActiveVisible();
  toast(`已跳转到「${a.title}」的曲目列表`);
}

/** 收藏夹某一项对应的曲库专辑（bvid 优先，id 兜底） */
function favItemLib(key) {
  const f = activeFolder();
  const it = f && (f.items || []).find(x => x.key === key);
  if (!it) return null;
  return S.albums.find(x => x.bvid === it.bvid) || S.albums.find(x => x.id === it.albumId) || null;
}

/** 展开 / 收起收藏夹里的专辑曲目 */
function toggleFavAlbum(key) {
  if (favAlbumOpen.has(key)) favAlbumOpen.delete(key); else favAlbumOpen.add(key);
  listSig = '';
  render();
}

/* ---------- 播放顺序 / 播放列表 ---------- */

const MODE_ICONS = {
  once: '<svg viewBox="0 0 24 24"><path d="M7 5v14M17 5v14"/></svg>',
  loop: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 13.7-5.7M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-13.7 5.7M4 20v-5h5"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>',
  one: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 13.7-5.7M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-13.7 5.7M4 20v-5h5"/><text x="12" y="16.5" text-anchor="middle" font-size="9" fill="currentColor" stroke="none">1</text></svg>'
};

function renderPlayMode() {
  const modes = S.playModes || [];
  const key = S.settings.playMode || 'all-loop';
  const meta = modes.find(m => m.key === key) || { short: '全专循环', scope: '全库', label: '全专循环播放' };
  const icon = key === 'once' ? MODE_ICONS.once : key === 'one' ? MODE_ICONS.one
    : (key.indexOf('shuffle') >= 0 || key === 'album-random' ? MODE_ICONS.shuffle : MODE_ICONS.loop);
  const btn = $('#btnPlayMode');
  const html = `${icon}<span>${esc(meta.short)}</span><span class="mscope">${esc(meta.scope)}</span>`;
  if (btn.dataset.html !== html) { btn.dataset.html = html; btn.innerHTML = html; }
  btn.title = `当前：${meta.label}（点一下切换）`;
}

function renderQueue() {
  const q = S.queue || { items: [], pos: 0 };
  const items = q.items || [];
  // 高亮跟着正在播放走（手动选中别的专辑查看时，队列仍属于在播的那张）
  const pAlbumId = (S.playing && S.playing.album && S.playing.album.id) || S.current.albumId;
  const pTrackIdx = (S.playing && S.playing.trackIndex) || 0;
  const sig = [q.mode, q.rev, q.pos, pAlbumId, pTrackIdx, S.albums.length, items.length, (q.source && q.source.id) || ''].join('|');
  if (sig === queueSig) return;
  queueSig = sig;

  const src = q.source && q.source.kind === 'folder' ? q.source : null;
  const meta = (S.playModes || []).find(m => m.key === q.mode);
  $('#qpCount').textContent = items.length ? `${items.length} 首` : '';
  $('#qpMode').textContent = src
    ? `收藏夹「${src.name}」 · 点此回到整库列表`
    : (meta ? `播放顺序：${meta.label}` : '');
  $('#qpMode').classList.toggle('from-folder', !!src);
  $('#qpMode').title = src ? `当前播放列表来自收藏夹「${src.name}」` : '';
  if (!items.length) {
    $('#qpList').innerHTML = `<div class="empty" style="height:160px">播放列表为空</div>`;
    return;
  }

  // 按专辑分组：组顺序 = 队列里首次出现的顺序，组内按队列顺序
  const groups = [];
  const map = new Map();
  items.forEach((it, qi) => {
    let g = map.get(it.albumId);
    if (!g) { g = { albumId: it.albumId, list: [] }; map.set(it.albumId, g); groups.push(g); }
    g.list.push({ albumId: it.albumId, trackIndex: it.trackIndex, qi });
  });

  $('#qpList').innerHTML = groups.map(g => {
    const a = albumById.get(g.albumId);
    const isCurrent = g.albumId === pAlbumId;
    const open = isCurrent;
    const rows = g.list.map(it => {
      const t = a && a.tracks && a.tracks[it.trackIndex];
      if (!t) return '';
      const active = it.albumId === pAlbumId && it.trackIndex === pTrackIdx;
      return `<div class="qp-track ${active ? 'active' : ''} ${t.hidden ? 'hidden-track' : ''}" data-qi="${it.qi}">
        <span class="qno">${String(it.trackIndex + 1).padStart(2, '0')}</span>
        <span class="qname">${esc(t.name)}</span>
        <span class="qtime">${fmt(t.start)}</span>
      </div>`;
    }).join('');
    return `<div class="qp-group ${open ? 'open' : ''} ${isCurrent ? 'current' : ''}" data-album="${esc(g.albumId)}">
      <div class="qp-album"><span class="qp-arrow">▶</span><span class="qp-title">${esc(a ? a.title : '未知专辑')}</span><span class="qp-num">${g.list.length} 首</span></div>
      <div class="qp-tracks">${rows}</div>
    </div>`;
  }).join('');
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ---------- 弹窗 ---------- */

function openModal(id) { $('#' + id).classList.add('show'); }
function closeModal(id) { $('#' + id).classList.remove('show'); }
$$('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
$$('.mask').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); }));

$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.toggle('active', x === t));
  $$('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + t.dataset.tab));
}));
function switchTab(name) { const t = $(`.tab[data-tab="${name}"]`); if (t) t.click(); }

/* ---------- 主界面按钮 ---------- */

$$('.tb-btn').forEach(b => b.addEventListener('click', () => {
  const a = b.dataset.win;
  if (a === 'min') window.deck.min();
  if (a === 'max') window.deck.max();
  if (a === 'close') window.deck.close();
}));

$('#btnLaunch').addEventListener('click', async () => {
  toast('正在启动专用浏览器…');
  try { await window.deck.launch(); } catch (e) { toast('启动失败：' + e.message); }
});
$('#btnReconnect').addEventListener('click', async () => {
  try { await window.deck.connect(); toast('已连接'); } catch (e) { toast('连接失败：' + e.message); }
});
$('#btnImport').addEventListener('click', () => {
  if (viewMode === 'folder') openFolderModal({ mode: 'create', type: 'song' });
  else openModal('importModal');
});
$('#btnSettings').addEventListener('click', () => { fillSettings(); openModal('settingsModal'); });
$('#btnExport').addEventListener('click', async () => { const p = await window.deck.exportLibrary(); if (p) toast('已导出：' + p); });
$('#btnMini').addEventListener('click', () => window.deck.toggleMini());

/* 标题栏右上角：悬浮窗显示 / 样式 */
$('#btnMiniMenu').addEventListener('click', e => {
  e.stopPropagation();
  const style = S.settings.miniStyle || 'full';
  const visible = !!S.settings.miniVisible;
  showPop(e.currentTarget, `<div class="pop-head">悬浮窗</div>
    <button class="pop-item" data-mini="toggle"><span class="pi-ico">${visible ? '▣' : '▢'}</span>开启/关闭悬浮窗</button>
    <button class="pop-item" data-mini="full"><span class="pi-ico">${style === 'full' ? '✓' : ' '}</span>完整样式</button>
    <button class="pop-item" data-mini="compact"><span class="pi-ico">${style === 'compact' ? '✓' : ' '}</span>简洁长条</button>
    <button class="pop-item" data-mini="vertical"><span class="pi-ico">${style === 'vertical' ? '✓' : ' '}</span>MP3样式</button>
    <div class="pop-head" style="border-top:1px solid var(--line);margin-top:5px;padding-top:8px">隐藏到侧边</div>
    <button class="pop-item" data-mini="left"><span class="pi-ico">◧</span>收起到屏幕左侧</button>
    <button class="pop-item" data-mini="right"><span class="pi-ico">◨</span>收起到屏幕右侧</button>`);
});

$('#btnPrev').addEventListener('click', () => window.deck.prev());
$('#btnNext').addEventListener('click', () => window.deck.next());
$('#btnPrevAlbum').addEventListener('click', () => window.deck.prevAlbum());
$('#btnNextAlbum').addEventListener('click', () => window.deck.nextAlbum());
$('#btnPlay').addEventListener('click', () => window.deck.togglePlay());
/* 播放顺序：点一下换下一种 */
/* 播放顺序：点一下换下一种，右键直接列出全部方式 */
$('#btnPlayMode').addEventListener('contextmenu', e => {
  e.preventDefault();
  const cur = S.settings.playMode || 'all-loop';
  showPop(e.currentTarget, `<div class="pop-head">播放顺序</div>` + (S.playModes || []).map(m =>
    `<button class="pop-item${m.key === cur ? ' on' : ''}" data-pm="${esc(m.key)}">
      <span class="pi-ico">${m.key === cur ? '✓' : ' '}</span>${esc(m.label)}
      <span class="pi-count">${esc(m.scope)}</span></button>`).join(''));
});
$('#btnPlayMode').addEventListener('click', async () => {
  const modes = S.playModes || [];
  if (!modes.length) return;
  const cur = S.settings.playMode || 'all-loop';
  const i = modes.findIndex(m => m.key === cur);
  const next = modes[(i + 1) % modes.length];
  try {
    await window.deck.setPlayMode(next.key);
    queueSig = '';
    toast(`播放顺序：${next.label}`);
  } catch (e) { toast('切换失败：' + e.message); }
});

/* 播放列表抽屉 */
$('#btnQueue').addEventListener('click', () => {
  queueOpen = !queueOpen;
  $('#queuePanel').classList.toggle('show', queueOpen);
  if (queueOpen) { queueSig = ''; renderQueue(); }
});
$('#qpClose').addEventListener('click', () => {
  queueOpen = false;
  $('#queuePanel').classList.remove('show');
});
/* 播放列表来自收藏夹时，点标题那行回到整库队列 */
$('#qpMode').addEventListener('click', async () => {
  if (!(S.queue && S.queue.source)) return;
  try {
    await window.deck.clearQueueSource();
    toast('已回到整库播放列表');
  } catch (err) { toast('切换失败：' + err.message); }
});
$('#qpList').addEventListener('click', e => {
  const head = e.target.closest('.qp-album');
  if (head) { head.parentElement.classList.toggle('open'); return; }
  const tr = e.target.closest('.qp-track');
  if (!tr) return;
  const it = (S.queue && S.queue.items || [])[Number(tr.dataset.qi)];
  if (it) window.deck.playAt(it.albumId, it.trackIndex);
});
/* 点播放列表以外的地方自动收起 */
document.addEventListener('click', e => {
  if (!queueOpen) return;
  if (e.target.closest('#queuePanel') || e.target.closest('#btnQueue') || e.target.closest('#popMenu')) return;
  queueOpen = false;
  $('#queuePanel').classList.remove('show');
});

/* ── 专辑排序：拖拽改顺序；右键按钮按歌名 / 时间 / 歌手自动排 ── */
$('#btnSortAlbums').addEventListener('click', () => setSortAlbums(!sortAlbums));
$('#btnSortAlbums').addEventListener('contextmenu', e => {
  e.preventDefault();
  showPop(e.currentTarget, `<div class="pop-head">专辑排序</div>
    <button class="pop-item" data-sortalb="name"><span class="pi-ico">A</span>按歌名（专辑名）</button>
    <button class="pop-item" data-sortalb="year"><span class="pi-ico">⏱</span>按时间（年份）</button>
    <button class="pop-item" data-sortalb="artist"><span class="pi-ico">♪</span>按歌手</button>`);
});

let albumAutoDir = 0, albumAutoSpeed = 12, albumAutoTimer = null;

/** 拖到列表上下边缘时自动滚动，越靠边越快，方便跨很远调位置 */
function albumAutoScroll(dir, speed) {
  const sp = speed || 12;
  if (albumAutoDir === dir && albumAutoSpeed === sp) return;
  albumAutoDir = dir;
  albumAutoSpeed = sp;
  if (albumAutoTimer) { clearInterval(albumAutoTimer); albumAutoTimer = null; }
  if (!dir) return;
  albumAutoTimer = setInterval(() => {
    const list = $('#albumList');
    const before = list.scrollTop;
    list.scrollTop = before + dir * albumAutoSpeed;
    if (list.scrollTop === before) { albumAutoScroll(0); return; }
  }, 16);
}

function albumScrollByPointer(y) {
  const rect = $('#albumList').getBoundingClientRect();
  const zone = Math.min(90, rect.height * 0.25);
  if (y < rect.top + zone) {
    const k = 1 - Math.max(0, y - rect.top) / zone;      // 越靠上越快
    albumAutoScroll(-1, 6 + k * 20);
  } else if (y > rect.bottom - zone) {
    const k = 1 - Math.max(0, rect.bottom - y) / zone;   // 越靠下越快
    albumAutoScroll(1, 6 + k * 20);
  } else {
    albumAutoScroll(0);
  }
}

function clearAlbumDrop() {
  $$('#albumList .album-item').forEach(el => el.classList.remove('dragging', 'drop-into'));
}

/** 鼠标下方对应的目标行 */
function albumTargetIndex(el) {
  if (!el || !el.closest) return -1;
  const item = el.closest('.album-item');
  if (!item) return -1;
  return [...$('#albumList').querySelectorAll('.album-item')].indexOf(item);
}

function markAlbumTarget(idx) {
  $$('#albumList .album-item').forEach((el, i) => el.classList.toggle('drop-into', i === idx));
}

$('#albumListWrap').addEventListener('dragstart', e => {
  const row = e.target.closest('.album-item');
  if (!sortAlbums || !row) { e.preventDefault(); return; }
  albumDragFrom = [...$('#albumList').querySelectorAll('.album-item')].indexOf(row);
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', String(albumDragFrom)); } catch (_) {}
});

$('#albumListWrap').addEventListener('dragover', e => {
  if (!sortAlbums || albumDragFrom < 0) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  albumScrollByPointer(e.clientY);
  markAlbumTarget(albumTargetIndex(e.target));
});

$('#albumListWrap').addEventListener('dragend', () => {
  albumDragFrom = -1;
  albumAutoScroll(0);
  clearAlbumDrop();
});

$('#albumListWrap').addEventListener('drop', async e => {
  if (!sortAlbums || albumDragFrom < 0) return;
  e.preventDefault();
  albumAutoScroll(0);
  const list = $('#albumList');
  const rows = [...list.querySelectorAll('.album-item')];
  const from = albumDragFrom;
  const target = albumTargetIndex(e.target);
  albumDragFrom = -1;
  clearAlbumDrop();
  if (from < 0 || from >= rows.length || target < 0 || target === from) return;
  const to = from < target ? target : target + 1;     // 落到目标专辑下面
  if (to === from) return;

  // 先排好 DOM 让视觉立刻跟上，再落库
  const node = rows[from];
  rows.splice(from, 1);
  rows.splice(to, 0, node);
  rows.forEach(n => list.appendChild(n));

  try { await window.deck.reorderAlbums(from, to); }
  catch (err) { toast('调整顺序失败：' + err.message); }
  sideSig = '';
});

/* ── 调整顺序（拖拽） ── */
$('#btnSort').addEventListener('click', () => setSortMode(!sortMode));

function clearDropMarks() {
  $$('#trackList .track-row').forEach(r => r.classList.remove('dragging', 'drop-before', 'drop-after'));
}

$('#trackList').addEventListener('dragstart', e => {
  const row = e.target.closest('.track-row');
  if (!sortMode || !row) { e.preventDefault(); return; }
  dragFrom = [...$('#trackList').querySelectorAll('.track-row')].indexOf(row);
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch (_) {}
});

$('#trackList').addEventListener('dragover', e => {
  if (!sortMode || dragFrom < 0) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  $$('#trackList .track-row').forEach(r => r.classList.remove('drop-before', 'drop-after'));
  const over = e.target.closest('.track-row');
  if (!over || over.classList.contains('dragging')) return;
  const rect = over.getBoundingClientRect();
  over.classList.add(e.clientY > rect.top + rect.height / 2 ? 'drop-after' : 'drop-before');
});

$('#trackList').addEventListener('dragend', () => { dragFrom = -1; clearDropMarks(); });

$('#trackList').addEventListener('drop', async e => {
  if (!sortMode || dragFrom < 0) return;
  e.preventDefault();
  const list = $('#trackList');
  const rows = [...list.querySelectorAll('.track-row')];
  const over = e.target.closest('.track-row');
  const from = dragFrom;
  dragFrom = -1;
  clearDropMarks();
  if (!over || from < 0 || from >= rows.length) return;

  let to = rows.indexOf(over);
  if (to < 0) return;
  const rect = over.getBoundingClientRect();
  if (e.clientY > rect.top + rect.height / 2) to += 1;
  if (to > from) to -= 1;                 // 归一化成"移除之后"的插入位置
  if (to === from) return;

  const tgt = listTarget();
  if (!tgt) return;

  // 先把 DOM 排好让视觉立刻跟上，再落库
  const node = rows[from];
  rows.splice(from, 1);
  rows.splice(to, 0, node);
  rows.forEach(r => list.appendChild(r));

  try {
    if (tgt.kind === 'album') await window.deck.reorderTracks(tgt.id, from, to);
    else await window.deck.reorderFav(tgt.id, from, to);
  } catch (err) {
    toast('调整顺序失败：' + err.message);
  }
  listSig = '';
});

$('#btnOpenBili').addEventListener('click', () => {
  const a = nowAlbum(); if (a && a.bvid) window.deck.openExternal(`https://www.bilibili.com/video/${a.bvid}/`);
});

$$('.side-tab').forEach(t => t.addEventListener('click', () => {
  viewMode = t.dataset.view;
  if (viewMode === 'folder' && !allFolders().some(f => f.id === activeFolderId)) activeFolderId = LIKED_ID;
  sideSig = ''; listSig = '';
  hidePop(); render();
}));
$('#albumSearch').addEventListener('input', () => {
  // 排序模式下开始搜索就退出排序，避免过滤后的编号和真实索引对不上
  if (sortAlbums && ($('#albumSearch').value || '').trim()) setSortAlbums(false);
  sideSig = ''; renderSideList();
});
$('#albumList').addEventListener('click', e => {
  if (sortAlbums) return;             // 排序模式下只拖拽，不触发切换/收藏/菜单
  const star = e.target.closest('[data-star]');
  if (star) {
    e.stopPropagation();
    const a = S.albums.find(x => x.id === star.dataset.star);
    if (a) openFavPicker(star, albumItem(a));
    return;
  }
  const more = e.target.closest('[data-more]');
  if (more) {
    e.stopPropagation();
    const a = S.albums.find(x => x.id === more.dataset.more);
    if (a) openAlbumMore(more, a);
    return;
  }
  const fmore = e.target.closest('[data-fmore]');
  if (fmore) {
    e.stopPropagation();
    const f = allFolders().find(x => x.id === fmore.dataset.fmore);
    if (f) openFolderMore(fmore, f);
    return;
  }
  if (e.target.closest('#btnNewFolder')) { openFolderModal({ mode: 'create', type: 'song' }); return; }
  const fi = e.target.closest('[data-fid]');
  if (fi) { activeFolderId = fi.dataset.fid; sideSig = ''; listSig = ''; render(); return; }
  const el = e.target.closest('.album-item');
  if (el) {
    // 设置里关掉「点击专辑直接播放」时，只切过去显示曲目列表
    if (S.settings.albumClickPlay === false) window.deck.selectAlbum(el.dataset.id);
    else window.deck.playAt(el.dataset.id, 0);
  }
});
/** 某一项（收藏夹里的项 / 资料库里的专辑或曲目）的右键菜单：看来源 / 复制链接 / 重新导入 */
function openSourceMenu(anchor, it) {
  const lib = S.albums.find(x => x.bvid === it.bvid);
  const name = it.kind === 'album' ? it.title : it.name;
  const isSong = it.kind !== 'album';
  showPop(anchor, `<div class="pop-head">${esc(name)}</div>
    <div class="pop-empty">来源：${esc(it.bvid)}${isSong ? `　起点 ${fmt(it.start)}` : ''}<br>
      ${lib ? `在曲库 · ${(lib.tracks || []).length} 首` : '已不在曲库'}</div>
    <button class="pop-item" data-fsrc="open"><span class="pi-ico">↗</span>在浏览器打开 B 站页面</button>
    <button class="pop-item" data-fsrc="copy"><span class="pi-ico">⧉</span>复制视频链接</button>
    ${lib ? '<button class="pop-item" data-fsrc="goto"><span class="pi-ico">▤</span>在资料库打开这张专辑</button>' : ''}
    <button class="pop-item new" data-fsrc="reimport"><span class="pi-ico">⟳</span>${lib ? '重新抓取这张专辑的曲目' : '重新导入这张专辑'}</button>`);
  popItem = it;
}

$('#trackList').addEventListener('contextmenu', e => {
  const frow = e.target.closest('.track-row[data-fkey]');
  if (frow) {
    e.preventDefault();
    // 专辑收藏夹里展开的曲目行：菜单针对这首，而不是整张专辑
    if (frow.dataset.fat) {
      const lib = favItemLib(frow.dataset.fkey);
      const ti = Number(frow.dataset.ti);
      if (lib && lib.tracks && lib.tracks[ti]) openSourceMenu(frow, songItem(lib, lib.tracks[ti], ti));
      return;
    }
    const f = activeFolder();
    const it = f && (f.items || []).find(x => x.key === frow.dataset.fkey);
    if (it) openSourceMenu(frow, it);
    return;
  }
  // 资料库里的曲目行也能右键
  if (viewMode !== 'library') return;
  const row = e.target.closest('.track-row');
  if (!row) return;
  const a = S.current.album, i = Number(row.dataset.i);
  if (!a || !a.tracks || !a.tracks[i]) return;
  e.preventDefault();
  openSourceMenu(row, songItem(a, a.tracks[i], i));
});

$('#albumList').addEventListener('contextmenu', e => {
  const el = e.target.closest('.album-item');
  if (!el) return;
  const a = S.albums.find(x => x.id === el.dataset.id);
  if (!a) return;
  e.preventDefault();
  openSourceMenu(el, albumItem(a));
});

$('#trackList').addEventListener('click', async e => {
  if (sortMode) return;               // 排序模式下只拖拽，不触发播放/按钮
  const a = S.current.album;
  if (e.target.closest('#btnFillSingle')) {
    if (!a) return;
    try {
      await window.deck.fillSingle(a.id);
      toast(`已按单曲填充：${a.title}`);
    } catch (err) { toast('填充失败：' + err.message); }
    return;
  }
  const iBtn = e.target.closest('[data-like-index]');
  if (iBtn) {
    const i = Number(iBtn.dataset.likeIndex);
    if (a && a.tracks && a.tracks[i]) await toggleLike(songItem(a, a.tracks[i], i));
    return;
  }
  const fBtn = e.target.closest('[data-fav-index]');
  if (fBtn) {
    e.stopPropagation();
    const i = Number(fBtn.dataset.favIndex);
    if (a && a.tracks && a.tracks[i]) openFavPicker(fBtn, songItem(a, a.tracks[i], i));
    return;
  }
  const hBtn = e.target.closest('[data-hide-index]');
  if (hBtn) {
    const i = Number(hBtn.dataset.hideIndex);
    if (!a || !a.tracks || !a.tracks[i]) return;
    const name = a.tracks[i].name;
    try {
      const r = await window.deck.toggleTrackHidden(a.id, i);
      toast(r.hidden ? `已隐藏「${name}」，播放时会跳过（点 ○ 可恢复）` : `已恢复「${name}」`);
    } catch (err) { toast('操作失败：' + err.message); }
    return;
  }
  const fLike = e.target.closest('[data-flike]');
  if (fLike) {
    const it = (activeFolder() && activeFolder().items || []).find(x => x.key === fLike.dataset.flike);
    if (it) await toggleLike(it);
    return;
  }
  const fFav = e.target.closest('[data-ffav]');
  if (fFav) {
    e.stopPropagation();
    const it = (activeFolder() && activeFolder().items || []).find(x => x.key === fFav.dataset.ffav);
    if (it) openFavPicker(fFav, it);
    return;
  }
  /* 专辑收藏夹：点专辑行展开 / 收起曲目 */
  const fExp = e.target.closest('[data-fexpand]');
  if (fExp) { toggleFavAlbum(fExp.dataset.fexpand); return; }

  /* 专辑收藏夹里展开的曲目行：红心 / 收藏 / 隐藏 / 播放 */
  const subRow = e.target.closest('.track-row[data-fat]');
  if (subRow) {
    const lib = favItemLib(subRow.dataset.fkey);
    const ti = Number(subRow.dataset.ti);
    if (!lib || !lib.tracks || !lib.tracks[ti]) return;
    const t = lib.tracks[ti];
    const likeBtn = e.target.closest('[data-fat-like]');
    if (likeBtn) { await toggleLike(songItem(lib, t, ti)); return; }
    const favBtn = e.target.closest('[data-fat-fav]');
    if (favBtn) { e.stopPropagation(); openFavPicker(favBtn, songItem(lib, t, ti)); return; }
    if (e.target.closest('[data-fat-hide]')) {
      try {
        const r = await window.deck.toggleTrackHidden(lib.id, ti);
        toast(r.hidden ? `已隐藏「${t.name}」，播放时会跳过（点 ○ 可恢复）` : `已恢复「${t.name}」`);
      } catch (err) { toast('操作失败：' + err.message); }
      return;
    }
    // 点曲目 → 以这个收藏夹为播放列表，播这一首
    const fv = activeFolder();
    if (!fv) return;
    await window.deck.playFolder(fv.id, {
      kind: 'song', bvid: lib.bvid, start: t.start, albumId: lib.id, trackIndex: ti,
      name: t.name, albumTitle: lib.title, duration: Math.max(0, (t.end || 0) - t.start)
    });
    return;
  }

  const fDel = e.target.closest('[data-fdel]');
  if (fDel) {
    const f = activeFolder(); if (!f) return;
    await window.deck.favRemove(f.id, fDel.dataset.fdel);
    toast('已从收藏夹移除');
    return;
  }
  const row = e.target.closest('.track-row');
  if (!row) return;
  if (viewMode === 'library') {
    if (!a) return;
    window.deck.playAt(a.id, Number(row.dataset.i));
  } else {
    const f = activeFolder();
    const it = f && (f.items || []).find(x => x.key === row.dataset.fkey);
    if (!it) return;
    // 按 bvid 找，避免专辑被重新导入后 id 变化导致收藏项失效
    const lib = S.albums.find(x => x.bvid === it.bvid) || S.albums.find(x => x.id === it.albumId);
    if (!lib) { toast('这张专辑已不在曲库：右键这一项可以查看来源或重新导入'); return; }
    if (it.kind === 'album') { toggleFavAlbum(it.key); return; }
    else await window.deck.playFolder(f.id, it);
  }
});
$('.bar').addEventListener('click', e => {
  const a = nowAlbum(), t = nowTrack(); if (!t || !t.end) return;
  const r = e.currentTarget.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  window.deck.seek(t.start + ratio * (t.end - t.start));
});

/* ---------- 粘贴时间戳 ---------- */

const SAMPLE = `On The Road(Demo1)00:00
我要的幸福01:25
坏天气05:01
零缺点09:32
开始懂了13:12
中间地带17:44
相信22:15
累赘26:46
难得一见30:01
害怕34:14
星期一天气晴我离开你38:17
On The Road(Demo2)42:37`;

$('#btnFillSample').addEventListener('click', () => {
  $('#pText').value = SAMPLE;
  $('#pBvid').value = 'BV1Tw411G74d';
  $('#pTitle').value = '孙燕姿 2000《我要的幸福》';
  updatePastePreview();
});

/** 读取视频自带的章节（播放器右下角「章」），填进时间戳框 */
$('#btnLoadChapters').addEventListener('click', async e => {
  const bv = extractBv($('#pBvid').value);
  if (!bv) { toast('先填视频链接或 BV 号，才能读取章节'); $('#pBvid').focus(); return; }
  const btn = e.currentTarget, old = btn.textContent;
  btn.disabled = true; btn.textContent = '读取章节中…';
  try {
    const tracks = await window.deck.chapters(bv);
    if (!tracks || !tracks.length) { toast('这个视频没有内嵌章节（UP 主可能没设置「章」）'); return; }
    $('#pText').value = tracks.map(t => `${t.name} ${fmt(t.start)}`).join('\n');
    if (!$('#pTitle').value.trim()) {
      const info = await window.deck.videoInfo(bv).catch(() => null);
      if (info) $('#pTitle').value = autoTitle(info.title);
    }
    await updatePastePreview();
    toast(`已从视频章节读取 ${tracks.length} 首`);
  } catch (err) { toast('读取章节失败：' + err.message); }
  finally { btn.disabled = false; btn.textContent = old; }
});

let pasteTimer;
$('#pText').addEventListener('input', () => { clearTimeout(pasteTimer); pasteTimer = setTimeout(updatePastePreview, 220); });
async function updatePastePreview() {
  const text = $('#pText').value.trim();
  if (!text) { $('#pPreview').innerHTML = ''; $('#parseInfo').textContent = ''; return; }
  try {
    const tracks = await window.deck.parseText(text, 0);
    $('#parseInfo').textContent = `识别到 ${tracks.length} 首`;
    $('#pPreview').innerHTML = tracks.slice(0, 40).map(t =>
      `<div class="preview-row"><span>${esc(t.name)}</span><span>${fmt(t.start)}</span></div>`).join('');
  } catch (e) { $('#parseInfo').textContent = e.message; }
}

function extractBv(s) { const m = String(s || '').match(/BV[0-9A-Za-z]{10}/); return m ? m[0] : null; }
function autoTitle(title) {
  const s = String(title || '').replace(/<[^>]+>/g, '').replace(/【[^】]*】/g, '').replace(/\s+/g, ' ').trim();
  const m = s.match(/《([^》]+)》/);
  if (m) {
    const before = s.slice(0, m.index);
    const artist = (before.match(/^[\u4e00-\u9fa5A-Za-z·]+/) || [''])[0];
    const year = (before.match(/(19|20)\d{2}/) || [''])[0];
    return [artist, year, `《${m[1]}》`].filter(Boolean).join(' ').slice(0, 48);
  }
  return s.replace(/超强音质.*$/, '').replace(/[|｜].*$/, '').replace(/[，,].*$/, '').trim().slice(0, 32);
}

/** 单曲兜底时的曲目名：直接用视频标题 */
function cleanTrackTitle(t) {
  return (String(t || '')
    .replace(/<[^>]+>/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\s+/g, ' ')
    .replace(/超强音质.*$/, '')
    .replace(/每天音乐专辑分享.*$/, '')
    .replace(/[|｜].*$/, '')
    .trim()
    .slice(0, 60)) || '完整视频';
}

$('#btnAddPaste').addEventListener('click', async () => {
  const bvid = extractBv($('#pBvid').value);
  if (!bvid) { toast('请填视频链接或 BV 号，否则无法跳转播放'); return; }
  const text = $('#pText').value.trim();
  let info = null;
  try { info = await window.deck.videoInfo(bvid); } catch (_) {}
  const duration = (info && info.duration) || 0;

  let tracks = text ? await window.deck.parseText(text, duration) : [];
  let fallback = false;
  if (!tracks.length) {
    // 没粘贴时间戳时，先试视频自带章节
    try {
      const chapters = await window.deck.chapters(bvid);
      if (chapters.length) tracks = chapters;
    } catch (_) { /* 忽略，继续兜底 */ }
  }
  if (!tracks.length) {
    // 再没有就整段视频当一首单曲，名字用视频标题
    tracks = [{ name: cleanTrackTitle(info && info.title), start: 0, end: duration }];
    fallback = true;
  }

  const album = {
    id: 'a_' + Date.now().toString(36),
    title: $('#pTitle').value.trim() || autoTitle(info && info.title) || bvid,
    bvid, aid: info && info.aid, duration, pic: info && info.pic,
    tracks, tracksOk: true
  };
  const r = await window.deck.addAlbums([album]);
  toast(r.added
    ? `已添加「${album.title}」· ${tracks.length} 首${fallback ? '（整段单曲）' : ''}`
    : '这张专辑已经在曲库里了');
  closeModal('importModal');
  $('#pText').value = ''; $('#pPreview').innerHTML = ''; $('#parseInfo').textContent = '';
});

/* ---------- 链接 / 合集导入 ---------- */

$$('.link-chip').forEach(b => b.addEventListener('click', () => {
  $('#linkInput').value = b.dataset.link;
  switchTab('link');
  resolveLink();
}));

$('#btnResolve').addEventListener('click', resolveLink);
$('#linkInput').addEventListener('keydown', e => { if (e.key === 'Enter') resolveLink(); });

async function resolveLink() {
  const input = $('#linkInput').value.trim();
  if (!input) return;
  $('#resolveInfo').textContent = '正在解析…';
  try {
    const r = await window.deck.resolve(input);
    curMid = r.mid || null;
    let label = '';
    if (r.kind === 'video') label = `视频：${r.info ? esc(autoTitle(r.info.title)) : ''}${r.seasonId ? '　· 可点下方展开同合集' : ''}`;
    if (r.kind === 'season' || r.kind === 'series') label = `合集 / 系列：共 ${r.archives.length} 个视频`;
    if (r.kind === 'space') label = `UP 主空间：${r.seasons.length} 个合集，最近 ${r.archives.length} 个视频`;
    if (r.kind === 'search') { switchTab('search'); $('#searchInput').value = r.keyword; $('#searchInfo').textContent = '已切到搜索，点「搜索」继续'; $('#resolveInfo').textContent = ''; return; }
    $('#resolveInfo').innerHTML = label || '解析完成';
    const chips = (r.seasons || []).map(s =>
      `<button class="season-chip" data-mid="${r.mid}" data-id="${s.id}" data-type="${s.type}" title="${esc(s.title)}">${esc(s.title)} · ${s.count || ''}</button>`);
    if (r.kind === 'video' && r.seasonId && r.mid) {
      chips.unshift(`<button class="season-chip hot" data-mid="${r.mid}" data-id="${r.seasonId}" data-type="season">＋ 展开同合集的全部专辑</button>`);
    }
    $('#seasonChips').innerHTML = chips.join('');

    if (r.kind === 'multi' && r.bvids.length) {
      const infos = await Promise.all(r.bvids.map(bv => window.deck.videoInfo(bv).catch(() => null)));
      setCandidates(infos.filter(Boolean).map(v => ({ bvid: v.bvid, aid: v.aid, title: v.title, duration: v.duration, pic: v.pic })));
    } else if (r.archives && r.archives.length) {
      let list = r.archives;
      // 单个视频链接：把用户粘贴的那张专辑排在最前、默认勾选
      if (r.kind === 'video' && r.info) {
        const i = list.findIndex(x => x.bvid === r.info.bvid);
        if (i > 0) { const hit = list.splice(i, 1)[0]; list = [hit, ...list]; }
        else if (i < 0) list = [{ bvid: r.info.bvid, aid: r.info.aid, title: r.info.title, duration: r.info.duration, pic: r.info.pic }, ...list];
        setCandidates(list);
        selected = new Set([r.info.bvid]);
        renderCandidates();
      } else setCandidates(list);
    } else if (r.info) {
      setCandidates([{ bvid: r.info.bvid, aid: r.info.aid, title: r.info.title, duration: r.info.duration, pic: r.info.pic }]);
    } else { setCandidates([]); }
  } catch (e) {
    $('#resolveInfo').textContent = '解析失败：' + e.message;
  }
}

$('#seasonChips').addEventListener('click', async e => {
  const b = e.target.closest('.season-chip'); if (!b) return;
  $('#resolveInfo').textContent = '正在读取合集…';
  try {
    const list = await window.deck.season({ mid: Number(b.dataset.mid), id: Number(b.dataset.id), type: b.dataset.type });
    curMid = Number(b.dataset.mid);
    setCandidates(list);
    $('#resolveInfo').textContent = `${esc(b.textContent)}　共 ${list.length} 个视频`;
  } catch (err) { $('#resolveInfo').textContent = '读取失败：' + err.message; }
});

function setCandidates(list) {
  candidates = list || [];
  selected = new Set(candidates.length <= 20 ? candidates.map(c => c.bvid) : []);
  renderCandidates();
  $('#candidateWrap').hidden = !candidates.length;
  $('#btnBuild').disabled = !candidates.length;
  if ($('#btnBuildFav')) $('#btnBuildFav').disabled = !candidates.length;
  $('#buildHint').textContent = candidates.length > 60
    ? `共 ${candidates.length} 个视频，先用上面的过滤框筛选再勾选（例如输入「孙燕姿」）`
    : '勾选视频后，会自动读取置顶评论里的曲目时间戳';
}

function renderCandidates() {
  const q = ($('#candFilter').value || '').trim().toLowerCase();
  const list = candidates.filter(c => !q || (c.title || '').toLowerCase().includes(q)).slice(0, 300);
  $('#candCount').textContent = `已选 ${selected.size} / ${candidates.length}`;
  $('#candidateList').innerHTML = list.map(c =>
    `<label class="cand-row"><input type="checkbox" data-bv="${esc(c.bvid)}" ${selected.has(c.bvid) ? 'checked' : ''}>
     <span class="t">${esc(c.title)}</span><span class="d">${fmt(c.duration || 0)}</span></label>`).join('')
    || `<div class="empty" style="height:70px">没有匹配的视频</div>`;
}
$('#candFilter').addEventListener('input', renderCandidates);
$('#candidateList').addEventListener('change', e => {
  if (!e.target.matches('input[type=checkbox]')) return;
  const bv = e.target.dataset.bv;
  if (e.target.checked) selected.add(bv); else selected.delete(bv);
  $('#candCount').textContent = `已选 ${selected.size} / ${candidates.length}`;
});
$('#btnSelAll').addEventListener('click', () => {
  const q = ($('#candFilter').value || '').trim().toLowerCase();
  candidates.filter(c => !q || (c.title || '').toLowerCase().includes(q)).forEach(c => selected.add(c.bvid));
  renderCandidates();
});
$('#btnSelNone').addEventListener('click', () => { selected.clear(); renderCandidates(); });

/** 勾选 → 抓时间戳 → 建专辑 → 入库；folderId 有值时顺带把曲目放进这个收藏夹 */
async function runBuildImport(folderId) {
  const chosen = candidates.filter(c => selected.has(c.bvid));
  if (!chosen.length) { toast('先勾选要导入的视频'); return; }
  if (chosen.length > 60) { toast('一次最多导入 60 张专辑，请先用过滤框分批勾选，避免 B 站限流'); return; }
  const folder = folderId ? allFolders().find(f => f.id === folderId) : null;
  const b1 = $('#btnBuild'), b2 = $('#btnBuildFav');
  b1.disabled = true; if (b2) b2.disabled = true;
  $('#importProgress').hidden = false;
  $('#importProgress').innerHTML = `<div class="pbar"><i style="width:0%"></i></div><div class="line">准备抓取…</div>`;
  try {
    const built = await window.deck.build(chosen);
    const r = await window.deck.addAlbums(built);
    const fromChapter = built.filter(a => a.tracksSource === 'chapter').length;

    // 放进收藏夹：歌曲夹按曲目逐条放，专辑夹按整张放
    let favText = '';
    if (folder) {
      const idOf = (r && r.ids) || {};
      const items = [];
      for (const a of built) {
        const albumId = idOf[a.bvid];
        if (!albumId) continue;
        if (folder.type === 'album') {
          items.push({ kind: 'album', bvid: a.bvid, title: a.title, albumId, duration: a.duration || 0 });
        } else {
          (a.tracks || []).forEach((t, i) => items.push({
            kind: 'song', bvid: a.bvid, start: t.start, name: t.name, albumTitle: a.title,
            albumId, trackIndex: i, duration: Math.max(0, (t.end || 0) - t.start)
          }));
        }
      }
      if (items.length) {
        const fr = await window.deck.favAddMany(folder.id, items);
        favText = `，放进「${folder.name}」${fr.added} 项`;
      }
    }

    toast(`导入完成：新增 ${r.added} 张专辑，共 ${built.filter(a => a.tracksOk).length} 张带曲目表`
      + (fromChapter ? `（${fromChapter} 张来自视频章节）` : '') + favText);
    $('#importProgress').innerHTML = `<div class="pbar"><i style="width:100%"></i></div><div class="line">完成 · 新增 ${r.added} 张${favText}</div>`;
    setTimeout(() => closeModal('importModal'), 900);
  } catch (e) { toast('导入失败：' + e.message); }
  finally { b1.disabled = false; if (b2) b2.disabled = false; }
}

/** 导入到收藏夹：先选夹子（或新建），选完立刻开始导入 */
function openImportFolderPicker(anchor) {
  const chosen = candidates.filter(c => selected.has(c.bvid));
  if (!chosen.length) { toast('先勾选要导入的视频'); return; }
  const songs = allFolders().filter(f => f.type !== 'album');
  const albs = allFolders().filter(f => f.type === 'album');
  let html = `<div class="pop-head">导入到收藏夹（已选 ${chosen.length} 个视频）</div>`;
  html += songs.map(f => `<button class="pop-item" data-imp-fid="${esc(f.id)}">
    <span class="pi-ico">${f.builtin ? '♥' : '♡'}</span>${esc(f.name)}
    <span class="pi-count">${(f.items || []).length}</span></button>`).join('');
  if (albs.length) {
    html += `<div class="pop-head" style="border-top:1px solid var(--line);margin-top:4px;padding-top:6px">专辑收藏夹</div>`;
    html += albs.map(f => `<button class="pop-item" data-imp-fid="${esc(f.id)}">
      <span class="pi-ico">▤</span>${esc(f.name)}
      <span class="pi-count">${(f.items || []).length}</span></button>`).join('');
  }
  html += `<button class="pop-item new" data-imp-new="1">＋ 新建收藏夹并导入</button>`;
  showPop(anchor, html);
}

$('#btnBuild').addEventListener('click', () => runBuildImport(null));
$('#btnBuildFav').addEventListener('click', e => {
  e.stopPropagation();
  openImportFolderPicker(e.currentTarget);
});

window.deck.onImportProgress(p => {
  const box = $('#importProgress');
  if (!box || box.hidden) return;
  const pct = Math.round(p.done / Math.max(1, p.total) * 100);
  const src = p.source === 'chapter' ? '（视频章节）'
    : p.source === 'comment' ? '（评论区）'
    : p.source === 'single' ? '（单曲）' : '';
  box.innerHTML = `<div class="pbar"><i style="width:${pct}%"></i></div>`
    + `<div class="line">${p.done}/${p.total} · ${esc(p.title)} → ${p.tracks} 首 ${p.ok ? src : '（未找到时间戳）'}</div>`;
});

/* ---------- 关键词搜索 ---------- */
$('#btnSearch').addEventListener('click', async () => {
  const kw = $('#searchInput').value.trim(); if (!kw) return;
  $('#searchInfo').textContent = '搜索中…';
  try {
    const list = await window.deck.search(kw);
    switchTab('link');
    setCandidates(list);
    $('#resolveInfo').textContent = `搜索「${esc(kw)}」得到 ${list.length} 个视频，勾选后可批量导入`;
    $('#searchInfo').textContent = `找到 ${list.length} 个结果，已放入「B 站链接」标签页`;
  } catch (e) { $('#searchInfo').textContent = '搜索失败：' + e.message; }
});
$('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnSearch').click(); });

/* ---------- 设置 ---------- */

const HK_LABELS = {
  prevTrack: '上一首', nextTrack: '下一首', prevAlbum: '上一张专辑', nextAlbum: '下一张专辑',
  togglePlay: '播放 / 暂停', replay: '重播本首', toggleMain: '显示 / 隐藏主窗口', toggleMini: '迷你悬浮窗'
};

function fillSettings() {
  const s = S.settings, hk = s.hotkeys || {};
  $('#sPort').value = s.port || 9222;
  $('#sBrowser').value = s.browserPath || '';
  $('#sPrefer360p').checked = s.prefer360p !== false;
  $('#sAlbumClickPlay').checked = s.albumClickPlay !== false;
  $('#sSkipHidden').checked = s.skipHidden !== false;
  $('#sMini').checked = !!s.miniVisible;
  $('#sMiniEdgeHide').checked = s.miniEdgeHide !== false;
  const pk = Math.max(1, Math.min(16, Number(s.miniPeek) || 3));
  $('#sMiniPeek').value = String(pk);
  $('#sMiniPeekVal').textContent = pk + ' px';
  miniStyleChoice = s.miniStyle || 'full';
  $$('[data-mini-style]').forEach(b => b.classList.toggle('active', b.dataset.miniStyle === miniStyleChoice));
  $('#hotkeyGrid').innerHTML = Object.entries(HK_LABELS).map(([k, label]) =>
    `<label>${label}<input data-hk="${k}" value="${esc(hk[k] || '')}" placeholder="Ctrl+Alt+..."></label>`).join('');
  window.deck.getSettings().then(x => {
    $('#hotkeyErrors').textContent = (x.hotkeyErrors || []).length ? '⚠ 快捷键注册失败：' + x.hotkeyErrors.join('；') : '';
    if (!s.browserPath && x.browserFound) $('#sBrowser').placeholder = '自动检测：' + x.browserFound;
  }).catch(() => {});
}

$('#btnSaveSettings').addEventListener('click', async () => {
  const hotkeys = {};
  $$('[data-hk]').forEach(i => hotkeys[i.dataset.hk] = i.value.trim());
  try {
    await window.deck.setSettings({
      port: Number($('#sPort').value) || 9222,
      browserPath: $('#sBrowser').value.trim(),
      prefer360p: $('#sPrefer360p').checked,
      albumClickPlay: $('#sAlbumClickPlay').checked,
      skipHidden: $('#sSkipHidden').checked,
      miniVisible: $('#sMini').checked,
      miniStyle: miniStyleChoice,
      miniEdgeHide: $('#sMiniEdgeHide').checked,
      miniPeek: Number($('#sMiniPeek').value) || 3,
      hotkeys
    });
    closeModal('settingsModal');
    toast('设置已保存');
  } catch (e) { toast('保存失败：' + e.message); }
});
$('#sMiniPeek').addEventListener('input', e => {
  const v = Math.max(1, Math.min(16, Number(e.target.value) || 3));
  $('#sMiniPeekVal').textContent = v + ' px';
  // 立刻生效：收起状态下会按新宽度重新贴边
  window.deck.setSettings({ miniPeek: v }).catch(() => {});
});
$$('[data-mini-style]').forEach(b => b.addEventListener('click', () => {
  miniStyleChoice = b.dataset.miniStyle;
  $$('[data-mini-style]').forEach(x => x.classList.toggle('active', x === b));
}));
$('#btnResetHk').addEventListener('click', () => {
  const d = { prevTrack: 'Ctrl+Alt+Left', nextTrack: 'Ctrl+Alt+Right', prevAlbum: 'Ctrl+Alt+Shift+Left', nextAlbum: 'Ctrl+Alt+Shift+Right', togglePlay: 'Ctrl+Alt+Space', replay: 'Ctrl+Alt+R', toggleMain: 'Ctrl+Alt+M', toggleMini: 'Ctrl+Alt+N' };
  $$('[data-hk]').forEach(i => i.value = d[i.dataset.hk]);
});
$('#btnPickBrowser').addEventListener('click', async () => { const p = await window.deck.pickBrowser(); if (p) $('#sBrowser').value = p; });
$('#btnOpenData').addEventListener('click', () => window.deck.openDataDir());
$('#btnImportFile').addEventListener('click', async () => { const n = await window.deck.importFile(); if (n) toast(`已导入 ${n} 张专辑`); });
$('#btnResetSeed').addEventListener('click', async () => { await window.deck.resetSeed(); toast('已恢复示例曲库'); closeModal('settingsModal'); });
$('#btnQuit').addEventListener('click', () => window.deck.quit());

/* ---------- 编辑专辑 ---------- */

$('#btnEditAlbum').addEventListener('click', () => {
  const a = nowAlbum(); if (a) openEditAlbum(a);
});
$('#btnEditChapters').addEventListener('click', async e => {
  const cur = S.albums.find(x => x.id === editingId);
  const bv = extractBv($('#eBvid').value) || (cur && cur.bvid);
  if (!bv) { toast('先填 BV 号'); return; }
  const btn = e.currentTarget, old = btn.textContent;
  btn.disabled = true; btn.textContent = '读取中…';
  try {
    const tracks = await window.deck.chapters(bv);
    if (!tracks.length) { toast('这个视频没有内嵌章节'); return; }
    $('#eText').value = tracks.map(t => `${t.name} ${fmt(t.start)}`).join('\n');
    toast(`已读取 ${tracks.length} 个章节，确认后点保存`);
  } catch (err) { toast('读取失败：' + err.message); }
  finally { btn.disabled = false; btn.textContent = old; }
});

$('#btnSaveAlbum').addEventListener('click', async () => {
  const a = S.albums.find(x => x.id === editingId); if (!a) return;
  const bv = extractBv($('#eBvid').value) || a.bvid;
  let duration = a.duration || 0;
  if (bv !== a.bvid) { try { const i = await window.deck.videoInfo(bv); duration = i.duration; } catch (_) {} }
  const tracks = await window.deck.parseText($('#eText').value, duration);
  if (!tracks.length) { toast('没有识别到时间戳'); return; }
  await window.deck.updateAlbum(editingId, { title: $('#eTitle').value.trim() || a.title, bvid: bv, duration, tracks, tracksOk: true });
  closeModal('editModal'); toast('已保存曲目表');
});
$('#btnDeleteAlbum').addEventListener('click', async () => {
  await window.deck.deleteAlbum(editingId);
  closeModal('editModal'); toast('已删除');
});

/* ---------- 红心 / 收藏夹交互 ---------- */

async function toggleLike(item) {
  try {
    const r = await window.deck.favLike(item);
    toast(r.liked ? `♥ 已加入「喜欢」：${item.name}` : `已从「喜欢」移除：${item.name}`);
  } catch (e) { toast('操作失败：' + e.message); }
}

$('#btnLikeNow').addEventListener('click', async () => {
  const a = nowAlbum(), t = nowTrack();
  if (!a || !t) return;
  await toggleLike(songItem(a, t, S.current.trackIndex || 0));
});
$('#btnFavNow').addEventListener('click', e => {
  e.stopPropagation();
  const a = nowAlbum(), t = nowTrack();
  if (!a || !t) return;
  openFavPicker(e.currentTarget, songItem(a, t, S.current.trackIndex || 0));
});

/* ---------- 弹出菜单 ---------- */

function showPop(anchor, html) {
  const m = $('#popMenu');
  m.innerHTML = html;
  m.classList.add('show');
  popAnchor = (anchor && anchor.isConnected) ? anchor : document.body;
  popShownAt = Date.now();
  // 锚点可能因轮询重绘而脱离 DOM，此时退回到视口中心，避免浮层跑到左上角看不见
  const r = (anchor && anchor.isConnected)
    ? anchor.getBoundingClientRect()
    : { left: window.innerWidth / 2 - 100, right: window.innerWidth / 2 - 80,
        top: window.innerHeight / 2 - 20, bottom: window.innerHeight / 2 };
  const w = m.offsetWidth, h = m.offsetHeight;
  const x = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
  let y = r.bottom + 6;
  if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 6);
  m.style.left = x + 'px';
  m.style.top = y + 'px';
}
function hidePop() {
  $('#popMenu').classList.remove('show');
  popItem = null; popFolder = null; popAction = null; popAnchor = null;
}
document.addEventListener('click', e => {
  if (e.target.closest('#popMenu')) return;
  // 双保险：刚弹出的确认浮层，不能被触发它的那一次点击顺带关掉
  if (Date.now() - popShownAt < 200) return;
  hidePop();
});

function openFavPicker(anchor, item) {
  const type = item.kind === 'album' ? 'album' : 'song';
  const key = type === 'album' ? albumKey(item.bvid) : songKey(item.bvid, item.start);
  const list = allFolders().filter(f => f.type === type);
  let html = `<div class="pop-head">收藏到${type === 'album' ? '专辑' : '歌曲'}收藏夹</div>`;
  html += list.map(f => {
    const has = (f.items || []).some(x => x.key === key);
    return `<button class="pop-item${has ? ' on' : ''}" data-pick-fid="${esc(f.id)}">
    <span class="pi-ico">${has ? '✓' : (f.type === 'album' ? '▤' : (f.builtin ? '♥' : '♡'))}</span>${esc(f.name)}
    <span class="pi-count">${has ? '已收藏 · ' : ''}${(f.items || []).length}</span></button>`;
  }).join('');
  if (!list.length) html += `<div class="pop-empty">还没有${type === 'album' ? '专辑' : '歌曲'}收藏夹，新建一个吧</div>`;
  html += `<button class="pop-item new" data-pick-new="1">＋ 新建收藏夹并加入</button>`;
  showPop(anchor, html);
  popItem = item;
}

function openAlbumMore(anchor, a) {
  showPop(anchor, `<div class="pop-head">${esc(a.title)}</div>
    <button class="pop-item" data-am="play"><span class="pi-ico">▶</span>播放这张专辑</button>
    <button class="pop-item" data-am="chapters"><span class="pi-ico">⧉</span>从视频章节补全曲目</button>
    <button class="pop-item" data-am="edit"><span class="pi-ico">✎</span>编辑曲目 / 专辑名</button>
    <button class="pop-item danger" data-am="delete"><span class="pi-ico">✕</span>删除这张专辑</button>`);
  popItem = albumItem(a);
}

/** 读取视频自带章节并写入专辑曲目表 */
async function fillTracksFromChapters(a) {
  toast('正在读取视频章节…');
  try {
    const tracks = await window.deck.chapters(a.bvid);
    if (!tracks.length) { toast('这个视频没有内嵌章节（UP 主可能没设置「章」）'); return; }
    await window.deck.updateAlbum(a.id, { tracks, tracksOk: true, duration: a.duration || 0 });
    toast(`已用 ${tracks.length} 个章节补全「${a.title}」`);
  } catch (e) { toast('读取章节失败：' + e.message); }
}

function openFolderMore(anchor, f) {
  showPop(anchor, `<div class="pop-head">${esc(f.name)} · ${f.type === 'album' ? '专辑' : '歌曲'}收藏夹</div>
    <button class="pop-item" data-fm="rename"><span class="pi-ico">✎</span>重命名</button>
    <button class="pop-item" data-fm="clear"><span class="pi-ico">⌫</span>清空内容</button>
    ${f.builtin ? '' : '<button class="pop-item danger" data-fm="delete"><span class="pi-ico">✕</span>删除收藏夹</button>'}
    <button class="pop-item new" data-fm="create">＋ 新建收藏夹</button>`);
  popFolder = f;
}

function showConfirm(anchor, title, desc, fn) {
  showPop(anchor, `<div class="pop-head">${esc(title)}</div><div class="pop-empty">${esc(desc)}</div>
    <button class="pop-item danger" data-confirm="1">确认</button>
    <button class="pop-item" data-confirm="0">取消</button>`);
  popAction = fn;
}

$('#popMenu').addEventListener('click', async e => {
  // 关键：菜单项被点击后 showConfirm 会替换 popMenu 的 innerHTML，
  // 原按钮脱离 DOM，事件冒泡到 document 时 closest('#popMenu') 会失效，
  // 从而把刚弹出的确认框误关掉。这里阻止冒泡，由各分支自行 hidePop()。
  e.stopPropagation();
  const c = e.target.closest('[data-confirm]');
  if (c) {
    const fn = popAction, yes = c.dataset.confirm === '1';
    hidePop(); if (yes && fn) await fn(); return;
  }
  const miniAct = e.target.closest('[data-mini]');
  if (miniAct) {
    const act = miniAct.dataset.mini;
    hidePop();
    if (act === 'toggle') { window.deck.toggleMini(); return; }
    if (act === 'left' || act === 'right') {
      try {
        await window.deck.collapseMini(act);
        toast(act === 'left' ? '已收起到屏幕左侧，鼠标移到左边会自动滑出' : '已收起到屏幕右侧，鼠标移到右边会自动滑出');
      } catch (err) { toast('收起失败：' + err.message); }
      return;
    }
    try {
      await window.deck.setSettings({ miniStyle: act });
      toast(act === 'compact' ? '已切换为简洁长条'
        : act === 'vertical' ? '已切换为 MP3 样式' : '已切换为完整样式');
    } catch (err) { toast('切换失败：' + err.message); }
    return;
  }
  const pm = e.target.closest('[data-pm]');
  if (pm) {
    const key = pm.dataset.pm;
    hidePop();
    try {
      await window.deck.setPlayMode(key);
      queueSig = '';
      const m = (S.playModes || []).find(x => x.key === key);
      toast(`播放顺序：${m ? m.label : key}`);
    } catch (err) { toast('切换失败：' + err.message); }
    return;
  }
  const sa = e.target.closest('[data-sortalb]');
  if (sa) {
    const by = sa.dataset.sortalb;
    hidePop();
    try {
      await window.deck.sortAlbums(by);
      sideSig = '';
      toast(`已按${by === 'name' ? '歌名' : by === 'year' ? '时间' : '歌手'}排序`);
    } catch (err) { toast('排序失败：' + err.message); }
    return;
  }
  const fsrc = e.target.closest('[data-fsrc]');
  if (fsrc) {
    const act = fsrc.dataset.fsrc, it = popItem;
    if (!it) { hidePop(); return; }
    const url = `https://www.bilibili.com/video/${it.bvid}/`;
    if (act === 'open') { hidePop(); window.deck.openExternal(url); return; }
    if (act === 'copy') {
      hidePop();
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('已复制：' + url); } catch (_) { toast(url); }
      ta.remove();
      return;
    }
    if (act === 'goto') {
      hidePop();
      const a = S.albums.find(x => x.bvid === it.bvid) || S.albums.find(x => x.id === it.albumId);
      if (!a) { toast('这张专辑已不在曲库，右键可以重新导入'); return; }
      await jumpToAlbum(a);
      return;
    }
    if (act === 'reimport') {
      hidePop();
      toast('正在重新导入…');
      try {
        const r = await window.deck.reimport(it.bvid);
        listSig = ''; sideSig = ''; render();
        toast(`已${r.existed ? '刷新' : '重新导入'}「${r.title}」：${r.tracks} 首`
          + `，修好 ${r.fixed} 项收藏` + (r.lost ? `，${r.lost} 首在新曲目表里没找到` : ''));
      } catch (err) { toast('重新导入失败：' + err.message); }
      return;
    }
  }
  const impFid = e.target.closest('[data-imp-fid]');
  if (impFid) {
    const fid = impFid.dataset.impFid;
    hidePop();
    runBuildImport(fid);
    return;
  }
  const impNew = e.target.closest('[data-imp-new]');
  if (impNew) {
    hidePop();
    pendingImportFolder = true;
    openFolderModal({ mode: 'create', type: 'song' });
    return;
  }
  const pick = e.target.closest('[data-pick-fid]');
  if (pick) {
    const fid = pick.dataset.pickFid, it = popItem;
    hidePop();
    if (it) {
      const key = it.kind === 'album' ? albumKey(it.bvid) : songKey(it.bvid, it.start);
      const f = allFolders().find(x => x.id === fid);
      const has = !!(f && (f.items || []).some(x => x.key === key));
      try {
        // 已经在里面 → 再点一次就是取消收藏
        if (has) {
          await window.deck.favRemove(fid, key);
          toast(`已从「${f ? f.name : ''}」取消收藏`);
        } else {
          const r = await window.deck.favAdd(fid, it);
          toast(r.added ? `已收藏到「${f ? f.name : ''}」` : '已经在这个收藏夹里了');
        }
      } catch (err) { toast('操作失败：' + err.message); }
    }
    return;
  }
  const create = e.target.closest('[data-pick-new]');
  if (create) {
    const it = popItem;
    hidePop();
    openFolderModal({ mode: 'create', type: it && it.kind === 'album' ? 'album' : 'song', pendingItem: it });
    return;
  }
  const am = e.target.closest('[data-am]');
  if (am) {
    const it = popItem, anchor = popAnchor, action = am.dataset.am;
    hidePop();
    const a = S.albums.find(x => x.bvid === (it && it.bvid)) || S.albums.find(x => x.id === (it && it.albumId));
    if (!a) return;
    if (action === 'play') window.deck.playAt(a.id, 0);
    if (action === 'edit') openEditAlbum(a);
    if (action === 'chapters') {
      if ((a.tracks || []).length === 0) { fillTracksFromChapters(a); return; }
      showConfirm(anchor, '用视频章节覆盖曲目表？',
        `「${a.title}」现有 ${a.tracks.length} 首，将替换为视频自带的章节列表。`,
        () => fillTracksFromChapters(a));
    }
    if (action === 'delete') {
      showConfirm(anchor, '删除专辑？', `「${a.title}」及其曲目表会从资料库删除，此操作不可撤销。`, async () => {
        await window.deck.deleteAlbum(a.id);
        sideSig = ''; listSig = ''; render(); toast('已删除专辑');
      });
    }
    return;
  }
  const fm = e.target.closest('[data-fm]');
  if (fm) {
    const f = popFolder, anchor = popAnchor, action = fm.dataset.fm;
    hidePop();
    if (action === 'create') { openFolderModal({ mode: 'create', type: f ? f.type : 'song' }); return; }
    if (!f) return;
    if (action === 'rename') openFolderModal({ mode: 'rename', folderId: f.id, name: f.name });
    if (action === 'clear') showConfirm(anchor, '清空收藏夹？', `「${f.name}」里的 ${(f.items || []).length} 项会被移除，收藏夹本身保留。`, async () => {
      await window.deck.favClear(f.id); toast('已清空');
    });
    if (action === 'delete') showConfirm(anchor, '删除收藏夹？', `「${f.name}」及其内容会被删除，此操作不可撤销。`, async () => {
      await window.deck.favDelete(f.id);
      if (activeFolderId === f.id) activeFolderId = LIKED_ID;
      sideSig = ''; listSig = ''; render(); toast('已删除收藏夹');
    });
  }
});

/* ---------- 新建 / 重命名收藏夹 ---------- */

function openFolderModal({ mode = 'create', type = 'song', folderId = null, name = '', pendingItem = null }) {
  folderModalMode = mode; folderModalType = type; folderEditingId = folderId; pendingAddItem = pendingItem;
  $('#folderModalTitle').textContent = mode === 'rename' ? '重命名收藏夹' : '新建收藏夹';
  $('#fName').value = name;
  $('#fTypeWrap').style.display = mode === 'rename' ? 'none' : '';
  $('#btnSaveFolder').textContent = mode === 'rename' ? '保存' : '创建';
  $$('.type-choice').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  $('#fHint').textContent = pendingItem
    ? `创建后会自动把「${pendingItem.name || pendingItem.title}」加进去。`
    : '歌曲收藏夹放单曲，专辑收藏夹放整张专辑；内置「喜欢」不可删除。';
  openModal('folderModal');
  setTimeout(() => $('#fName').focus(), 60);
}
$$('.type-choice').forEach(b => b.addEventListener('click', () => {
  folderModalType = b.dataset.type;
  $$('.type-choice').forEach(x => x.classList.toggle('active', x === b));
}));
$('#btnSaveFolder').addEventListener('click', saveFolder);
$('#fName').addEventListener('keydown', e => { if (e.key === 'Enter') saveFolder(); });
async function saveFolder() {
  const name = $('#fName').value.trim();
  if (!name) { toast('请填收藏夹名称'); return; }
  try {
    if (folderModalMode === 'rename') {
      await window.deck.favRename({ id: folderEditingId, name });
      toast('已重命名');
    } else {
      const f = await window.deck.favCreate({ name, type: folderModalType });
      // 「导入到收藏夹」新建的夹子：建完直接开始导入
      if (pendingImportFolder) {
        pendingImportFolder = false;
        closeModal('folderModal');
        sideSig = ''; listSig = ''; render();
        runBuildImport(f.id);
        return;
      }
      activeFolderId = f.id;
      viewMode = 'folder';
      if (pendingAddItem) await window.deck.favAdd(f.id, pendingAddItem);
      toast(`已创建「${f.name}」${pendingAddItem ? '并加入内容' : ''}`);
    }
  } catch (e) { toast('操作失败：' + e.message); return; }
  closeModal('folderModal');
  sideSig = ''; listSig = ''; render();
}

/* ---------- 收藏夹工具条 ---------- */

$('#btnFolderRename').addEventListener('click', () => {
  const f = activeFolder(); if (f) openFolderModal({ mode: 'rename', folderId: f.id, name: f.name });
});
$('#btnFolderClear').addEventListener('click', e => {
  e.stopPropagation();
  const f = activeFolder(); if (!f) return;
  showConfirm($('#btnFolderClear'), '清空收藏夹？', `「${f.name}」里的 ${(f.items || []).length} 项会被移除，收藏夹本身保留。`,
    async () => { await window.deck.favClear(f.id); toast('已清空'); });
});
$('#btnFolderDelete').addEventListener('click', e => {
  e.stopPropagation();
  const f = activeFolder(); if (!f || f.builtin) return;
  showConfirm($('#btnFolderDelete'), '删除收藏夹？', `「${f.name}」及其内容会被删除，此操作不可撤销。`, async () => {
    await window.deck.favDelete(f.id);
    activeFolderId = LIKED_ID; sideSig = ''; listSig = ''; render(); toast('已删除收藏夹');
  });
});

/* ---------- 加入单曲（资料库） ---------- */

$('#btnAddTrack').addEventListener('click', () => {
  const a = S.current.album;
  if (!a) { toast('先选一张专辑'); return; }
  $('#tAlbumName').textContent = `加到：${a.title} · 现有 ${(a.tracks || []).length} 首`;
  $('#tName').value = ''; $('#tStart').value = '';
  openModal('trackModal');
  setTimeout(() => $('#tName').focus(), 60);
});
$('#btnSaveTrack').addEventListener('click', async () => {
  const a = S.current.album; if (!a) return;
  const name = $('#tName').value.trim(), start = $('#tStart').value.trim();
  if (!name || !start) { toast('歌名和起始时间都要填'); return; }
  try {
    const n = await window.deck.addTrack({ albumId: a.id, name, start });
    closeModal('trackModal');
    toast(`已加入「${name}」，现在共 ${n} 首`);
  } catch (e) { toast('加入失败：' + e.message); }
});
$('#tStart').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnSaveTrack').click(); });

/* ---------- 从曲库批量加入收藏夹 ---------- */

function buildPickItems(f) {
  if (f.type === 'album') {
    return S.albums.map(a => ({ ...albumItem(a), key: albumKey(a.bvid), _label: a.title, _sub: '', _dur: fmt(a.duration || 0) }));
  }
  const out = [];
  S.albums.forEach(a => (a.tracks || []).forEach((t, i) => {
    const it = songItem(a, t, i);
    out.push({ ...it, key: songKey(a.bvid, t.start), _label: t.name, _sub: a.title, _dur: fmt(it.duration) });
  }));
  return out;
}
function renderPickList() {
  const q = ($('#pickSearch').value || '').trim().toLowerCase();
  const list = pickItems.filter(it => !q || it._label.toLowerCase().includes(q) || (it._sub || '').toLowerCase().includes(q)).slice(0, 300);
  $('#pickCount').textContent = `已选 ${pickSelected.size} / ${pickItems.length}`;
  $('#pickHint').textContent = `曲库共 ${pickItems.length} 项可选，勾选后加入`;
  $('#pickList').innerHTML = list.length
    ? `<div class="pick-group">搜索结果 · ${list.length} 项</div>` + list.map(it =>
      `<label class="pick-row"><input type="checkbox" data-pk="${esc(it.key)}" ${pickSelected.has(it.key) ? 'checked' : ''}>
       <span class="pt">${esc(it._label)}</span><span class="pa">${esc(it._sub || '')}</span><span class="pd">${it._dur}</span></label>`).join('')
    : `<div class="empty" style="height:120px">没有匹配的内容</div>`;
}
$('#btnPickItems').addEventListener('click', () => {
  const f = activeFolder(); if (!f) return;
  pickItems = buildPickItems(f); pickSelected = new Set();
  $('#pickTitle').textContent = f.type === 'album' ? `加入专辑到「${f.name}」` : `加入单曲到「${f.name}」`;
  $('#pickSearch').value = '';
  renderPickList(); openModal('pickModal');
});
$('#pickSearch').addEventListener('input', renderPickList);
$('#pickList').addEventListener('change', e => {
  if (!e.target.matches('input[type=checkbox]')) return;
  const k = e.target.dataset.pk;
  if (e.target.checked) pickSelected.add(k); else pickSelected.delete(k);
  $('#pickCount').textContent = `已选 ${pickSelected.size} / ${pickItems.length}`;
});
$('#btnPickAll').addEventListener('click', () => {
  const q = ($('#pickSearch').value || '').trim().toLowerCase();
  pickItems.filter(it => !q || it._label.toLowerCase().includes(q) || (it._sub || '').toLowerCase().includes(q))
    .slice(0, 300).forEach(it => pickSelected.add(it.key));
  renderPickList();
});
$('#btnSavePick').addEventListener('click', async () => {
  const f = activeFolder(); if (!f) return;
  const chosen = pickItems.filter(it => pickSelected.has(it.key));
  if (!chosen.length) { toast('先勾选要加入的内容'); return; }
  const items = chosen.map(({ _label, _sub, _dur, ...rest }) => rest);
  try {
    const r = await window.deck.favAddMany(f.id, items);
    closeModal('pickModal');
    toast(`已加入 ${r.added} 项到「${f.name}」`);
  } catch (e) { toast('加入失败：' + e.message); }
});

/* ---------- 编辑专辑（供多处复用） ---------- */

function openEditAlbum(a) {
  editingId = a.id;
  $('#eTitle').value = a.title || '';
  $('#eBvid').value = a.bvid || '';
  $('#eText').value = (a.tracks || []).map(t => `${t.name} ${fmt(t.start)}`).join('\n');
  openModal('editModal');
}

/* ---------- 启动 ---------- */

function receiveState(packet) {
  const next = decodeState(packet);
  if (!next) return;
  const dataChanged = S.albums !== next.albums || S.folders !== next.folders || S.settings !== next.settings;
  const changedSelection = S.current.albumId !== next.current.albumId || S.current.trackIndex !== next.current.trackIndex ||
    S.playing?.album?.id !== next.playing?.album?.id || S.playing?.trackIndex !== next.playing?.trackIndex;
  S = next;
  if (dataChanged) { indexLibrary(); sideSig = ''; listSig = ''; queueSig = ''; }
  window.__stateGot = (window.__stateGot || 0) + 1;
  render(!dataChanged && !changedSelection);
}
window.deck.onState(receiveState);
window.deck.state().then(receiveState).catch(e => toast('初始化失败：' + e.message));

/* 悬浮窗上的「播放列表」「收藏」按钮：主窗口被唤起后接着做对应动作 */
window.deck.onOpenQueue && window.deck.onOpenQueue(() => {
  queueOpen = true;
  $('#queuePanel').classList.add('show');
  queueSig = ''; renderQueue();
});
window.deck.onOpenFav && window.deck.onOpenFav(() => {
  const btn = $('#btnFavNow');
  if (btn && S.current.track) btn.click();
});
/* 悬浮窗里点「新建收藏夹并加入」：主窗口打开后直接弹出新建框，待收藏项已带上 */
window.deck.onNewFav && window.deck.onNewFav(item => {
  if (!item) { openFolderModal({ mode: 'create', type: 'song' }); return; }
  openFolderModal({ mode: 'create', type: item.kind === 'album' ? 'album' : 'song', pendingItem: item });
});
