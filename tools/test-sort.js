const s = require('../src/sort-albums');
let fail = 0;
const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) fail++; };
const j = o => JSON.stringify(o);

// 1) 标题解析
{
  const a = s.parseAlbumTitle('孙燕姿 2005 《完美的一天》');
  ok('解析：孙燕姿 2005', a.artist === '孙燕姿' && a.name === '完美的一天' && a.year === 2005, j(a));
  const b = s.parseAlbumTitle('Michael 1987 《Bad》');
  ok('解析：Michael 1987', b.artist === 'Michael' && b.name === 'Bad' && b.year === 1987, j(b));
  const c = s.parseAlbumTitle('在百万豪装录音棚大声听陈奕迅 《富士山下》');
  ok('解析：去掉营销前缀', c.artist === '陈奕迅' && c.name === '富士山下' && c.year === 0, j(c));
  const d = s.parseAlbumTitle('迈克尔·杰克逊 《We Are the World》');
  ok('解析：没有年份', d.artist === '迈克尔·杰克逊' && d.name === 'We Are the World' && d.year === 0, j(d));
  const e = s.parseAlbumTitle('孙燕姿 2000 《我要的幸福》');
  ok('解析：2000 年不被当成艺术家数字', e.artist === '孙燕姿' && e.year === 2000, j(e));
}

// 2) 三种排序
const albums = [
  { id: '1', title: '孙燕姿 2005 《完美的一天》' },
  { id: '2', title: 'Michael 1987 《Bad》' },
  { id: '3', title: '孙燕姿 2000 《我要的幸福》' },
  { id: '4', title: '迈克尔·杰克逊 《We Are the World》' },
  { id: '5', title: '在百万豪装录音棚大声听陈奕迅 《富士山下》' }
];
const ids = arr => arr.map(a => a.id).join('');

// 中文按拼音、且排在英文前面：富士山下(fu) → 完美(wan) → 我要(wo) → Bad → We Are
ok('按歌名排序',
  ids(s.sortAlbums(albums, 'name')) === '51324', ids(s.sortAlbums(albums, 'name')));
ok('按时间：1987 → 2000 → 2005 → 无年份排最后',
  ids(s.sortAlbums(albums, 'year')) === '23154', ids(s.sortAlbums(albums, 'year')));
ok('按歌手：陈奕迅 → 迈克尔 → 孙燕姿(2000,2005) → Michael',
  ids(s.sortAlbums(albums, 'artist')) === '54312', ids(s.sortAlbums(albums, 'artist')));
ok('排序不改原数组', albums.map(a => a.id).join('') === '12345');
ok('空数组不炸', s.sortAlbums([], 'name').length === 0 && s.sortAlbums(null, 'year').length === 0);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
