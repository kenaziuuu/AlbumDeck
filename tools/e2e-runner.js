/* 全链路自检：无头 Chrome(9222) 打开 B 站 → Electron 应用连接 → 切到第 3 首 → 校验进度 */
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs');
const root = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const profile = path.join(os.tmpdir(), 'albumdeck-e2e-' + Date.now());
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;

const browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=9222',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required', '--remote-allow-origins=*', '--window-size=1280,800',
  'https://www.bilibili.com/video/BV1Tw411G74d/'], { stdio: 'ignore' });

(async () => {
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try { const r = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(1000) }); if (r.ok) break; } catch (_) {}
  }
  // 等 B 站播放器加载出时长
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    try {
      const l = await (await fetch('http://127.0.0.1:9222/json/list')).json();
      if (l.some(t => (t.url || '').includes('BV1Tw411G74d'))) break;
    } catch (_) {}
  }
  await sleep(4500);
  console.log('调试浏览器已就绪，启动应用…');
  await new Promise(resolve => {
    const app = spawn(electron, ['.', '--deck-e2e'], { cwd: root, env, stdio: 'inherit' });
    app.on('exit', resolve);
  });
  const log = fs.existsSync(path.join(__dirname, 'e2e.log')) ? fs.readFileSync(path.join(__dirname, 'e2e.log'), 'utf8') : '(无日志)';
  console.log('--- e2e.log ---\n' + log);
})().catch(e => console.error('E2E ERROR', e))
  .finally(() => { spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); });
