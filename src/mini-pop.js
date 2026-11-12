'use strict';
const $ = s => document.querySelector(s);
const fmt = s => window.deck.fmt(s);
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const KIND = new URLSearchParams(location.search).get('kind') || 'fav';
let S = null;

const songKeyOf = it => `song:${it.bvid}:${Math.round(it.start || 0)}`;
function currentSongItem() {
  // 用正在播放的那首（可能和当前查看的专辑不同）
  const pl = (S && S.playing) || {};
  const a = pl.album, t = pl.track;
  if (!a || !t || pl.external) return null;
  return {
    kind: 'song', bvid: a.bvid, start: t.start, name: t.name, albumTitle: a.title,
    albumId: a.id, trackIndex: (pl.trackIndex || 0),
    duration: Math.max(0, (t.end || 0) - t.start)
  };
}

/* ---------- 三种内容 ---------- */

function favHtml() {
  const it = currentSongItem();
  if (!it) return '<div class="pp-empty">还没有正在播放的歌曲</div>';
  const key = songKeyOf(it);
  const list = (S.folders || []).filter(f => f.type !== 'album');
  let html = list.map(f => {
    const has = (f.items || []).some(x => x.key === key);
    return `<button class="pi ${has ? 'on' : ''}" data-fid="${esc(f.id)}">
      <span class="ico">${f.builtin ? '♥' : '♡'}</span>
      <span class="name">${esc(f.name)}</span>
      <span class="num">${has ? '✓ ' : ''}${(f.items || []).length}</span>
    </button>`;
  }).join('');
  if (!list.length) html = '<div class="pp-empty">还没有歌曲收藏夹</div>';
  html += '<button class="pi new" data-newfav="1"><span class="ico">＋</span><span class="name">新建收藏夹并加入</span></button>';
  return html;
}

function modeHtml() {
  const modes = (S && S.playModes) || [];
  const cur = (S && S.settings && S.settings.playMode) || 'all-loop';
  return modes.map(m => `<button class="pi ${m.key === cur ? 'on' : ''}" data-mode="${esc(m.key)}">
    <span class="ico">${m.key === cur ? '✓' : ''}</span>
    <span class="name">${esc(m.label)}</span>
    <span class="num">${esc(m.scope || '')}</span>
  </button>`).join('');
}

function queueHtml() {
  const q = (S && S.queue) || { items: [] };
  const items = q.items || [];
  if (!items.length) return '<div class="pp-empty">播放列表为空</div>';
  const albums = (S && S.albums) || [];
  // 高亮跟着正在播放走（主窗口可能只是选中了别的专辑在看）
  const pl = (S && S.playing) || {};
  const cur = { albumId: (pl.album && pl.album.id) || ((S && S.current) || {}).albumId, trackIndex: pl.trackIndex || 0 };
  const groups = [], map = new Map();
  items.forEach((it, qi) => {
    let g = map.get(it.albumId);
    if (!g) { g = { albumId: it.albumId, list: [] }; map.set(it.albumId, g); groups.push(g); }
    g.list.push({ trackIndex: it.trackIndex, qi });
  });
  return groups.map(g => {
    const a = albums.find(x => x.id === g.albumId);
    const isCur = g.albumId === cur.albumId;
    const rows = g.list.map(it => {
      const t = a && a.tracks && a.tracks[it.trackIndex];
      if (!t) return '';
      const active = isCur && it.trackIndex === cur.trackIndex;
      return `<div class="pt ${active ? 'active' : ''} ${t.hidden ? 'hidden-track' : ''}" data-qi="${it.qi}">
        <span class="no">${String(it.trackIndex + 1).padStart(2, '0')}</span>
        <span class="tn">${esc(t.name)}</span>
        <span class="tm">${fmt(t.start)}</span>
      </div>`;
    }).join('');
    return `<div class="pg ${isCur ? 'open current' : ''}">
      <div class="pg-album"><span class="pg-arrow">▶</span><span class="pg-name">${esc(a ? a.title : '未知专辑')}</span><span class="pg-num">${g.list.length} 首</span></div>
      <div class="pg-tracks">${rows}</div>
    </div>`;
  }).join('');
}

