/** 生成随应用附带的示例曲库（截图里 HiRes无损体验馆 · 孙燕姿系列） */
const fs = require('fs');
const path = require('path');
const b = require('../src/bilibili.js');
const MID = 3493093722556825, SEASON = 947238;
(async () => {
  await b.ensureKeys();
  const all = await b.getSeasonArchives(MID, SEASON);
  console.log('season archives:', all.length);
  const picked = all.filter(a => /孙燕姿/.test(a.title));
  console.log('孙燕姿 albums:', picked.length);
  // 截图那张放最前
  picked.sort((x, y) => (y.bvid === 'BV1Tw411G74d') - (x.bvid === 'BV1Tw411G74d'));
  const albums = await b.buildAlbumsFromArchives(picked.slice(0, 12), (d, t, a) => {
    console.log(`  ${d}/${t} ${a.title} -> ${a.tracks.length} 首${a.tracksOk ? '' : ' (无曲目表)'}`);
  }, 2);
  const out = { name: 'HiRes无损专辑（1） · 孙燕姿系列', albums: albums.filter(a => a.tracksOk) };
  fs.writeFileSync(path.join(__dirname, '..', 'assets', 'seed-library.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('written albums with tracks:', out.albums.length);
})().catch(e => { console.error(e); process.exit(1); });
