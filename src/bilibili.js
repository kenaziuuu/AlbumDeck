/**
 * B 站公开数据层：视频信息 / 合集·系列 / 评论时间戳 / 文本解析
 * 纯 Node 模块，不依赖 Electron，可单独用 `node tools/test-api.js` 测试。
 */
'use strict';

const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API = 'https://api.bilibili.com';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

const state = { cookie: '', mixinKey: '', keysAt: 0 };

async function jget(path, { referer = 'https://www.bilibili.com/', timeout = 15000, signed = false } = {}) {
  let url = API + path;
  if (signed) {
    await ensureKeys();
    const [base, query] = url.split('?');
    const params = Object.fromEntries(new URLSearchParams(query || ''));
    url = base + '?' + encWbi(params, state.mixinKey);
  }
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: referer,
      Cookie: state.cookie || 'buvid3=00000000-0000-0000-0000-000000000000infoc',
      Accept: 'application/json, text/plain, */*'
    },
    signal: AbortSignal.timeout(timeout)
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch (_) { throw new Error('B 站返回的不是 JSON（可能被风控）：' + text.slice(0, 80)); }
}

async function ensureKeys() {
  const now = Date.now();
  if (state.mixinKey && now - state.keysAt < 1000 * 60 * 60 * 6) return;
  const [spi, nav] = await Promise.all([
    jget('/x/frontend/finger/spi'),
    jget('/x/web-interface/nav')
  ]);
  if (spi.code === 0 && spi.data && spi.data.b_3) {
    state.cookie = `buvid3=${spi.data.b_3}; buvid4=${spi.data.b_4 || ''}`;
  }
  const wi = nav.data && nav.data.wbi_img;
  if (!wi) throw new Error('无法获取 WBI 密钥');
  const imgKey = wi.img_url.split('/').pop().split('.')[0];
  const subKey = wi.sub_url.split('/').pop().split('.')[0];
  const orig = imgKey + subKey;
  state.mixinKey = MIXIN_KEY_ENC_TAB.map(i => orig[i] || '').join('').slice(0, 32);
  state.keysAt = now;
}

