/* 用模拟浏览器轮询实际主进程逻辑，不启动 Electron，也不读写用户曲库。 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DEFAULT_SETTINGS } = require('../src/store');

const mainPath = path.join(__dirname, '../src/main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const mainRequire = createRequire(mainPath);

function fixture(mode = 'all-loop') {
  let now = 100000;
  const data = {
    albums: ['A', 'B', 'C'].map(id => ({
      id, bvid: `BV_${id}`, title: id, duration: 400,
      tracks: [0, 100, 200, 300].map((start, i) => ({ name: `${id}${i}`, start, end: start + 100 }))
    })),
    folders: [], current: { albumId: 'C', trackIndex: 0 },
    settings: { ...DEFAULT_SETTINGS, playMode: mode }, queue: null
  };
  const store = {
    data, save() {},
    get albums() { return data.albums; },
    get folders() { return data.folders; },
    get current() { return data.current; },
    get settings() { return data.settings; },
    patch(patch) { Object.assign(data, patch); },
    patchSettings(patch) { Object.assign(data.settings, patch); }
  };
  const commands = [];
  const browser = {
    connected: true, ws: { readyState: 1 }, lastState: { ok: true }, report: {},
    disconnect() { this.connected = false; },
    async state() { this.lastState = this.report; return this.report; },
    async setPauseAtEnd() { this.pauseAtEnd = true; return { ok: true }; },
    async seek(t) {
      commands.push({ albumId: data.current.albumId, t });
      this.report = { ok: true, bvid: `BV_${data.current.albumId}`, t, d: 400, paused: false };
    },
    async openVideo(bvid, t) {
      commands.push({ albumId: data.current.albumId, t });
      this.report = { ok: true, bvid, t, d: 400, paused: false };
    }
  };
  const context = vm.createContext({
    require: name => name === 'electron'
      ? { app: { requestSingleInstanceLock: () => false, quit() {} } }
      : mainRequire(name),
    __dirname: path.dirname(mainPath),
    process: { argv: [] }, console, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return now; } },
    testStore: store, testBrowser: browser
  });
  vm.runInContext(mainSource + `
    store = testStore; cdp = testBrowser;
    globalThis.deck = { playFolderItem, playAt, nextTrack, prevTrack, pollOnce, selectAlbum,
      rebuildQueue, syncFolderQueue, clearFolderQueue, ensureQueue, snapshot };
  `, context, { filename: mainPath });
  const deck = context.deck;
  const song = (albumId, trackIndex) => ({ kind: 'song', albumId, bvid: `BV_${albumId}`, start: trackIndex * 100 });
  const songFolder = { id: 'songs', name: '歌曲夹', type: 'song', items: [song('A', 0), song('A', 2), song('B', 1)] };
  const albumFolder = { id: 'albums', name: '专辑夹', type: 'album', items: ['A', 'B'].map(albumId => ({ kind: 'album', albumId, bvid: `BV_${albumId}` })) };
  data.folders.push(songFolder, albumFolder);
  return {
    data, deck, song, commands, songFolder, browser,
    queue: () => Array.from(data.queue.items, it => `${it.albumId}:${it.trackIndex}`),
    async poll(albumId, t, extra = {}, elapsedMs = 10000) {
      now += elapsedMs; // 默认跳过切歌保护期，也可模拟加载中的轮询和延迟历史恢复。
      browser.report = { ok: true, bvid: `BV_${albumId}`, t, d: 400, paused: false, ...extra };
      await deck.pollOnce();
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

test('歌曲夹：越过曲尾后跳到下一首收藏歌曲，跳过视频中未收藏的歌', async () => {
  const f = fixture();
  await f.deck.playFolderItem('songs', f.song('A', 0));
  await f.poll('A', 101);
  assert.deepEqual({ ...f.data.current }, { albumId: 'A', trackIndex: 2 });
  assert.deepEqual(f.commands.at(-1), { albumId: 'A', t: 200 });
  assert.deepEqual(f.queue(), ['A:0', 'A:2', 'B:1']);
});

test('歌曲夹：曲尾自动切到另一张专辑里的收藏歌曲', async () => {
  const f = fixture();
  await f.deck.playFolderItem('songs', f.song('A', 2));
  await f.poll('A', 301);
  assert.deepEqual({ ...f.data.current }, { albumId: 'B', trackIndex: 1 });
  assert.deepEqual(f.commands.at(-1), { albumId: 'B', t: 100 });
});

test('歌曲夹：最后一首收藏歌曲结束就回到第一首，无需等整段视频结束', async () => {
  const f = fixture();
  await f.deck.playFolderItem('songs', f.song('B', 1));
  await f.poll('B', 201);
  assert.deepEqual({ ...f.data.current }, { albumId: 'A', trackIndex: 0 });
  assert.equal(f.data.queue.pos, 0);
  assert.equal(f.data.queue.source.id, 'songs');
});

test('歌曲夹：单曲循环始终重播所点歌曲', async () => {
  const f = fixture('one');
  await f.deck.playFolderItem('songs', f.song('A', 0));
  await f.poll('A', 101);
  assert.deepEqual({ ...f.data.current }, { albumId: 'A', trackIndex: 0 });
  assert.deepEqual(f.commands.at(-1), { albumId: 'A', t: 0 });
});

test('歌曲夹：暂停在曲中或曲尾时不自动跳歌', async () => {
  const f = fixture();
  await f.deck.playFolderItem('songs', f.song('A', 0));
  await f.poll('A', 50, { paused: true });
  await f.poll('A', 100, { paused: true });
  assert.equal(f.commands.length, 1);
  assert.deepEqual({ ...f.data.current }, { albumId: 'A', trackIndex: 0 });
});

test('专辑夹：专内循环只列出所点专辑，上一首和下一首都留在该专辑', async () => {
  const f = fixture('album-loop');
  await f.deck.playFolderItem('albums', f.song('B', 3));
  assert.deepEqual(f.queue(), ['B:0', 'B:1', 'B:2', 'B:3']);
  await f.deck.nextTrack();
  assert.deepEqual({ ...f.data.current }, { albumId: 'B', trackIndex: 0 });
  await f.deck.prevTrack();
  assert.deepEqual({ ...f.data.current }, { albumId: 'B', trackIndex: 3 });
});

test('专辑夹：视频末尾暂停后，专内循环自动回到同一专辑第一首', async () => {
  const f = fixture('album-loop');
  await f.deck.playFolderItem('albums', f.song('B', 3));
  await f.poll('B', 400, { paused: true, ended: true });
  assert.deepEqual({ ...f.data.current }, { albumId: 'B', trackIndex: 0 });
  assert.equal(f.data.queue.source.id, 'albums');
});

test('专辑夹：从全专循环切换为专内循环，按正在播放的专辑缩小队列', async () => {
  const f = fixture();
  await f.deck.playFolderItem('albums', f.song('B', 2));
  assert.equal(f.queue().length, 8);
  f.data.settings.playMode = 'album-loop';
  f.deck.ensureQueue();
  assert.deepEqual(f.queue(), ['B:0', 'B:1', 'B:2', 'B:3']);
  assert.equal(f.data.queue.pos, 2);
});

test('专辑夹：查看另一张专辑及收藏夹内容变动不改变正在播放的范围', async () => {
  const f = fixture('album-loop');
  await f.deck.playFolderItem('albums', f.song('B', 2));
  f.deck.selectAlbum('A');
  f.deck.syncFolderQueue('albums');
  assert.deepEqual(f.queue(), ['B:0', 'B:1', 'B:2', 'B:3']);
});

test('专辑夹：专内随机队列只含所点专辑，播放一轮后也不越界', async () => {
  const f = fixture('album-shuffle');
  await f.deck.playFolderItem('albums', f.song('B', 2));
  assert.deepEqual(f.queue().sort(), ['B:0', 'B:1', 'B:2', 'B:3']);
  for (let i = 0; i < 8; i++) {
    await f.deck.nextTrack();
    assert.equal(f.data.current.albumId, 'B');
  }
});

test('歌曲夹：专内循环仍只播放收藏的歌曲，不补入所在专辑的其他歌曲', async () => {
  const f = fixture('album-loop');
  await f.deck.playFolderItem('songs', f.song('A', 0));
  assert.deepEqual(f.queue(), ['A:0', 'A:2', 'B:1']);
  await f.poll('A', 101);
  assert.deepEqual({ ...f.data.current }, { albumId: 'A', trackIndex: 2 });
});

test('曲库：正常顺序播放也按当前队列推进，整库末尾回到开头', async () => {
  const f = fixture();
  await f.deck.playAt('A', 0);
  await f.poll('A', 101);
  assert.deepEqual({ ...f.data.current }, { albumId: 'A', trackIndex: 1 });
  await f.deck.playAt('C', 3);
  await f.poll('C', 400, { paused: true, ended: true });
  assert.deepEqual({ ...f.data.current }, { albumId: 'A', trackIndex: 0 });
});

test('首次连接已播放到中间的浏览器时，接上真实曲目且不跳歌', async () => {
  const f = fixture();
  f.deck.rebuildQueue();
  await f.poll('C', 250);
  assert.deepEqual({ ...f.data.current }, { albumId: 'C', trackIndex: 2 });
  assert.equal(f.data.queue.pos, 10);
  assert.equal(f.commands.length, 0);
});

test('浏览器手动换到收藏夹之外的视频，跟随进度并退出原收藏夹队列', async () => {
  const f = fixture();
  await f.deck.playFolderItem('songs', f.song('A', 0));
  await f.poll('C', 250);
  assert.deepEqual({ ...f.data.current }, { albumId: 'C', trackIndex: 2 });
  assert.equal(!!f.data.queue.source, false);
  assert.equal(f.commands.length, 1);
});

test('曲库单曲循环：同一专辑改点另一首后，队列和实际循环目标同步', async () => {
  const f = fixture('one');
  await f.deck.playAt('A', 0);
  await f.deck.playAt('A', 2);
  assert.deepEqual(f.queue(), ['A:2']);
  await f.poll('A', 301);
  assert.deepEqual(f.commands.at(-1), { albumId: 'A', t: 200 });
});

test('单首歌曲收藏夹：在专辑中间的歌曲结束后立即重播自身', async () => {
  const f = fixture();
  f.songFolder.items = [f.song('A', 1)];
  await f.deck.playFolderItem('songs', f.song('A', 1));
  await f.poll('A', 201);
  assert.deepEqual(f.queue(), ['A:1']);
  assert.deepEqual(f.commands.at(-1), { albumId: 'A', t: 100 });
});

test('歌曲夹：自动推进时跳过已隐藏的收藏歌曲', async () => {
  const f = fixture();
  f.data.albums[0].tracks[2].hidden = true;
  await f.deck.playFolderItem('songs', f.song('A', 0));
  await f.poll('A', 101);
  assert.deepEqual(f.commands.at(-1), { albumId: 'B', t: 100 });
});

test('专辑夹：切回全专循环后展开收藏夹内的专辑，改点另一专辑会重新缩小范围', async () => {
  const f = fixture('album-loop');
  await f.deck.playFolderItem('albums', f.song('B', 2));
  f.data.settings.playMode = 'all-loop';
  f.deck.rebuildQueue();
  assert.deepEqual(f.queue(), ['A:0', 'A:1', 'A:2', 'A:3', 'B:0', 'B:1', 'B:2', 'B:3']);
  f.data.settings.playMode = 'album-loop';
  await f.deck.playFolderItem('albums', f.song('A', 1));
  assert.deepEqual(f.queue(), ['A:0', 'A:1', 'A:2', 'A:3']);
  assert.equal(f.data.queue.pos, 1);
});

test('应用点歌会开启 B 站播完暂停，由应用接管连播', async () => {
  const f = fixture('album-loop');
  await f.deck.playFolderItem('albums', f.song('B', 3));
  assert.equal(f.browser.pauseAtEnd, true);
});

test('播完暂停：不依赖 ended 标记，也能在视频末尾自动回本专辑第一首', async () => {
  const f = fixture('album-loop');
  await f.deck.playFolderItem('albums', f.song('B', 3));
  await f.poll('B', 400, { paused: true, ended: false });
  assert.deepEqual(f.commands.at(-1), { albumId: 'B', t: 0 });
  assert.deepEqual(f.queue(), ['B:0', 'B:1', 'B:2', 'B:3']);
});

test('B 站抢先自动换到另一张专辑时，专内循环仍保留原队列并回到原专辑', async () => {
  const f = fixture('album-loop');
  await f.deck.playFolderItem('albums', f.song('B', 3));
  await f.poll('B', 399);
  await f.poll('A', 0);
  assert.deepEqual(f.commands.at(-1), { albumId: 'B', t: 0 });
  assert.deepEqual(f.queue(), ['B:0', 'B:1', 'B:2', 'B:3']);
  assert.equal(f.data.queue.source.id, 'albums');
});

test('B 站抢先换到曲库外的视频时，仍从收藏歌曲队列接歌', async () => {
  const f = fixture();
  f.songFolder.items = [f.song('A', 3), f.song('B', 1)];
  await f.deck.playFolderItem('songs', f.song('A', 3));
  await f.poll('A', 399);
  await f.poll('OUTSIDE', 0);
  assert.deepEqual(f.commands.at(-1), { albumId: 'B', t: 100 });
  assert.deepEqual(f.queue(), ['A:3', 'B:1']);
  assert.equal(f.data.queue.source.id, 'songs');
});

test('不提前两秒切歌，视频最后半秒也等待原生结束', async () => {
  const f = fixture('album-loop');
  await f.deck.playFolderItem('albums', f.song('B', 2));
  await f.poll('B', 298);
  assert.equal(f.commands.length, 1);
  await f.deck.playFolderItem('albums', f.song('B', 3));
  await f.poll('B', 398);
  assert.equal(f.commands.length, 2);
  await f.poll('B', 399.8);
  assert.equal(f.commands.length, 2);
  await f.poll('B', 400, { paused: true, ended: true });
  assert.deepEqual(f.commands.at(-1), { albumId: 'B', t: 0 });
});

test('点第 2 首后网页恢复到第 4 首，重新定位第 2 首，不推进或替换原队列', async () => {
  const f = fixture('album-loop');
  await f.deck.playFolderItem('albums', f.song('B', 1));
  await f.poll('B', 350, {}, 3000);
  assert.deepEqual(f.commands.at(-1), { albumId: 'B', t: 100 });
  assert.deepEqual({ ...f.data.current }, { albumId: 'B', trackIndex: 1 });
  assert.equal(f.data.queue.pos, 1);
  assert.equal(f.data.queue.source.id, 'albums');
});

test('先正确播放几秒后才恢复历史进度，点歌目标仍优先', async () => {
  const f = fixture('album-loop');
  await f.deck.playFolderItem('albums', f.song('B', 1));
  await f.poll('B', 103, {}, 3000);
  assert.equal(f.commands.length, 1);
  await f.poll('B', 350, {}, 3000);
  assert.deepEqual(f.commands.at(-1), { albumId: 'B', t: 100 });
  assert.deepEqual({ ...f.data.current }, { albumId: 'B', trackIndex: 1 });
});

test('视频加载超过原保护期，旧页面轮询不能改掉刚点的曲目和队列', async () => {
  const f = fixture('album-loop');
  let finish;
  f.browser.openVideo = () => new Promise(resolve => { finish = resolve; });
  const request = f.deck.playAt('A', 1);
  await new Promise(resolve => setImmediate(resolve));
  await f.poll('C', 350, {}, 5000);
  assert.deepEqual({ ...f.data.current }, { albumId: 'A', trackIndex: 1 });
  assert.deepEqual(f.queue(), ['A:0', 'A:1', 'A:2', 'A:3']);
  finish({ ok: true });
  await request;
});

test('连续点两张专辑，较早完成得更晚的请求不能覆盖最后一次点歌', async () => {
  const f = fixture('album-loop');
  let finish;
  f.browser.openVideo = async (bvid, t) => {
    if (bvid === 'BV_A') return new Promise(resolve => { finish = resolve; });
    f.browser.report = { ok: true, bvid, t, d: 400, paused: false };
  };
  const first = f.deck.playAt('A', 1);
  await new Promise(resolve => setImmediate(resolve));
  await f.deck.playAt('B', 2);
  finish({ ok: true });
  await first;
  assert.deepEqual({ ...f.data.current }, { albumId: 'B', trackIndex: 2 });
  assert.equal(f.deck.snapshot().playing.album.id, 'B');
});

test('新页面加载期间短暂读取失败，不断开点歌所需的浏览器连接', async () => {
  const f = fixture('album-loop');
  let finish;
  f.browser.openVideo = () => new Promise(resolve => { finish = resolve; });
  const request = f.deck.playAt('A', 1);
  await new Promise(resolve => setImmediate(resolve));
  f.browser.state = async () => { throw new Error('Execution context was destroyed'); };
  await f.poll('C', 350, {}, 5000);
  assert.equal(f.browser.connected, true);
  assert.deepEqual({ ...f.data.current }, { albumId: 'A', trackIndex: 1 });
  finish({ ok: true });
  assert.equal(await request, true);
});
