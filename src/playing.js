/**
 * 「正在播放」相关判断（纯函数，方便单测）
 *
 * 背景：关掉「点击专辑直接播放」后，用户可能只是选中别的专辑在看，
 * 这时界面上的"正在播放"、切专辑的基准都必须是**浏览器里真正在放的那张**，
 * 而不是当前选中的那张。
 */

/** 按播放时间找曲目索引（-1 = 没找到） */
function trackIndexAt(album, t) {
  const tracks = (album && album.tracks) || [];
  if (!tracks.length) return -1;
  let i = tracks.findIndex((tr, k) => t >= tr.start && (k === tracks.length - 1 || t < tr.end - 0.2));
  if (i < 0 && t < tracks[0].start) i = 0;
  return i;
}

/** B 站网页标题 → 干净的视频名 */
function cleanVideoTitle(t) {
  return String(t || '')
    .replace(/[_\-|]?\s*哔哩哔哩.*$/, '')
    .replace(/\s*-\s*bilibili\s*$/i, '')
    .trim();
}

/**
 * 解析"正在播放"的专辑 / 曲目 / 进度。
 * - 浏览器里放的是曲库里的专辑 → 用它，曲目按播放时间定位
 * - 浏览器里放的是曲库外的视频 → 仍按真实进度 / 暂停状态显示，曲目名用视频标题占位（别假装暂停）
 * - 什么都没在放 → 退回当前选中项（进度 0、暂停）
 */
function resolvePlaying({ albums, playingBvid, playingT, playingD, playingPaused, playingTitle, currentAlbum, currentTrackIndex }) {
  const list = albums || [];
  const pbAlbum = playingBvid ? list.find(a => a.bvid === playingBvid) : null;
  if (pbAlbum) {
    const i = trackIndexAt(pbAlbum, playingT);
    return {
      album: pbAlbum,
      track: i >= 0 ? pbAlbum.tracks[i] : null,
      trackIndex: Math.max(0, i),
      t: playingT || 0,
      d: playingD || 0,
      paused: !!playingPaused
    };
  }
  if (playingBvid) {
    const dur = Number(playingD) || 0;
    return {
      album: null,
      track: { name: cleanVideoTitle(playingTitle) || '（曲库外的视频）', start: 0, end: dur },
      trackIndex: 0,
      t: Number(playingT) || 0,
      d: dur,
      paused: !!playingPaused,
      external: true
    };
  }
  const a = currentAlbum || null;
  const i = a ? Math.min(currentTrackIndex || 0, Math.max(0, (a.tracks || []).length - 1)) : -1;
  return {
    album: a,
    track: a && i >= 0 ? a.tracks[i] : null,
    trackIndex: Math.max(0, i),
    t: 0,
    d: 0,
    paused: true
  };
}

/**
 * 切「上一张 / 下一张专辑」的基准专辑 id。
 * 手动选中某张专辑查看时（pin 生效），仍以正在播的那张为基准。
 */
function stepBaseAlbumId({ albums, currentAlbumId, pin, playingBvid }) {
  if (pin && pin.albumId === currentAlbumId) {
    const a = (albums || []).find(x => x.bvid === playingBvid);
    if (a) return a.id;
  }
  return currentAlbumId;
}

/**
 * 这首是不是已经放完了（该自动下一首了）。
 * 注意 B 站视频放完会自动暂停 —— 只看「t 到曲尾」不够，还要认「视频已经停在末尾」，
 * 否则一张专辑（=一个视频）的最后一首放完永远等不到下一首。
 * @param {{track:object|null, t:number, d:number, paused:boolean}} arg
 */
function isTrackEnded({ track, t, d, paused }) {
  const cur = Number(t) || 0;
  const dur = Number(d) || 0;
  if (cur < 1) return false;
  // 视频已经放到末尾停住 → 这首肯定结束了（曲目表里的 end 可能比视频短/长）
  if (paused && dur > 0 && cur >= dur - 0.5) return true;
  if (!track || !(track.end > 0)) return false;
  if (cur < track.end - 0.5) return false;
  // 到曲尾且视频还在放（同一张专辑里往后切）
  return !paused;
}

module.exports = { trackIndexAt, resolvePlaying, stepBaseAlbumId, isTrackEnded, cleanVideoTitle };
