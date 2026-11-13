/* 用模拟浏览器轮询实际主进程逻辑，不启动 Electron，也不读写用户曲库。 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Store, DEFAULT_SETTINGS } = require('../src/store');

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
  const playRequests = [];
  const browser = {
    connected: true, ws: { readyState: 1 }, lastState: { ok: true }, report: {},
    disconnect() { this.connected = false; },
    async state() { this.lastState = this.report; return this.report; },
    async setPauseAtEnd() { this.pauseAtEnd = true; return { ok: true }; },
    cancelPendingPlay() {},
    async togglePlay(force = '') {
      this.report.paused = force ? force === 'pause' : !this.report.paused;
      this.lastState = this.report;
      return { ok: true, paused: this.report.paused };
    },
    async seek(t, play = true) {
      commands.push({ albumId: data.current.albumId, t });
      playRequests.push(play);
      this.report = { ok: true, bvid: `BV_${data.current.albumId}`, t, d: 400, paused: !play, ended: false };
      this.lastState = this.report;
    },
    async openVideo(bvid, t, play = true) {
      commands.push({ albumId: data.current.albumId, t });
      playRequests.push(play);
      this.report = { ok: true, bvid, t, d: 400, paused: !play, ended: false };
      this.lastState = this.report;
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
      rebuildQueue, syncFolderQueue, clearFolderQueue, ensureQueue, snapshot, togglePlay, setPlayMode, seekTo };
  `, context, { filename: mainPath });
  const deck = context.deck;
  const song = (albumId, trackIndex) => ({ kind: 'song', albumId, bvid: `BV_${albumId}`, start: trackIndex * 100 });
  const songFolder = { id: 'songs', name: '歌曲夹', type: 'song', items: [song('A', 0), song('A', 2), song('B', 1)] };
  const albumFolder = { id: 'albums', name: '专辑夹', type: 'album', items: ['A', 'B'].map(albumId => ({ kind: 'album', albumId, bvid: `BV_${albumId}` })) };
  data.folders.push(songFolder, albumFolder);
  return {
    data, deck, song, commands, playRequests, songFolder, browser,
    queue: () => Array.from(data.queue.items, it => `${it.albumId}:${it.trackIndex}`),
    async poll(albumId, t, extra = {}, elapsedMs = 10000) {
      now += elapsedMs; // 默认跳过切歌保护期，也可模拟加载中的轮询和延迟历史恢复。
      browser.report = { ok: true, bvid: `BV_${albumId}`, t, d: 400, paused: false, ended: false, ...extra };
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

test('播完暂停：缺少 ended 字段时兼容视频末尾状态并回本专辑第一首', async () => {
  const f = fixture('album-loop');
  await f.deck.playFolderItem('albums', f.song('B', 3));
  await f.poll('B', 400, { paused: true, ended: undefined });
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

for (const mode of ['one', 'album-loop', 'album-shuffle', 'all-loop', 'album-random', 'song-shuffle']) {
  test(`${mode}：旧自动播放设置为 false，视频自然结束后仍接歌并实际播放`, async () => {
    const f = fixture(mode);
    f.data.settings.autoPlay = false;
    await f.deck.playFolderItem('albums', f.song('B', 3));
    await f.poll('B', 400, { paused: true, ended: true });
    assert.equal(f.playRequests.at(-1), true);
    assert.equal(f.browser.report.paused, false);
    assert.equal(f.data.queue.source.id, 'albums');
    if (['one', 'album-loop', 'album-shuffle'].includes(mode)) assert.equal(f.data.current.albumId, 'B');
    if (mode === 'album-loop') assert.equal(f.data.current.trackIndex, 0);
    if (mode === 'one') assert.equal(f.data.current.trackIndex, 3);
  });
}

test('浏览器手动暂停在最后半秒且 ended=false，不自动跳歌或恢复播放', async () => {
  const f = fixture('album-loop');
  await f.deck.playAt('B', 3);
  await f.poll('B', 399.8, { paused: true, ended: false });
  assert.equal(f.commands.length, 1);
  assert.equal(f.browser.report.paused, true);
  assert.equal(f.data.current.trackIndex, 3);
});

test('播完即停：本曲结束后暂停，保留曲目和队列，不自动接歌', async () => {
  const f = fixture('once');
  await f.deck.playFolderItem('songs', f.song('A', 0));
  assert.deepEqual(f.queue(), ['A:0']);
  await f.poll('A', 100.2);
  assert.equal(f.commands.length, 1);
  assert.equal(f.browser.report.paused, true);
  assert.equal(f.deck.snapshot().playing.trackIndex, 0);
  await f.poll('A', 100.2, { paused: true });
  assert.equal(f.commands.length, 1);
  await f.deck.togglePlay();
  assert.deepEqual(f.commands.at(-1), { albumId: 'A', t: 0 });
  assert.equal(f.browser.report.paused, false);
});

test('播完即停：视频自然结束后不重播，网页抢先切集也不自动播放别的歌', async () => {
  const f = fixture('once');
  await f.deck.playAt('B', 3);
  await f.poll('B', 399);
  await f.poll('A', 0);
  assert.equal(f.data.current.albumId, 'B');
  assert.equal(f.data.current.trackIndex, 3);
  assert.equal(f.browser.report.paused, true);
  const count = f.commands.length;
  await f.poll('B', 400, { paused: true, ended: true });
  assert.equal(f.commands.length, count);
});

test('手动暂停后切换任意播放方式，都不会自动恢复播放', async () => {
  const f = fixture('album-loop');
  await f.deck.playAt('B', 1);
  await f.deck.togglePlay();
  for (const mode of f.deck.snapshot().playModes) {
    f.deck.setPlayMode(mode.key);
    assert.equal(f.browser.report.paused, true);
    assert.equal(f.commands.length, 1);
  }
  await f.poll('B', 150, { paused: true });
  assert.equal(f.commands.length, 1);
});

test('拖进度保持暂停或播放状态，手动暂停后历史进度纠正也不恢复播放', async () => {
  const f = fixture('album-loop');
  await f.deck.playAt('B', 1);
  await f.deck.togglePlay();
  await f.poll('B', 350, { paused: true }, 3000);
  assert.equal(f.browser.report.paused, true);
  assert.equal(f.playRequests.at(-1), false);
  await f.deck.seekTo(150);
  assert.equal(f.browser.report.paused, true);
  await f.deck.togglePlay();
  await f.deck.seekTo(160);
  assert.equal(f.browser.report.paused, false);
});

test('手动暂停会覆盖同时返回的旧 ended 轮询', async () => {
  const f = fixture('album-loop');
  await f.deck.playAt('B', 3);
  let finish;
  f.browser.state = () => new Promise(resolve => { finish = resolve; });
  const poll = f.poll('B', 400, { paused: true, ended: true });
  f.browser.report = { ok: true, bvid: 'BV_B', t: 399.8, d: 400, paused: false, ended: false };
  await f.deck.togglePlay();
  finish({ ok: true, bvid: 'BV_B', t: 400, d: 400, paused: true, ended: true });
  await poll;
  assert.equal(f.commands.length, 1);
  assert.equal(f.browser.report.paused, true);
});

test('播完即停：视频自然结束后保持本曲和暂停状态，按播放才重播', async () => {
  const f = fixture('once');
  await f.deck.playAt('B', 3);
  await f.poll('B', 400, { paused: true, ended: true });
  assert.equal(f.commands.length, 1);
  assert.equal(f.deck.snapshot().playing.trackIndex, 3);
  await f.poll('B', 400, { paused: true, ended: true });
  assert.equal(f.commands.length, 1);
  await f.deck.togglePlay();
  assert.deepEqual(f.commands.at(-1), { albumId: 'B', t: 300 });
  assert.equal(f.browser.report.paused, false);
});

test('播完即停的旧暂停请求返回时，不覆盖用户新点的歌曲', async () => {
  const f = fixture('once');
  await f.deck.playAt('A', 0);
  const toggle = f.browser.togglePlay.bind(f.browser);
  let finish;
  f.browser.togglePlay = async force => {
    const result = await toggle(force);
    return new Promise(resolve => { finish = () => resolve(result); });
  };
  const end = f.poll('A', 100.2);
  await new Promise(resolve => setImmediate(resolve));
  await f.deck.playAt('B', 2);
  finish();
  await end;
  const state = f.deck.snapshot();
  assert.equal(state.playing.album.id, 'B');
  assert.equal(state.playing.trackIndex, 2);
  assert.equal(state.playing.paused, false);
  assert.equal(f.browser.report.paused, false);
});

test('升级移除旧自动播放配置，保留曲库、播放方式和其他设置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'albumdeck-settings-test-'));
  const file = path.join(dir, 'album-deck.json');
  try {
    for (const autoPlay of [false, true]) {
      const albums = [{ id: 'saved-album', bvid: 'BV_saved', tracks: [] }];
      fs.writeFileSync(file, JSON.stringify({ albums, settings: { autoPlay, playMode: 'album-loop', skipHidden: false } }));
      const store = new Store(dir);
      assert.equal('autoPlay' in store.settings, false);
      assert.deepEqual(store.albums, albums);
      assert.equal(store.settings.playMode, 'album-loop');
      assert.equal(store.settings.skipHidden, false);
      store.patchSettings({ autoPlay: true, miniVisible: false });
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal('autoPlay' in saved.settings, false);
      assert.equal(saved.settings.miniVisible, false);
      assert.deepEqual(saved.albums, albums);
    }
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});
