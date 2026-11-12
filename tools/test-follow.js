const f = require('../src/poll-follow');
let fail = 0;
const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) fail++; };

// 1) 没有手动选中：浏览器换专辑就跟随
{
  const r = f.pollFollow({ playingBvid: 'BV_A', currentAlbumId: 'a1', albumIdOfBvid: 'a1', pin: null });
  ok('无 pin：浏览器放的就是当前视图 → 不跟随', r.follow === false && r.pin === null);
  const r2 = f.pollFollow({ playingBvid: 'BV_B', currentAlbumId: 'a1', albumIdOfBvid: 'a2', pin: null });
  ok('无 pin：浏览器换了专辑 → 跟随', r2.follow === true && r2.pinned === false);
}

// 2) 手动选中 B（浏览器还在放 A）→ 不能被拽回去
{
  const pin = { albumId: 'a2', bvid: 'BV_A' };
  const r = f.pollFollow({ playingBvid: 'BV_A', currentAlbumId: 'a2', albumIdOfBvid: 'a1', pin });
  ok('有 pin：轮询不会跳回正在播的专辑', r.follow === false, JSON.stringify(r));
  ok('有 pin：pin 保持', r.pin && r.pin.albumId === 'a2' && r.pinned === true);
  // 连续几次轮询都一样
  let p = pin, stable = true;
  for (let i = 0; i < 5; i++) {
    const x = f.pollFollow({ playingBvid: 'BV_A', currentAlbumId: 'a2', albumIdOfBvid: 'a1', pin: p });
    if (x.follow) stable = false;
    p = x.pin;
  }
  ok('有 pin：多轮轮询都稳定不跳', stable);
}

// 3) 用户在 B 站自己换了视频 → 解除 pin 并跟随
{
  const pin = { albumId: 'a2', bvid: 'BV_A' };
  const r = f.pollFollow({ playingBvid: 'BV_C', currentAlbumId: 'a2', albumIdOfBvid: 'a3', pin });
  ok('浏览器换视频 → 解除 pin', r.pin === null);
  ok('浏览器换视频 → 跟随新专辑', r.follow === true);
}

// 4) 选中时还不知道浏览器放的是什么（bvid 为空）→ pin 也要生效
{
  const pin = { albumId: 'a2', bvid: '' };
  const r = f.pollFollow({ playingBvid: 'BV_A', currentAlbumId: 'a2', albumIdOfBvid: 'a1', pin });
  ok('pin.bvid 为空时不误判成"换视频"', r.follow === false && r.pin !== null);
}

// 5) 用户又点了别的专辑（视图变了）→ pin 失效，恢复跟随
{
  const pin = { albumId: 'a2', bvid: 'BV_A' };
  const r = f.pollFollow({ playingBvid: 'BV_A', currentAlbumId: 'a9', albumIdOfBvid: 'a1', pin });
  ok('视图已切走 → 不再被 pin 拦住', r.follow === true && r.pinned === false);
}

// 6) 浏览器没有视频（bvid 为空）→ 不跟随
{
  const r = f.pollFollow({ playingBvid: '', currentAlbumId: 'a1', albumIdOfBvid: null, pin: null });
  ok('浏览器没视频 → 不跟随', r.follow === false);
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
