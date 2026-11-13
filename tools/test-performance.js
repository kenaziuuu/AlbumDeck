const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StatePublisher, createDecoder } = require('../src/state-packets');
const { Store } = require('../src/store');
const policy = require('./package-policy');
const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const albums = ['a', 'b'].map(id => ({ id, bvid: `BV${id}`, tracks: [0, 100].map(start => ({ name: id + start, start, end: start + 100 })) }));
  return { albums, folders: [], settings: { playMode: 'all-loop' }, playModes: [], dataRevision: 1,
    queue: { items: [{ albumId: 'a', trackIndex: 0 }], pos: 0, rev: 1, source: null, mode: 'all-loop' },
    current: { albumId: 'b', trackIndex: 1, album: albums[1], track: albums[1].tracks[1] },
    playing: { album: albums[0], track: albums[0].tracks[0], trackIndex: 0, t: 50, d: 200, paused: false },
    playback: { t: 50, paused: false }, conn: { connected: true }, message: '', importBusy: false };
}

test('增量状态往返保留查看项与正在播放项，进度包不再带完整曲库', () => {
  const s = fixture(), sender = new StatePublisher(), target = {}, decode = createDecoder();
  let state = decode(clone(sender.packet(s, 1, target)));
  assert.deepEqual(state, s);
  const albums = state.albums, folders = state.folders;
  s.playing.t = 55; s.playback.t = 55;
  const packet = clone(sender.packet(s, 1, target));
  assert.equal('data' in packet, false);
  assert.ok(JSON.stringify(packet).length < 800);
  state = decode(packet);
  assert.equal(state.albums, albums);
  assert.equal(state.folders, folders);
  assert.equal(state.current.album.id, 'b');
  assert.equal(state.playing.album.id, 'a');
  assert.equal(state.playing.t, 55);
});

test('改歌名、收藏夹和随机队列后重传数据；只改变选中项和位置则不重传', () => {
  const s = fixture(), sender = new StatePublisher(), target = {}, decode = createDecoder();
  decode(clone(sender.packet(s, 1, target)));
  s.current.trackIndex = 0; s.current.track = s.albums[1].tracks[0]; s.queue.pos = 1;
  assert.equal('data' in sender.packet(s, 2, target), false);
  s.albums[0].tracks[0].name = '已改名';
  s.folders.push({ id: 'songs', items: [{ key: 'song:BVa:0' }] });
  s.queue.items.reverse(); s.queue.items.push({ albumId: 'b', trackIndex: 1 });
  const packet = clone(sender.packet(s, 3, target));
  assert.ok(packet.data);
  const state = decode(packet);
  assert.equal(state.playing.track.name, '已改名');
  assert.equal(state.folders[0].id, 'songs');
  assert.equal(state.queue.items.length, 2);
  assert.ok(sender.packet(s, 3, {}).data, '新窗口必须获得完整数据');
});

test('初始事件丢失时可从 state() 初始化；过期响应不会覆盖新数据', () => {
  const s = fixture(), sender = new StatePublisher(), target = {}, decode = createDecoder();
  sender.packet(s, 1, target); // 页面尚未装好监听器。
  decode(clone(s));
  const initial = decode(clone(s));
  const first = decode(clone(sender.packet(s, 1, target)));
  assert.equal(first.playing.t, 50);
  assert.equal(first.albums, initial.albums);
  const stale = clone(s);
  s.albums[0].tracks[0].name = '最新歌名';
  decode(clone(sender.packet(s, 2, target)));
  assert.equal(decode(stale).playing.track.name, '最新歌名');
});

test('曲库外视频和空曲目不被误解析成曲库第一首', () => {
  const s = fixture(), sender = new StatePublisher(), target = {}, decode = createDecoder();
  s.playing = { album: null, track: { name: '外部视频', start: 0, end: 100 }, external: true, trackIndex: 0, t: 50, d: 100, paused: true };
  assert.deepEqual(decode(clone(sender.packet(s, 1, target))).playing, s.playing);
  s.playing = { album: s.albums[0], track: null, trackIndex: 0, t: 0, d: 0, paused: true };
  assert.equal(decode(clone(sender.packet(s, 1, target))).playing.track, null);
});

test('重复保存不写盘，拖动合并保存，退出前 flush 保留最后位置', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'albumdeck-save-test-'));
  const store = new Store(dir), original = fs.writeFileSync;
  let writes = 0;
  fs.writeFileSync = function(file, ...args) { if (file === store.file) writes++; return original.call(this, file, ...args); };
  try {
    store.save();
    for (let i = 0; i < 20; i++) store.save();
    assert.equal(writes, 1);
    for (let i = 0; i < 20; i++) { store.data.miniBounds = { x: i, y: 20 }; store.scheduleSave(); }
    assert.equal(writes, 1);
    await new Promise(resolve => setTimeout(resolve, 320));
    assert.equal(writes, 2);
    assert.equal(JSON.parse(fs.readFileSync(store.file)).miniBounds.x, 19);
    store.data.miniBounds.x = 99; store.scheduleSave(); store.flush();
    assert.equal(writes, 3);
    assert.equal(new Store(dir).data.miniBounds.x, 99);
  } finally {
    store.flush(); fs.writeFileSync = original;
    if (fs.existsSync(store.file)) fs.unlinkSync(store.file);
    fs.rmdirSync(dir);
  }
});

test('发布过滤保留中英文、全部 DLL 和许可证，移除默认示例与其他语言', () => {
  for (const file of ['locales/en-US.pak', 'locales/zh-CN.pak', 'locales/zh-TW.pak', 'dxcompiler.dll', 'vk_swiftshader.dll', 'LICENSES.chromium.html', 'resources.pak']) {
    assert.equal(policy.includeRuntime(file), true, file);
  }
  for (const file of ['locales/fr.pak', 'locales/de.pak', 'resources/default_app.asar']) assert.equal(policy.includeRuntime(file), false, file);
  for (const asset of policy.assets) assert.equal(fs.existsSync(path.join(__dirname, '../assets', asset)), true, asset);
  assert.equal(policy.assets.some(file => file.startsWith('preview')), false);
});
