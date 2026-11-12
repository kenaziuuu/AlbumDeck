const { spawn } = require('child_process');
const path = require('path'), os = require('os');
const { CdpController } = require('../src/controller');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exe = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9334;
const profile = path.join(os.tmpdir(), 'albumdeck-bili-' + Date.now());
const child = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
  '--remote-allow-origins=*', '--window-size=1280,800',
  'https://www.bilibili.com/video/BV1Tw411G74d/'], { stdio: 'ignore' });
(async () => {
  const c = new CdpController(port);
  let v = null;
  for (let i = 0; i < 40; i++) { await sleep(300); v = await c.version(); if (v) break; }
  if (!v) throw new Error('调试端口未启动');
  await c.connect();
  let s = null;
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    try { s = await c.state(); } catch (e) { continue; }
    console.log(`  [${i}] ok=${s && s.ok} d=${s && s.d} bvid=${s && s.bvid} ready=${s && s.ready}`);
    if (s && s.ok && s.d > 100) break;
  }
  console.log('最终状态:', JSON.stringify(s));
  if (!s || !s.d || s.d < 100) throw new Error('没有读到视频时长（可能 B 站拦截了无头浏览器）');
  console.log('跳转到 01:25 (我要的幸福):', JSON.stringify(await c.seek(85, false)));
  await sleep(900);
  const s2 = await c.state();
  console.log('跳转后:', JSON.stringify(s2));
  if (Math.abs(s2.t - 85) > 3) throw new Error('跳转未生效');
  console.log('BILI CDP TEST PASSED');
})().catch(e => { console.error('BILI CDP TEST FAILED:', e.message); process.exitCode = 1; })
  .finally(() => { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); });
