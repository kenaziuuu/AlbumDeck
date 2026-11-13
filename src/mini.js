'use strict';
const $ = s => document.querySelector(s);
const fmt = s => window.deck.fmt(s);
const LIKED_ID = 'fav_liked';
let lastState = null;
const decodeState = DeckState.createDecoder();
let appliedStyle = '';

/* 播放顺序图标（与主界面一致） */
const MODE_ICONS = {
  once: '<svg viewBox="0 0 24 24"><path d="M7 5v14M17 5v14"/></svg>',
  loop: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 13.7-5.7M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-13.7 5.7M4 20v-5h5"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>',
  one: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 13.7-5.7M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-13.7 5.7M4 20v-5h5"/><text x="12" y="16.5" text-anchor="middle" font-size="9" fill="currentColor" stroke="none">1</text></svg>'
};

/* ── 完整样式控制 ── */
$('#mPrev').addEventListener('click', () => window.deck.prev());
$('#mNext').addEventListener('click', () => window.deck.next());
$('#mPrevAlbum').addEventListener('click', () => window.deck.prevAlbum());
$('#mNextAlbum').addEventListener('click', () => window.deck.nextAlbum());
$('#mPlay').addEventListener('click', () => window.deck.togglePlay());
$('#mMain').addEventListener('click', () => window.deck.showMain());
$('#mCollapse').addEventListener('click', () => window.deck.collapseMini());
$('#mClose').addEventListener('click', () => window.deck.toggleMini());

/* ── MP3 紧凑样式控制 ── */
$('#mcPrev').addEventListener('click', () => window.deck.prev());
$('#mcNext').addEventListener('click', () => window.deck.next());
$('#mcPrevAlbum').addEventListener('click', () => window.deck.prevAlbum());
$('#mcNextAlbum').addEventListener('click', () => window.deck.nextAlbum());
$('#mcPlay').addEventListener('click', () => window.deck.togglePlay());

/* ── 竖直样式控制 ── */
$('#mvPrev').addEventListener('click', () => window.deck.prev());
$('#mvNext').addEventListener('click', () => window.deck.next());
$('#mvPrevAlbum').addEventListener('click', () => window.deck.prevAlbum());
$('#mvNextAlbum').addEventListener('click', () => window.deck.nextAlbum());
$('#mvPlay').addEventListener('click', () => window.deck.togglePlay());
$('#mvMain').addEventListener('click', () => window.deck.showMain());
$('#mvCollapse').addEventListener('click', () => window.deck.collapseMini());
$('#mvClose').addEventListener('click', () => window.deck.toggleMini());
/* ── 播放顺序 / 播放列表（完整样式也有一份） ── */
async function cycleMode() {
  const modes = (lastState && lastState.playModes) || [];
  if (!modes.length) return;
  const cur = (lastState.settings && lastState.settings.playMode) || 'all-loop';
  const i = modes.findIndex(m => m.key === cur);
  const next = modes[(i + 1) % modes.length];
  try { await window.deck.setPlayMode(next.key); } catch (_) {}
}
$('#mvMode').addEventListener('click', cycleMode);
$('#mMode').addEventListener('click', cycleMode);
/* 右键播放顺序：直接列出全部顺序，不用点很多次才轮到想要的 */
['#mMode', '#mvMode'].forEach(sel => {
  const el = $(sel);
  if (!el) return;
  el.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); window.deck.openPop('mode'); });
});
/* 收藏 / 播放列表：在悬浮窗里就地展开，不弹主窗口（三种样式共用） */
$('#mFav').addEventListener('click', () => window.deck.openPop('fav'));
$('#mQueue').addEventListener('click', () => window.deck.openPop('queue'));
$('#mvFav').addEventListener('click', () => window.deck.openPop('fav'));
$('#mvQueue').addEventListener('click', () => window.deck.openPop('queue'));

function renderModeBtn(el, key, label) {
  if (!el) return;
  if (el.dataset.k !== key) {
    el.dataset.k = key;
    el.innerHTML = key === 'once' ? MODE_ICONS.once : key === 'one' ? MODE_ICONS.one
      : (key.indexOf('shuffle') >= 0 || key === 'album-random' ? MODE_ICONS.shuffle : MODE_ICONS.loop);
  }
  el.title = `播放顺序：${label}（左键切换，右键直接选）`;
}

/* 双击空白处打开主窗口 */
document.querySelectorAll('.mini').forEach(el => el.addEventListener('dblclick', e => {
  if (e.target.closest('button')) return;
  window.deck.showMain();
}));

