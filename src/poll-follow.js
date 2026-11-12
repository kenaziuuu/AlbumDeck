/**
 * 轮询「跟随浏览器」的判断（纯函数，方便单测）
 *
 * 背景：每秒轮询会读浏览器里正在播的视频，正常情况要把视图跟随过去
 * （用户在 B 站自己点了别的专辑）。但关掉「点击专辑直接播放」后，
 * 用户手动选中一张专辑只是看曲目、不播放，这时**不能**被拽回正在播的那张。
 *
 * pin = { albumId, bvid } —— 手动选中的专辑，以及选中那一刻浏览器在放的 bvid。
 *   - 浏览器换了视频（bvid 变了）→ 认为用户自己在 B 站操作，解除 pin
 *   - 选中专辑就是当前视图 → pinned，不跟随
 *   - 视图已经切到别处（用户又点了别的专辑）→ pin 自然失效
 *
 * @param {{playingBvid:string, currentAlbumId:string|null, albumIdOfBvid:string|null, pin:object|null}} arg
 * @returns {{pin:object|null, pinned:boolean, follow:boolean}}
 */
function pollFollow({ playingBvid, currentAlbumId, albumIdOfBvid, pin }) {
  let nextPin = pin || null;
  if (nextPin && nextPin.bvid && playingBvid && playingBvid !== nextPin.bvid) nextPin = null;
  const pinned = !!(nextPin && nextPin.albumId === currentAlbumId);
  const follow = !!(playingBvid && !pinned && albumIdOfBvid && albumIdOfBvid !== currentAlbumId);
  return { pin: nextPin, pinned, follow };
}

module.exports = { pollFollow };
