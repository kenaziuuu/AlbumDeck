/* 真实无头浏览器 + 本地音频：模拟网页原生 ended 自动换视频，验证播完暂停和换页后重设。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { CdpController } = require('../src/controller');

const A = 'BV0000000001', B = 'BV0000000002';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(read, accept) {
  for (let i = 0; i < 100; i++) {
    try { const value = await read(); if (accept(value)) return value; } catch (_) {}
    await sleep(100);
  }
  throw new Error('等待浏览器状态超时');
}

// 三秒 PCM 音频，由真实 <video> 产生 timeupdate / pause / ended 事件。
function audio(seconds = 3) {
  const size = 8000 * seconds * 2;
  const wav = Buffer.alloc(44 + size);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + size, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(size, 40);
  return wav;
}

const wav = audio();
const longWav = audio(30);
const server = http.createServer((req, res) => {
  if (req.url === '/sound.wav' || req.url === '/history.wav') {
    const content = req.url === '/history.wav' ? longWav : wav;
    const range = String(req.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), content.length - 1) : content.length - 1;
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'audio/wav', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${content.length}` } : {})
    });
    res.end(content.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>AlbumDeck end pause test</title>
    <video src="${req.url.includes('history=1') ? '/history.wav' : '/sound.wav'}" muted preload="auto"></video>
    <div class="bpx-player-ctrl-setting-handoff-content">
      <label><input type="radio" name="mode" value="0" checked>自动切集</label>
      <label><input type="radio" name="mode" value="2">播完暂停</label>
    </div>
    <script>
      window.settingChanges = 0;
      document.querySelector('[value="2"]').addEventListener('change', () => window.settingChanges++);
      document.querySelector('video').addEventListener('ended', () => {
        if (!document.querySelector('[value="2"]').checked) location.href = '/video/${B}/';
      });
    </script>`);
});

function loadDeck(browser) {
  const data = {
    albums: [A, B].map(bvid => ({ id: bvid, bvid, duration: 30,
      tracks: [0, 5, 10, 15].map((start, i) => ({ name: `Track ${i + 1}`, start, end: i === 3 ? 30 : start + 5 })) })),
    current: { albumId: A, trackIndex: 0 }, folders: [], queue: null,
    settings: { playMode: 'album-loop', autoPlay: false, skipHidden: true, pollMs: 1000, hotkeys: {} }
  };
  const store = {
    data, save() {}, patch(patch) { Object.assign(data, patch); },
    get albums() { return data.albums; }, get current() { return data.current; },
    get folders() { return data.folders; }, get settings() { return data.settings; }
  };
  const mainPath = path.join(__dirname, '../src/main.js');
  const requireMain = createRequire(mainPath);
  const context = vm.createContext({
    require: name => name === 'electron' ? { app: { requestSingleInstanceLock: () => false, quit() {} } } : requireMain(name),
    __dirname: path.dirname(mainPath), process: { argv: [] }, console, setTimeout, clearTimeout,
    testStore: store, testBrowser: browser
  });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8') + `
    store = testStore; cdp = testBrowser;
    globalThis.deck = { playAt, pollOnce, snapshot };
  `, context, { filename: mainPath });
  return context.deck;
}

let child, controller;
(async () => {
  const exe = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  ].find(p => fs.existsSync(p));
  if (!exe) throw new Error('需要已安装的 Chrome 或 Edge');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'albumdeck-end-pause-'));
  child = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required', `${origin}/video/${A}/`],
  { stdio: 'ignore', windowsHide: true });
  child.on('error', e => console.error(e.message));
  const port = await waitFor(() => Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]), n => n > 0);
  controller = new CdpController(port);
  await controller.connect();
  const startup = await waitFor(() => controller.state(), s => s && s.d === 3);
  assert.equal(startup.endPause.ok, true);
  assert.equal(startup.t, 0);
  assert.equal(startup.paused, true);
  console.log('PASS 启动首次连接即关闭网页自动切集，无需点歌或调用播放');

  await controller.evaluate(`(() => {
    const group = document.querySelector('.bpx-player-ctrl-setting-handoff-content');
    group.querySelector('[value="0"]').click();
    window.delayedSettings = group;
    group.remove();
    return true;
  })()`);
  assert.equal((await controller.state()).endPause.ok, false);
  await controller.evaluate(`setTimeout(() => document.body.append(window.delayedSettings), 200); true`);
  await waitFor(() => controller.state(), s => s && s.endPause.ok);
  console.log('PASS 播放器设置控件延迟出现时，后续轮询自动重试');

  // 仅基线测试临时放开网页自动切集，以验证后续对照行为。
  controller.pauseAtEnd = false;
  await controller.evaluate(`document.querySelector('.bpx-player-ctrl-setting-handoff-content [value="0"]').click(); true`);
  await controller.seek(2.7, true);
  await waitFor(() => controller.state(), s => s && s.bvid === B);
  console.log('PASS 基线：网页原生 ended 会自动跳到下一视频');

  controller.disconnect();
  controller = new CdpController(port);
  await controller.connect();
  const restarted = await waitFor(() => controller.state(), s => s && s.d === 3);
  assert.equal(restarted.endPause.ok, true);
  console.log('PASS 模拟应用重新启动连接后，再次自动关闭网页自动切集');
  await controller.seek(2.7, true);
  const ended = await waitFor(() => controller.state(), s => s && s.ended);
  assert.equal(ended.bvid, B);
  assert.equal(ended.paused, true);
  assert.equal(ended.endPause.ok, true);
  assert.equal(ended.t, 3);
  console.log('PASS 播完暂停：完整播放到视频末尾，不触发网页切集');

  await controller.send('Page.navigate', { url: `${origin}/video/${A}/` });
  const fresh = await waitFor(() => controller.state(), s => s && s.bvid === A && s.d === 3);
  assert.equal(fresh.endPause.ok, true);
  for (let i = 0; i < 3; i++) await controller.state();
  assert.equal(await controller.evaluate('window.settingChanges'), 1);
  console.log('PASS 换视频后自动重设播完暂停，重复轮询不会反复点击');

  await controller.seek(2.7, true);
  const endedAgain = await waitFor(() => controller.state(), s => s && s.ended);
  assert.equal(endedAgain.bvid, A);
  await controller.seek(0.25, true);
  await waitFor(() => controller.state(), s => s && s.t >= 0.25 && !s.paused && !s.ended);
  console.log('PASS 视频结束暂停后可重新跳回开头继续播放');

  await controller.send('Page.navigate', { url: `${origin}/video/${A}/?history=1` });
  await waitFor(() => controller.state(), s => s && s.bvid === A && s.d === 30);
  await controller.togglePlay('pause');
  // 只把测试中的导航指向本地页面，主进程与 CDP 播放逻辑均使用实际代码。
  const send = controller.send.bind(controller);
  controller.send = (method, params, timeout) => {
    if (method === 'Page.navigate' && params.url.startsWith('https://www.bilibili.com/')) {
      const url = new URL(params.url);
      params = { ...params, url: `${origin}${url.pathname}?history=1` };
    }
    return send(method, params, timeout);
  };
  const deck = loadDeck(controller);
  assert.equal(await deck.playAt(A, 1), true);
  await controller.evaluate(`setTimeout(() => { document.querySelector('video').currentTime = 20; }, 500); true`);
  await waitFor(() => controller.state(), s => s && s.t >= 20);
  await deck.pollOnce();
  const corrected = await controller.state();
  assert.equal(corrected.t, 5);
  assert.equal(deck.snapshot().current.trackIndex, 1);
  assert.equal(deck.snapshot().queue.pos, 1);
  console.log('PASS 真实浏览器延迟恢复到第 4 首后，应用纠正回所点第 2 首');

  const first = deck.playAt(B, 1);
  await waitFor(() => controller.state(), s => s && s.bvid === B && s.d === 30);
  assert.equal(await deck.playAt(A, 2), true);
  await first;
  const latest = await controller.state();
  assert.equal(latest.bvid, A);
  assert.equal(latest.t, 10);
  assert.equal(deck.snapshot().playing.album.id, A);
  assert.equal(deck.snapshot().current.trackIndex, 2);
  console.log('PASS 连续跨专辑点歌：旧导航请求取消，最后点选的专辑和歌曲生效');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  if (controller) controller.disconnect();
  if (child && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  server.closeAllConnections();
  server.close();
});
