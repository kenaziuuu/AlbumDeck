/* 独立浏览器实测：480P + 高码率普通音频 → 360P，比较实际音频流。无需登录用户浏览器。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CdpController } = require('../src/controller');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, controller;

async function waitFor(read, accept, timeout = 30000) {
  let last;
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { last = await read(); if (accept(last)) return last; } catch (_) {}
    await sleep(200);
  }
  throw new Error('等待真实页面状态超时：' + JSON.stringify(last));
}

const DETAILS = `(() => {
  const host = window.player, core = host && host.__core && host.__core(), dash = core && core.player;
  if (!dash || typeof dash.getBitrateInfoListFor !== 'function') return null;
  const v = host.mediaElement();
  let audioPath = '';
  try { audioPath = new URL(core.getCurrentPlayURLFor('audio')).pathname; } catch (_) {}
  return { audio: dash.getQualityFor('audio'), video: dash.getQualityFor('video'),
    audioList: dash.getBitrateInfoListFor('audio').map(a => ({ index: a.qualityIndex, bitrate: a.bitrate })),
    audioAuto: dash.getAutoSwitchQualityFor('audio'), height: v.videoHeight, paused: v.paused,
    t: v.currentTime, audioPath, quality: host.getQuality() };
})()`;

(async () => {
  const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  if (!exe) throw new Error('需要已安装的 Chrome 或 Edge');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'albumdeck-quality-live-'));
  child = spawn(exe, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
    'https://www.bilibili.com/video/BV1H14y1N7k3/'], { stdio: 'ignore', windowsHide: true });
  const port = await waitFor(() => {
    try { return +fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch (_) { return 0; }
  }, n => n > 0, 12000);
  controller = new CdpController(port);
  controller.prefer360p = false;
  await controller.connect();
  await waitFor(() => controller.state(), s => s && s.ok && s.d > 400 && s.endPause.ok);
  await waitFor(() => controller.evaluate(DETAILS), s => s && s.audioList.length > 1);
  // 未登录页面的画质菜单可能弹出登录限制。仅使用已加载清单提供的表示建立基线。
  await controller.evaluate(`(() => {
    window.player.mediaElement().muted = true;
    window.player.play(); return true;
  })()`);
  await waitFor(() => controller.evaluate(DETAILS), s => s && s.t > 1 && !s.paused);
  await sleep(1000);
  await controller.evaluate(`(() => {
    const core = window.player.__core(), dash = core.player;
    const video = dash.getBitrateInfoListFor('video').find(v => v.height > 360);
    if (!video) throw new Error('测试视频未提供高于 360P 的表示');
    core.setAutoSwitchQualityFor('video', false); dash.setQualityFor('video', video.qualityIndex);
    const highest = dash.getBitrateInfoListFor('audio').reduce((a, b) => a.bitrate > b.bitrate ? a : b);
    core.setAutoSwitchQualityFor('audio', false); dash.setQualityFor('audio', highest.qualityIndex);
    window.player.mediaElement().currentTime = 60;
    return true;
  })()`);
  const before = await waitFor(() => controller.evaluate(DETAILS), s => s && s.height > 360 &&
    s.audio === s.audioList.reduce((a, b) => a.bitrate > b.bitrate ? a : b).index && /30280/.test(s.audioPath));
  console.log('BEFORE', JSON.stringify(before));
  controller.prefer360p = true;
  const applied = await controller.state();
  assert.equal(applied.quality360.ok, true);
  assert.equal(applied.quality360.audioUnchanged, true);
  await controller.seek(120, true);
  const after = await waitFor(() => controller.evaluate(DETAILS), s => s && s.height === 360 && !s.paused);
  assert.equal(after.audio, before.audio);
  assert.equal(after.audioAuto, before.audioAuto);
  assert.equal(after.audioPath, before.audioPath);
  await sleep(1600);
  const settled = await controller.evaluate(DETAILS);
  assert.equal(settled.height, 360);
  assert.equal(settled.audio, before.audio);
  assert.equal(settled.audioAuto, before.audioAuto);
  assert.equal(settled.audioPath, before.audioPath);
  assert.equal(settled.paused, false);
  console.log('AFTER', JSON.stringify(after));
  console.log('PASS 真实 B 站：480P 降为 360P，保留同一条高码率音频流和播放状态');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (controller) controller.disconnect();
  if (child && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
});