function encWbi(params, mixinKey) {
  const p = { ...params, wts: Math.round(Date.now() / 1000) };
  const filt = s => String(s).replace(/[!'()*]/g, '');
  const query = Object.keys(p).sort()
    .map(k => `${encodeURIComponent(filt(k))}=${encodeURIComponent(filt(p[k]))}`)
    .join('&');
  const w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${w_rid}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- 视频 ---------------- */

const BV_RE = /BV[0-9A-Za-z]{10}/;
const AV_RE = /\bav(\d+)\b/i;

function extractBvid(text = '') {
  const m = String(text).match(BV_RE);
  return m ? m[0] : null;
}

async function getVideoInfo(bvid) {
  const j = await jget(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  if (j.code !== 0) throw new Error(`视频信息获取失败 (${j.code}): ${j.message}`);
  const d = j.data;
  return {
    bvid: d.bvid,
    aid: d.aid,
    cid: d.cid,
    title: d.title,
    duration: d.duration,
    pic: d.pic,
    mid: d.owner && d.owner.mid,
    author: d.owner && d.owner.name,
    seasonId: d.ugc_season && d.ugc_season.id,
    seasonTitle: d.ugc_season && d.ugc_season.title
  };
}

/* ---------------- 视频内嵌章节（播放器右下角「章」） ---------------- */

/**
 * 读取视频自带的章节（view_points）。很多 UP 主把曲目表做成了章节，
 * 这种视频评论区可能没有时间戳，章节就是最好的来源。
 */
async function getChapters(input) {
  let bvid = '', aid = 0, cid = 0, duration = 0;
  if (typeof input === 'string') {
    bvid = input;
    const info = await getVideoInfo(bvid);
    aid = info.aid; cid = info.cid; duration = info.duration;
  } else if (input && typeof input === 'object') {
    bvid = input.bvid || '';
    aid = input.aid || 0; cid = input.cid || 0; duration = input.duration || 0;
  }
  if (!cid && bvid) {
    const pl = await jget(`/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`, { referer: 'https://www.bilibili.com/' });
    const p0 = pl.data && pl.data[0];
    if (p0) { cid = p0.cid; duration = duration || p0.duration || 0; }
  }
  if (!aid || !cid) return [];
  const paths = [
    { p: `/x/player/v2?aid=${aid}&cid=${cid}`, signed: false },
    { p: `/x/player/wbi/v2?aid=${aid}&cid=${cid}`, signed: true }
  ];
  for (const { p, signed } of paths) {
    try {
      const j = await jget(p, { referer: `https://www.bilibili.com/video/${bvid}/`, signed });
      if (j.code !== 0 || !j.data) continue;
      const vps = (j.data.view_points || []).filter(v => v && Number.isFinite(Number(v.from)) && String(v.content || '').trim());
      if (!vps.length) continue;
      return finalizeTracks(vps.map(v => ({ name: v.content, start: v.from })), duration);
    } catch (_) { /* 换下一个接口 */ }
  }
  return [];
}

/* ---------------- 合集 / 系列 / 空间 ---------------- */

async function getSeasons(mid) {
  const referer = `https://space.bilibili.com/${mid}/`;
  let j = await jget(
    `/x/polymer/web-space/seasons_series_list?mid=${mid}&page_num=1&page_size=20`,
    { referer }
  );
  if (j.code !== 0 || !j.data) {
    j = await jget(
      `/x/polymer/web-space/seasons_series_list?mid=${mid}&page_num=1&page_size=20`,
      { referer, signed: true }
    );
  }
  if (j.code !== 0 || !j.data) return [];
  const items = [];
  const seasons = (j.data.items_lists && j.data.items_lists.seasons_list) || [];
  const series = (j.data.items_lists && j.data.items_lists.series_list) || [];
  for (const s of seasons) {
    const m = s.meta || {};
    items.push({ type: 'season', id: m.season_id || m.id, title: m.name || m.title, count: m.total, cover: m.cover, archives: s.archives || [] });
  }
  for (const s of series) {
    const m = s.meta || {};
    items.push({ type: 'series', id: m.series_id || m.id, title: m.name || m.title, count: m.total, cover: m.cover });
  }
  return items;
}

async function getSeasonArchives(mid, seasonId) {
  const out = [];
  for (let page = 1; page <= 40; page++) {
    const j = await jget(
      `/x/polymer/web-space/seasons_archives_list?mid=${mid}&season_id=${seasonId}&sort=asc&page_num=${page}&page_size=50`,
      { referer: `https://space.bilibili.com/${mid}/` }
    );
    if (j.code !== 0 || !j.data) break;
    const list = j.data.archives || [];
    for (const a of list) {
      out.push({ bvid: a.bvid, aid: a.aid, title: a.title, duration: toSeconds(a.duration), pic: a.pic });
    }
    const pageInfo = j.data.page || {};
    if (out.length >= (pageInfo.total || list.length) || list.length < 50) break;
    await sleep(180);
  }
  return out;
}

async function getSeriesArchives(mid, seriesId) {
  const out = [];
  for (let page = 1; page <= 12; page++) {
    const j = await jget(
      `/x/series/archives?mid=${mid}&series_id=${seriesId}&only_normal=true&sort=asc&page_num=${page}&page_size=30`,
      { referer: `https://space.bilibili.com/${mid}/`, signed: true }
    );
    if (j.code !== 0 || !j.data) break;
    const list = j.data.archives || [];
    for (const a of list) {
      out.push({ bvid: a.bvid, aid: a.aid, title: a.title, duration: toSeconds(a.duration), pic: a.pic });
    }
    if (list.length < 30 || out.length >= (j.data.page && j.data.page.total || 0)) break;
    await sleep(180);
  }
  return out;
}

async function getSpaceVideos(mid, max = 30) {
  const out = [];
  const paths = pn => [
    { p: `/x/space/wbi/arc/search?mid=${mid}&pn=${pn}&ps=30&index=1&order=pubdate&order_avoided=true&platform=web`, signed: true },
    { p: `/x/space/arc/search?mid=${mid}&pn=${pn}&ps=30&order=pubdate`, signed: false }
  ];
  for (let pn = 1; pn <= Math.ceil(max / 30); pn++) {
    let list = [];
    for (const { p, signed } of paths(pn)) {
      try {
        const j = await jget(p, { referer: `https://space.bilibili.com/${mid}/video`, signed });
        if (j.code !== 0 || !j.data) continue;
        list = (j.data.list && j.data.list.vlist) || [];
        if (list.length) break;
      } catch (_) { /* 试下一个接口 */ }
    }
    if (!list.length) break;   // 多半是限流，返回已拿到的部分
    for (const a of list) {
      out.push({ bvid: a.bvid, aid: a.aid, title: a.title, duration: toSeconds(a.length || a.duration), pic: a.pic });
    }
    if (list.length < 30) break;
    await sleep(350);
  }
  return out.slice(0, max);
}

function toSeconds(v) {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const parts = String(v).split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}

/* ---------------- 评论 ---------------- */

async function getComments(aid) {
  const out = [];
  // 兼容三个评论接口，取第一个成功的
  const paths = [
    `/x/v2/reply/main?type=1&oid=${aid}&mode=3&next=0&ps=20`,
    `/x/v2/reply?type=1&oid=${aid}&sort=2&pn=1&ps=20`,
    `/x/v2/reply/wbi/main?type=1&oid=${aid}&mode=3&pagination_str=${encodeURIComponent('{"offset":""}')}&plat=1&web_location=1315875`
  ];
  for (const p of paths) {
    try {
      const j = await jget(p, { signed: p.includes('/wbi/') });
      if (j.code !== 0 || !j.data) continue;
      const push = (r, isTop) => r && r.content && r.content.message && out.push({
        message: r.content.message,
        like: r.like || 0,
        isTop: !!isTop,
        mid: r.mid
      });
      const top = j.data.upper && j.data.upper.top;
      if (top) push(top, true);
      (j.data.top_replies || j.data.top || []).forEach(r => push(r, true));
      (j.data.replies || []).forEach(r => push(r, false));
      if (out.length) break;
    } catch (_) { /* 换下一个接口 */ }
  }
  return out;
}

/** 从评论文本里挑出最像「曲目表」的一条：时间戳行数最多，置顶优先 */
function pickTracklistComment(comments, upMid) {
  let best = null;
  for (const c of comments) {
    const count = (c.message.match(/(?:\d{1,2}:)?\d{1,2}:\d{2}/g) || []).length;
    if (count < 2) continue;
    let score = count * 10 + (c.isTop ? 1000 : 0) + Math.min(c.like, 300) / 10;
    if (upMid && c.mid === upMid) score += 500;
    if (!best || score > best.score) best = { ...c, score, count };
  }
  return best;
}

/* ---------------- 时间戳文本解析 ---------------- */

const TIME_RE = /(?<![\d:])(\d{1,2}:)?(\d{1,2}):(\d{2})(?!\d)/g;

function parseTime(h, m, s) {
  return (h ? parseInt(h.replace(':', ''), 10) * 3600 : 0) + parseInt(m, 10) * 60 + parseInt(s, 10);
}

/**
 * 支持：
 *   我要的幸福 01:25
 *   01:25 我要的幸福
 *   1. 【坏天气】05:01  /  On The Road(Demo1) 00:00
 *   1:05:30 歌名（小时制）
 */
function parseTimestamps(text, videoDuration = 0) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const raw = [];
  for (const line of lines) {
    const matches = [...line.matchAll(TIME_RE)];
    if (!matches.length) continue;
    // 一行里出现多个时间戳时，取最后一个作为起点（前面往往是编号/歌词）
    for (const mt of matches) {
      const start = parseTime(mt[1], mt[2], mt[3]);
      let name = (line.slice(0, mt.index) + ' ' + line.slice(mt.index + mt[0].length)).trim();
      name = name
        .replace(/^\s*(?:置顶|UP主|楼主)\s*[:：]?\s*/, '')
        .replace(/^\s*\d{1,2}\s*[.、．)）]\s*/, '')
        .replace(/^[\s\-—–·|]+/, '')
        .replace(/[\s\-—–·|]+$/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      // 只在成对包裹时去掉外层括号，避免误伤 "On The Road(Demo1)" 这类歌名
      const pairs = [['【', '】'], ['[', ']'], ['（', '）'], ['(', ')']];
      for (const [l, r] of pairs) {
        if (name.startsWith(l) && name.endsWith(r)) { name = name.slice(l.length, -r.length).trim(); break; }
      }
      if (!name || /^[\d\s:：.、\-—]+$/.test(name)) name = `曲目 ${raw.length + 1}`;
      raw.push({ name, start });
    }
  }
  return finalizeTracks(raw, videoDuration);
}

/** 曲目表统一整理：过滤非法、按起点排序、去重、补每首的结束时间 */
function finalizeTracks(items, duration) {
  const seen = new Set();
  const out = (items || [])
    .filter(t => t && Number.isFinite(Number(t.start)) && Number(t.start) >= 0)
    .map(t => ({ name: String(t.name || '').trim() || '未命名曲目', start: Math.round(Number(t.start)) }))
    .sort((a, b) => a.start - b.start)
    .filter(t => !seen.has(t.start) && seen.add(t.start));
  out.forEach((t, i) => { t.end = i < out.length - 1 ? out[i + 1].start : (Number(duration) || 0); });
  return out;
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
           : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/* ---------------- 链接解析（给导入面板用） ---------------- */

/**
 * 输入：视频链接 / 合集链接 / 系列链接 / UP 主空间链接 / 纯 BV 号
 * 返回：{ kind:'video'|'season'|'series'|'space'|'multi', ... }
 */
async function resolveInput(input) {
  const text = String(input || '').trim();
  const bvids = [...new Set(text.match(/BV[0-9A-Za-z]{10}/g) || [])];
  if (bvids.length > 1 && !/space\.bilibili|seasons|series|season_id/.test(text)) {
    return { kind: 'multi', bvids };
  }
  const midM = text.match(/space\.bilibili\.com\/(\d+)/) || text.match(/[?&]mid=(\d+)/);
  const seasonM = text.match(/season_id=(\d+)/) || text.match(/seasons\/(\d+)/) ||
                  text.match(/lists\/(\d+)/) || text.match(/\/channel\/seriesdetail\?sid=(\d+)/);
  const seriesM = text.match(/series_id=(\d+)/) || text.match(/series\/(\d+)/) ||
                  text.match(/\/channel\/collectiondetail\?sid=(\d+)/);

  if (seasonM) {
    const seasonId = Number(seasonM[1]);
    let mid = midM ? Number(midM[1]) : null;
    if (!mid) mid = await guessMidFromSeason(seasonId);
    let archives = mid ? await getSeasonArchives(mid, seasonId) : [];
    if (!archives.length && mid) archives = await getSeriesArchives(mid, seasonId);
    return { kind: 'season', seasonId, mid, archives };
  }
  if (seriesM) {
    const seriesId = Number(seriesM[1]);
    let mid = midM ? Number(midM[1]) : null;
    if (!mid) mid = await guessMidFromSeries(seriesId);
    return { kind: 'series', seriesId, mid, archives: mid ? await getSeriesArchives(mid, seriesId) : [] };
  }
  if (midM) {
    const mid = Number(midM[1]);
    const seasons = await getSeasons(mid);
    let archives = await getSpaceVideos(mid, 30);
    // 限流时退化为各合集的预览视频，至少保证有东西可导入
    if (!archives.length) {
      archives = seasons.flatMap(s => (s.archives || []).map(a => ({
        bvid: a.bvid, aid: a.aid, title: a.title, duration: a.duration, pic: a.pic
      })));
    }
    return { kind: 'space', mid, seasons, archives };
  }
  const bvid = bvids[0] || (text.match(/^BV[0-9A-Za-z]{10}$/) ? text : null);
  if (!bvid) {
    // 兜底：纯文本关键词搜索
    return { kind: 'search', keyword: text };
  }
  const info = await getVideoInfo(bvid);
  // 单个视频只返回它自己；同合集由界面上的「展开同合集」按需拉取，避免一次抓几百个视频
  return { kind: 'video', info, archives: [], seasonId: info.seasonId, mid: info.mid };
}

async function guessMidFromSeason(seasonId) {
  try {
    const j = await jget(`/x/polymer/web-space/seasons_archives_list?mid=0&season_id=${seasonId}&page_num=1&page_size=1`, { signed: true });
    return null;
  } catch (_) { return null; }
}

async function guessMidFromSeries(seriesId) {
  return null;
}

/** 搜索视频（用于导入面板的关键词兜底） */
async function searchVideos(keyword) {
  await ensureKeys();
  const j = await jget(`/x/web-interface/wbi/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=1`, {
    referer: 'https://search.bilibili.com/', signed: true
  });
  if (j.code !== 0) {
    const j2 = await jget(`/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=1`, {
      referer: 'https://search.bilibili.com/'
    });
    return (j2.data && j2.data.result || []).map(v => ({
      bvid: v.bvid, aid: v.aid, title: String(v.title).replace(/<[^>]+>/g, ''),
      duration: toSeconds(v.duration), pic: v.pic, author: v.author
    }));
  }
  return (j.data && j.data.result || []).map(v => ({
    bvid: v.bvid, aid: v.aid, title: String(v.title).replace(/<[^>]+>/g, ''),
    duration: toSeconds(v.duration), pic: v.pic, author: v.author
  }));
}

/** 给一批视频抓曲目表（并发受限，避免风控） */
async function buildAlbumsFromArchives(archives, onProgress = () => {}, concurrency = 3) {
  const results = new Array(archives.length);
  let cursor = 0, done = 0;
  async function worker() {
    while (cursor < archives.length) {
      const i = cursor++;
      const a = archives[i];
      try {
        let aid = a.aid, duration = a.duration;
        if (!aid) { const info = await getVideoInfo(a.bvid); aid = info.aid; duration = duration || info.duration; }

        // 1) 先看评论区置顶的时间戳
        let tracks = [], source = '';
        try {
          const best = pickTracklistComment(await getComments(aid));
          if (best) {
            const parsed = parseTimestamps(best.message, duration);
            if (parsed.length >= 2) { tracks = parsed; source = 'comment'; }
          }
        } catch (_) { /* 评论拿不到就继续试章节 */ }

        // 2) 评论里没有（或太少）就回退到视频自带章节
        if (tracks.length < 2) {
          const chapters = await getChapters({ bvid: a.bvid, aid, duration });
          if (chapters.length >= 2) { tracks = chapters; source = 'chapter'; }
        }

        // 3) 仍然没有 → 整个视频当作一首单曲（名字用视频标题），保证可播放
        if (!tracks.length) {
          if (!duration) {
            try { const info = await getVideoInfo(a.bvid); duration = info.duration || 0; } catch (_) {}
          }
          tracks = [{ name: cleanTrackName(a.title), start: 0, end: duration || 0 }];
          source = 'single';
        }

        results[i] = {
          id: 'a_' + Date.now().toString(36) + '_' + i,
          title: cleanAlbumTitle(a.title),
          bvid: a.bvid,
          aid,
          duration,
          pic: a.pic,
          tracks,
          tracksSource: source,
          tracksOk: tracks.length >= 1
        };
      } catch (e) {
        results[i] = {
          id: 'a_' + Date.now().toString(36) + '_' + i,
          title: cleanAlbumTitle(a.title), bvid: a.bvid, aid: a.aid,
          duration: a.duration, pic: a.pic, tracks: [], tracksOk: false, error: String(e.message || e)
        };
      }
      done++;
      onProgress(done, archives.length, results[i]);
      await sleep(120);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, archives.length) }, worker));
  return results.filter(Boolean);
}

/** 单曲兜底时的曲目名：直接用视频标题，去掉标签和营销尾巴 */
function cleanTrackName(t) {
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

function cleanAlbumTitle(t) {
  const s = String(t || '')
    .replace(/<[^>]+>/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const m = s.match(/《([^》]+)》/);
  if (m) {
    const before = s.slice(0, m.index);
    const artist = (before.match(/^[\u4e00-\u9fa5A-Za-z·]+/) || [''])[0];
    const year = (before.match(/(19|20)\d{2}/) || [''])[0];
    return [artist, year, `《${m[1]}》`].filter(Boolean).join(' ').slice(0, 48);
  }
  return (s
    .replace(/超强音质.*$/, '')
    .replace(/每天音乐专辑分享.*$/, '')
    .replace(/[|｜].*$/, '')
    .replace(/[，,].*$/, '')
    .trim()
    .slice(0, 32)) || '未命名专辑';
}

module.exports = {
  UA,
  extractBvid, getVideoInfo, getSeasons, getSeasonArchives, getSeriesArchives,
  getSpaceVideos, getComments, pickTracklistComment, parseTimestamps, fmtTime,
  resolveInput, searchVideos, buildAlbumsFromArchives, cleanAlbumTitle, cleanTrackName, toSeconds,
  getChapters, finalizeTracks, ensureKeys
};
