/* 独立切换视频流，验证普通高码率 / Hi-Res 音频、暂停状态和开关均保留。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CdpController, VIDEO_360_EXPR } = require('../src/controller');
const { Store } = require('../src/store');

function fixture({ audio = 2, video = 2, autoVideo = true, autoAudio = true, videoList } = {}) {
  const calls = [];
  const quality = { audio, video }, auto = { audio: autoAudio, video: autoVideo };
  const media = { currentTime: 123, duration: 400, paused: true, ended: false, readyState: 4, seeking: false, playbackRate: 1 };
  const lists = {
    video: videoList || [
      { qualityIndex: 0, width: 640, height: 360, bitrate: 100000 },
      { qualityIndex: 1, width: 1280, height: 720, bitrate: 500000 },
      { qualityIndex: 2, width: 1920, height: 1080, bitrate: 2000000 }
    ],
    audio: [0, 1, 2].map(qualityIndex => ({ qualityIndex }))
  };
  const dash = {
    getBitrateInfoListFor: type => lists[type],
    getQualityFor: type => quality[type],
    getAutoSwitchQualityFor: type => auto[type],
    setQualityFor(type, value) { calls.push(['quality', type, value]); quality[type] = value; }
  };
  const core = { player: dash, setAutoSwitchQualityFor(type, value) { calls.push(['auto', type, value]); auto[type] = value; } };
  const context = vm.createContext({ window: { player: { __core: () => core } }, location: { href: 'https://www.bilibili.com/video/BV0000000001/' }, document: {
    title: 'Test', readyState: 'complete', addEventListener() {},
    querySelectorAll: selector => selector === 'video' ? [media] : [],
    querySelector: () => null
  } });
  return { calls, quality, auto, lists, media, context, core, run: () => vm.runInContext(VIDEO_360_EXPR, context) };
}

for (const audio of [0, 2]) {
  test(`360P 只切换视频，保留音频表示 ${audio} 及音频自适应设置`, () => {
    const f = fixture({ audio });
    const result = f.run();
    assert.equal(result.ok, true);
    assert.equal(result.audioUnchanged, true);
    assert.equal(f.quality.video, 0);
    assert.equal(f.quality.audio, audio);
    assert.equal(f.auto.audio, true);
    assert.equal(f.media.currentTime, 123);
    assert.equal(f.media.paused, true);
    assert.deepEqual(f.calls, [['auto', 'video', false], ['quality', 'video', 0]]);
    f.run();
    assert.equal(f.calls.length, 2, '反复轮询不重复切换');
  });
}

test('Hi-Res 独立音频轨只有一个表示时，不切回普通音频', () => {
  const f = fixture({ audio: 0, autoAudio: false });
  f.lists.audio = [{ qualityIndex: 0, codec: 'flac', bitrate: 1500000 }];
  assert.equal(f.run().ok, true);
  assert.equal(f.quality.audio, 0);
  assert.equal(f.auto.audio, false);
  assert.equal(f.calls.some(call => call[1] === 'audio'), false);
});

test('没有 360P 或音频状态未知时，保留原视频和音频设置', () => {
  for (const variant of ['no360', 'noAudio']) {
    const f = fixture();
    if (variant === 'no360') f.lists.video = f.lists.video.filter(v => v.height !== 360);
    else f.lists.audio = [];
    assert.equal(f.run().ok, false);
    assert.equal(f.quality.video, 2);
    assert.deepEqual(f.calls, []);
  }
});

test('竖屏视频选择短边 360 的表示，多个编码优先较低视频码率', () => {
  const f = fixture({ videoList: [
    { qualityIndex: 0, width: 360, height: 640, bitrate: 200000 },
    { qualityIndex: 1, width: 360, height: 640, bitrate: 100000 },
    { qualityIndex: 2, width: 1080, height: 1920, bitrate: 2000000 }
  ] });
  assert.equal(f.run().ok, true);
  assert.equal(f.quality.video, 1);
});

test('不支持独立 DASH 接口时，不点击会影响音质的网页画质菜单', () => {
  const f = fixture();
  f.core.player = null;
  assert.equal(f.run().reason, 'independent-video-unavailable');
  assert.deepEqual(f.calls, []);
});

test('播放器异常连带改动音频时，撤销本次切换并恢复原设置', () => {
  const f = fixture();
  const original = f.core.player.setQualityFor;
  f.core.player.setQualityFor = (type, value) => {
    original(type, value);
    if (type === 'video' && value === 0) f.quality.audio = 0;
  };
  assert.equal(f.run().reason, 'audio-change-reverted');
  assert.deepEqual(f.quality, { audio: 2, video: 2 });
  assert.deepEqual(f.auto, { audio: true, video: true });
});

test('关闭开关后，实际 CDP 状态读取不再干预画质', async () => {
  const f = fixture();
  const c = new CdpController();
  c.ensure = async () => true;
  c.evaluate = async expression => vm.runInContext(expression, f.context);
  c.prefer360p = false;
  const disabled = await c.state();
  assert.equal(disabled.quality360, null);
  assert.deepEqual(f.calls, []);
  c.prefer360p = true;
  assert.equal((await c.state()).quality360.ok, true);
});

test('新安装与旧配置默认开启 360P，保存关闭后重启仍保持关闭', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'albumdeck-quality-test-'));
  const file = path.join(dir, 'album-deck.json');
  try {
    assert.equal(new Store(dir).settings.prefer360p, true);
    fs.writeFileSync(file, JSON.stringify({ settings: { playMode: 'album-loop' } }));
    const store = new Store(dir);
    assert.equal(store.settings.prefer360p, true);
    store.patchSettings({ prefer360p: false });
    assert.equal(new Store(dir).settings.prefer360p, false);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});
