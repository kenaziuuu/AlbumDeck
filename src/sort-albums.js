/**
 * 专辑自动排序（纯函数，方便单测）
 * 曲库里没有单独的歌手 / 年份字段，只能从标题里拆：
 *   「孙燕姿 2005 《完美的一天》」→ { artist:'孙燕姿', name:'完美的一天', year:2005 }
 *   「Michael 1987 《Bad》」      → { artist:'Michael', name:'Bad', year:1987 }
 *   「迈克尔·杰克逊 《We Are the World》」→ { artist:'迈克尔·杰克逊', name:'We Are the World', year:0 }
 */

/** 去掉标题里的营销前缀，便于按歌手分组 */
const NOISE = /^(在百万豪装录音棚大声听|百万豪装录音棚|HiRes无损|无损音质|高音质|4K60FPS)\s*/i;

function parseAlbumTitle(title) {
  const t = String(title || '').trim();
  const m = t.match(/《([^》]+)》/);
  const name = (m ? m[1] : t).trim();
  const ym = t.match(/(?:19|20)\d{2}/);
  const year = ym ? Number(ym[0]) : 0;
  let artist = t.split('《')[0]
    .replace(/[【\[][^】\]]*[】\]]/g, ' ')
    .replace(/(?:19|20)\d{2}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  artist = artist.replace(NOISE, '').trim();
  return { artist, name, year };
}

const cmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'zh-Hans-CN');

/**
 * 按指定方式排序（返回新数组，不改原数组）
 * @param {Array} list 专辑数组
 * @param {'name'|'year'|'artist'} by
 */
function sortAlbums(list, by) {
  const arr = [...(list || [])];
  const key = a => parseAlbumTitle(a.title);
  if (by === 'artist') {
    arr.sort((a, b) => {
      const x = key(a), y = key(b);
      return cmp(x.artist, y.artist) || (x.year - y.year) || cmp(x.name, y.name);
    });
  } else if (by === 'year') {
    arr.sort((a, b) => {
      const x = key(a), y = key(b);
      return ((x.year || 9999) - (y.year || 9999)) || cmp(x.name, y.name);
    });
  } else {
    arr.sort((a, b) => {
      const x = key(a), y = key(b);
      return cmp(x.name, y.name) || cmp(x.artist, y.artist);
    });
  }
  return arr;
}

module.exports = { parseAlbumTitle, sortAlbums };