async function toggleHeart() {
  const pl = (lastState && lastState.playing) || {};
  const a = pl.album, t = pl.track;
  if (!a || !t) return;
  try {
    await window.deck.favLike({
      kind: 'song', bvid: a.bvid, start: t.start, name: t.name, albumTitle: a.title,
      albumId: a.id, trackIndex: pl.trackIndex || 0,
      duration: Math.max(0, (t.end || 0) - t.start)
    });
  } catch (_) {}
}

$('#mHeart').addEventListener('click', toggleHeart);
$('#mvHeart').addEventListener('click', toggleHeart);

function applyStyle(style) {
  const s = style === 'compact' ? 'compact' : (style === 'vertical' ? 'vertical' : 'full');
  if (s === appliedStyle) return;
  appliedStyle = s;
  document.body.classList.toggle('style-compact', s === 'compact');
  document.body.classList.toggle('style-full', s === 'full');
  document.body.classList.toggle('style-vertical', s === 'vertical');
}

function receiveState(packet) {
  const s = decodeState(packet);
  if (!s) return;
  lastState = s;
  applyStyle((s.settings && s.settings.miniStyle) || 'full');

  // 跟着真正在播的那首走（主窗口可能只是选中了别的专辑在看）
  const p = s.playing || {};
  const t = p.track || null, a = p.album || null;
  const pb = { t: p.t || 0, d: p.d || 0, paused: p.paused !== false };
  const total = t ? Math.max(1, (t.end || (pb.d || 0)) - t.start) : 1;
  const pos = t ? Math.max(0, Math.min(total, (pb.t || 0) - t.start)) : 0;
  const pct = Math.max(0, Math.min(100, pos / total * 100));

  /* 完整样式 */
  $('#mName').textContent = t ? t.name : '选择一首歌';
  $('#mAlbum').textContent = a ? a.title : (p.external ? '曲库外的视频' : '唱片台 · AlbumDeck');
  $('#mFill').style.width = pct + '%';
  $('#mNow').textContent = fmt(pos);
  $('#mTotal').textContent = fmt(total);
  $('#mPlay').textContent = pb.paused ? '▶' : '❚❚';
  $('#mDot').className = 'm-dot' + (s.conn.connected ? ' on' : '');

  /* 紧凑样式 */
  $('#mcName').textContent = t ? t.name : '选择一首歌';
  $('#mcAlbum').textContent = a ? a.title : (p.external ? '曲库外的视频' : '唱片台 · AlbumDeck');
  $('#mcFill').style.width = pct + '%';
  $('#mcPlay').textContent = pb.paused ? '▶' : '❚❚';
  const cover = $('#mcCover');
  if (a && a.pic) {
    const src = String(a.pic).replace(/^http:/, 'https:');
    if (cover.dataset.src !== src) {
      cover.dataset.src = src;
      cover.innerHTML = `<img src="${src}" alt="">`;
    }
  } else if (cover.dataset.src !== 'none') {
    cover.dataset.src = 'none';
    cover.innerHTML = '<span>♫</span>';
  }

  /* 竖直样式 */
  $('#mvAlbum').textContent = a ? a.title : (p.external ? '曲库外的视频' : '唱片台 · AlbumDeck');
  $('#mvName').textContent = t ? t.name : '选择一首歌';
  $('#mvFill').style.width = pct + '%';
  $('#mvPlay').textContent = pb.paused ? '▶' : '❚❚';
  $('#mvDot').className = 'm-dot' + (s.conn.connected ? ' on' : '');

  /* 红心状态 */
  const liked = (s.folders || []).find(f => f.id === LIKED_ID) || { items: [] };
  const key = a && t ? `song:${a.bvid}:${Math.round(t.start)}` : '';
  const on = !!key && liked.items.some(x => x.key === key);
  $('#mHeart').classList.toggle('on', on);
  $('#mHeart').textContent = on ? '♥' : '♡';

  /* 完整样式：☆ 收藏是否已在某个歌曲收藏夹里 */
  const inAny = !!key && (s.folders || []).some(f => f.type !== 'album' && (f.items || []).some(x => x.key === key));
  $('#mFav').classList.toggle('on', inAny);
  $('#mFav').textContent = inAny ? '★' : '☆';

  /* 竖直样式：红心 + 播放顺序 */
  $('#mvHeart').classList.toggle('on', on);
  $('#mvHeart').textContent = on ? '♥' : '♡';

  /* 播放顺序按钮（完整样式 + MP3样式共用同一套图标） */
  const modes = s.playModes || [];
  const modeKey = (s.settings && s.settings.playMode) || 'all-loop';
  const modeMeta = modes.find(m => m.key === modeKey) || { label: '全专循环' };
  renderModeBtn($('#mMode'), modeKey, modeMeta.label);
  renderModeBtn($('#mvMode'), modeKey, modeMeta.label);
}
window.deck.onState(receiveState);

window.deck.state().then(receiveState).catch(() => {});
