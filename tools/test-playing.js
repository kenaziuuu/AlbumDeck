const p = require('../src/playing');
let fail = 0;
const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) fail++; };

// 造两张专辑：A = 逆光（正在播），B = 完美的一天（只是选中在看）
const A = { id: 'aA', bvid: 'BV_A', title: '逆光', tracks: [
  { name: '逆光', start: 0, end: 200 },
  { name: '我怀念的', start: 200, end: 400 },
  { name: '飘着', start: 400, end: 600 }
] };
const B = { id: 'aB', bvid: 'BV_B', title: '完美的一天', tracks: [
  { name: '完美的一天', start: 0, end: 240 },
  { name: '眼泪成诗', start: 240, end: 480 }
] };
const albums = [A, B];

// 1) 正在播 A 的第 2 首（t=250），但界面选中 B
{
  const r = p.resolvePlaying({ albums, playingBvid: 'BV_A', playingT: 250, playingD: 600, playingPaused: false, currentAlbum: B, currentTrackIndex: 0 });
  ok('正在播放：专辑是正在播的那张（逆光）', r.album.id === 'aA', r.album.title);
  ok('正在播放：曲目按播放时间算（第 2 首）', r.track && r.track.name === '我怀念的', r.track && r.track.name);
  ok('正在播放：曲目索引正确', r.trackIndex === 1, String(r.trackIndex));
  ok('正在播放：进度用的是真实播放时间', r.t === 250 && r.paused === false);
}

// 2) 浏览器里没在放曲库里的东西 → 退回选中项、进度归零
{
  const r = p.resolvePlaying({ albums, playingBvid: '', playingT: 0, playingD: 0, playingPaused: true, currentAlbum: B, currentTrackIndex: 1 });
  ok('没在播：退回选中专辑', r.album.id === 'aB');
  ok('没在播：曲目是选中项', r.track && r.track.name === '眼泪成诗');
  ok('没在播：进度 0 / 暂停', r.t === 0 && r.paused === true);
  const r2 = p.resolvePlaying({ albums, playingBvid: 'BV_UNKNOWN', playingT: 99, playingD: 300, playingPaused: false, playingTitle: '某某视频_哔哩哔哩_bilibili', currentAlbum: B, currentTrackIndex: 0 });
  ok('曲库外视频：按真实进度/播放状态显示，不假装暂停', r2.external === true && r2.t === 99 && r2.paused === false && r2.album === null);
  ok('曲库外视频：曲目名用视频标题兜底', r2.track && r2.track.name === '某某视频', r2.track && r2.track.name);
}

// 3) 切上一张 / 下一张专辑的基准
{
  const pin = { albumId: 'aB', bvid: 'BV_A' };
  ok('手动选中 B 时，下一张以 A（在播）为基准',
    p.stepBaseAlbumId({ albums, currentAlbumId: 'aB', pin, playingBvid: 'BV_A' }) === 'aA');
  ok('没有 pin 时以选中项为基准',
    p.stepBaseAlbumId({ albums, currentAlbumId: 'aB', pin: null, playingBvid: 'BV_A' }) === 'aB');
  ok('pin 指向别的专辑（视图已切走）时以选中项为准',
    p.stepBaseAlbumId({ albums, currentAlbumId: 'aB', pin: { albumId: 'aA', bvid: 'BV_A' }, playingBvid: 'BV_A' }) === 'aB');
  ok('在播的专辑不在曲库时退回选中项',
    p.stepBaseAlbumId({ albums, currentAlbumId: 'aB', pin: { albumId: 'aB', bvid: '' }, playingBvid: 'BV_X' }) === 'aB');
}

// 4) 曲目索引边界
{
  ok('t 落在第一首之前 → 0', p.trackIndexAt(A, 0) === 0);
  ok('t 超过最后一首的 end → 仍算最后一首', p.trackIndexAt(A, 9999) === 2);
  ok('空专辑 → -1', p.trackIndexAt({ tracks: [] }, 10) === -1);
  ok('没有专辑 → -1', p.trackIndexAt(null, 10) === -1);
}


// 5) 曲尾判断（B 站视频放完会自动暂停，这里必须认出来）
{
  const tr = { start: 200, end: 400 };
  ok('曲尾 + 还在放 → 结束', p.isTrackEnded({ track: tr, t: 400, d: 600, paused: false }) === true);
  ok('暂停在曲尾、视频还没放完 → 先不跳（等用户按播放）', p.isTrackEnded({ track: tr, t: 400, d: 600, paused: true }) === false);
  ok('视频停在末尾（曲目 end 比视频长）→ 结束', p.isTrackEnded({ track: { start: 0, end: 700 }, t: 600, d: 600, paused: true }) === true);
  ok('暂停在曲中 → 不算结束', p.isTrackEnded({ track: tr, t: 250, d: 600, paused: true }) === false);
  ok('暂停在曲尾但视频没放完 → 不算结束（避免疯狂跳歌）', p.isTrackEnded({ track: tr, t: 400, d: 600, paused: true }) === false);
  ok('刚开播 t<1 → 不算结束', p.isTrackEnded({ track: tr, t: 0, d: 600, paused: false }) === false);
  ok('曲目 end 未知 + 视频放完 → 结束', p.isTrackEnded({ track: { start: 0, end: 0 }, t: 433, d: 433, paused: true }) === true);
  ok('曲目 end 未知 + 还在放 → 不算结束', p.isTrackEnded({ track: { start: 0, end: 0 }, t: 433, d: 433, paused: false }) === false);
  ok('没有曲目表 + 视频放完 → 结束', p.isTrackEnded({ track: null, t: 300, d: 300, paused: true }) === true);
  ok('视频最后半秒仍在播放 → 等待完整播完', p.isTrackEnded({ track: { start: 300, end: 400 }, t: 399.8, d: 400, paused: false }) === false);
  ok('末曲时间戳超过视频时长 → 也不提前截断视频', p.isTrackEnded({ track: { start: 300, end: 700 }, t: 599.8, d: 600, paused: false }) === false);
  ok('明确尚未结束 + 手动暂停在末尾 → 不接歌', p.isTrackEnded({ track: tr, t: 599.8, d: 600, paused: true, ended: false }) === false);
  ok('自然结束后网页重置进度 → 仍识别为结束', p.isTrackEnded({ track: tr, t: 0, d: 600, paused: true, ended: true }) === true);
  ok('播完即停不提前半秒截断曲目', p.isTrackEnded({ track: tr, t: 399.8, d: 600, paused: false, ended: false, leadSeconds: 0 }) === false);
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
