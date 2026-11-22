const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildAlbumsFromArchives } = require('../src/bilibili');
const { isTrackEnded } = require('../src/playing');

const video = { bvid: 'BV1234567890', aid: 12, cid: 34, mid: 56, title: '测试专辑', duration: 3600 };

function reply(id, mid, message, details = {}) {
  return { rpid_str: id, mid, content: { message }, ...details };
}

function mockReplies(t, getData) {
  t.mock.method(globalThis, 'fetch', async url => {
    const data = getData(new URL(url));
    return { text: async () => JSON.stringify({ code: 0, data }) };
  });
}

test('置顶评论只附带预览时，分页接上作者的曲目，并重新计算曲尾', async t => {
  const first = reply('102', 900, '00:03:38 – 3. Third\n00:05:56 – 4. Fourth');
  const top = reply('4297090000000000001', 900, '00:00 First\n00:01:55 – 2. Second', { rcount: 21, replies: [first] });
  const noise = Array.from({ length: 19 }, (_, i) => reply(String(110 + i), 901, '07:23 这里好听'));
  const pages = [];
  mockReplies(t, url => {
    if (url.pathname === '/x/v2/reply/main') return { upper: { top }, replies: [top] };
    if (url.pathname === '/x/v2/reply/reply') {
      assert.equal(url.searchParams.get('root'), top.rpid_str);
      const page = Number(url.searchParams.get('pn'));
      pages.push(page);
      return {
        page: { count: 21 },
        replies: page === 1 ? [first, ...noise] : [reply('200', 900, '07:30 Fifth')]
      };
    }
    throw new Error('unexpected route ' + url.pathname);
  });
  const [album] = await buildAlbumsFromArchives([{ ...video, description: '' }]);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(album.tracksSource, 'comment');
  assert.deepEqual(album.tracks.map(t => [t.name, t.start, t.end]), [
    ['First', 0, 115], ['Second', 115, 218], ['Third', 218, 356],
    ['Fourth', 356, 450], ['Fifth', 450, 3600]
  ]);
  assert(isTrackEnded({ track: album.tracks[1], t: 218, d: album.duration, paused: false, ended: false }));
});

test('已知 aid 的批量导入仍读取简介，优先采用更完整的曲目表', async t => {
  const description = '明天 09:00 更新歌单\nTracklist\n[00:00] Artist – First\n[02:47] Artist – Second\nThird 【45:00】\n[1:30:10] 超出视频时长';
  const requests = [];
  mockReplies(t, url => {
    requests.push(url.pathname);
    if (url.pathname === '/x/web-interface/view') return { ...video, desc_v2: [{ raw_text: description }] };
    if (url.pathname === '/x/v2/reply/main') return { replies: [reply('100', 56, '00:00 First\n02:47 Second')] };
    throw new Error('unexpected route ' + url.pathname);
  });
  const [album] = await buildAlbumsFromArchives([video]);
  assert.equal(album.tracksSource, 'description');
  assert.deepEqual(album.tracks, [
    { name: 'Artist – First', start: 0, end: 167 },
    { name: 'Artist – Second', start: 167, end: 2700 },
    { name: 'Third', start: 2700, end: 3600 }
  ]);
  assert.deepEqual(requests.sort(), ['/x/v2/reply/main', '/x/web-interface/view']);
});

test('简介和评论都没有曲目表时，依次回退到章节、完整视频', async t => {
  const withChapter = { ...video, description: '本视频于 12:00 发布', bvid: 'BV1234567891', aid: 13 };
  mockReplies(t, url => {
    if (url.pathname === '/x/v2/reply/main') return { replies: [reply('100', 500, '看到 08:27 的时候有点困')] };
    if (url.pathname.startsWith('/x/player/')) {
      return { view_points: url.searchParams.get('aid') === '13' ? [{ from: 0, content: '序曲' }] : [] };
    }
    return {};
  });
  const [chapter, single] = await buildAlbumsFromArchives([withChapter, { ...video, description: '' }]);
  assert.equal(chapter.tracksSource, 'chapter');
  assert.equal(chapter.tracks[0].name, '序曲');
  assert.equal(single.tracksSource, 'single');
  assert.deepEqual(single.tracks, [{ name: '测试专辑', start: 0, end: 3600 }]);
});
