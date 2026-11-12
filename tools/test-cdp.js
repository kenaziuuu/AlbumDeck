const { spawn } = require('child_process');
const path = require('path'), os = require('os');
const { CdpController } = require('../src/controller');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exe = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9333;
const profile = path.join(os.tmpdir(), 'albumdeck-cdp-' + Date.now());
const page = path.join(__dirname, 'test-page.html').replace(/\\/g, '/');
const child = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--remote-allow-origins=*',
  `file:///${page}`], { stdio: 'ignore' });
(async () => {
  const c = new CdpController(port);
  let v = null;
  for (let i = 0; i < 40; i++) { await sleep(300); v = await c.version(); if (v) break; }
  if (!v) throw new Error('调试端口未启动');
  console.log('browser:', v.Browser);
  const info = await c.connect();
  console.log('target:', info.target.url.slice(0, 90));
  console.log('evaluate title:', await c.evaluate('document.title'));
  console.log('evaluate marker:', await c.evaluate('window.marker'));
  console.log('state:', JSON.stringify(await c.state()));
  console.log('seek(12):', JSON.stringify(await c.seek(12, false)));
  console.log('state after seek:', JSON.stringify(await c.state()));
  console.log('togglePlay:', JSON.stringify(await c.togglePlay()));
  c.disconnect();
  console.log('CDP TEST PASSED');
})().catch(e => { console.error('CDP TEST FAILED:', e.message); process.exitCode = 1; })
  .finally(() => { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); });