/* ---------- 渲染 + 通知主进程定位 ---------- */

function render() {
  const title = KIND === 'fav' ? '收藏到收藏夹' : (KIND === 'mode' ? '播放顺序' : '播放列表');
  $('#ppTitle').textContent = title;
  const qq = (S && S.queue) || {};
  const qsrc = qq.source && qq.source.kind === 'folder' ? qq.source : null;
  $('#ppSub').textContent = KIND === 'queue'
    ? (qsrc ? `收藏夹「${qsrc.name}」 · ${(qq.items || []).length} 首` : `${(qq.items || []).length} 首`) : '';
  $('#ppBody').innerHTML = KIND === 'fav' ? favHtml() : (KIND === 'mode' ? modeHtml() : queueHtml());
  // 每次打开都把正在播放的专辑滚到面板顶部
  if (KIND === 'queue') requestAnimationFrame(scrollToCurrent);
}

function scrollToCurrent() {
  const box = $('#ppBody');
  const grp = box.querySelector('.pg.current');
  if (!grp) return;
  const rb = box.getBoundingClientRect(), rg = grp.getBoundingClientRect();
  box.scrollTop = Math.max(0, box.scrollTop + (rg.top - rb.top) - 2);
}

/** 量内容自然尺寸：临时让 .pp 高度自适应、宽度取内容宽，避免被窗口尺寸反过来撑大 */
function measure() {
  const root = document.documentElement;
  root.classList.add('measuring');
  const r = $('.pp').getBoundingClientRect();
  const out = { h: Math.ceil(r.height), w: Math.ceil(r.width) };
  root.classList.remove('measuring');
  return out;
}

async function reportSize() {
  const m = measure();
  const height = Math.max(60, Math.min(340, m.h));
  try { await window.deck.popSize({ height, width: m.w }); } catch (_) {}
  if (KIND === 'queue') requestAnimationFrame(scrollToCurrent);
}

const close = () => { try { window.deck.closePop(); } catch (_) {} };

/* ---------- 交互 ---------- */

$('#ppClose').addEventListener('click', close);
document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

$('#ppBody').addEventListener('click', async e => {
  const pick = e.target.closest('[data-fid]');
  if (pick) {
    const it = currentSongItem();
    if (!it) { close(); return; }
    const fid = pick.dataset.fid, key = songKeyOf(it);
    const f = (S.folders || []).find(x => x.id === fid);
    const has = pick.classList.contains('on');
    try {
      // 已经在里面 → 再点一次就是取消收藏
      if (has) {
        await window.deck.favRemove(fid, key);
        $('#ppSub').textContent = `已从「${f ? f.name : ''}」取消`;
        pick.classList.remove('on');
        pick.querySelector('.num').textContent = String(Math.max(0, ((f && f.items) || []).length - 1));
      } else {
        const r = await window.deck.favAdd(fid, it);
        $('#ppSub').textContent = r.added ? `已加入「${f ? f.name : ''}」` : '已经在这个收藏夹里了';
        pick.classList.add('on');
      }
      setTimeout(close, 700);
    } catch (err) { $('#ppSub').textContent = '操作失败：' + err.message; }
    return;
  }
  if (e.target.closest('[data-newfav]')) {
    const it = currentSongItem();
    close();
    if (it) window.deck.newFav(it).catch(() => {});
    return;
  }
  const md = e.target.closest('[data-mode]');
  if (md) {
    try { await window.deck.setPlayMode(md.dataset.mode); } catch (_) {}
    close();
    return;
  }
  const head = e.target.closest('.pg-album');
  if (head) { head.parentElement.classList.toggle('open'); return; }
  const tr = e.target.closest('.pt');
  if (tr) {
    const it = (((S && S.queue) || {}).items || [])[Number(tr.dataset.qi)];
    if (it) { window.deck.playAt(it.albumId, it.trackIndex).catch(() => {}); close(); }
  }
});

(async () => {
  try { S = await window.deck.state(); } catch (_) { S = null; }
  render();
  await reportSize();
})();
