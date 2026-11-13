/* 隔离的隐藏窗口：比较大曲库的进度通信和实际渲染耗时，不连接用户浏览器。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'albumdeck-bench-')));
const albums = Array.from({ length: 300 }, (_, i) => ({ id: `a${i}`, bvid: `BV${i}`, title: `专辑 ${i}`, duration: 7200,
  tracks: Array.from({ length: 40 }, (_, j) => ({ name: `曲目 ${i}-${j}`, start: j * 180, end: (j + 1) * 180 })) }));
const items = albums.flatMap(a => a.tracks.map((_, trackIndex) => ({ albumId: a.id, trackIndex })));
const folders = [{ id: 'fav_liked', name: '喜欢', type: 'song', builtin: true,
  items: albums.slice(0, 50).flatMap(a => a.tracks.map(t => ({ key: `song:${a.bvid}:${t.start}`, kind: 'song', bvid: a.bvid, start: t.start, name: t.name }))) }];
const state = { albums, folders, dataRevision: 1, queue: { mode: 'all-loop', pos: 0, rev: 1, items, source: null },
  current: { albumId: 'a0', trackIndex: 0, album: albums[0], track: albums[0].tracks[0] },
  playing: { album: albums[0], track: albums[0].tracks[0], trackIndex: 0, t: 0, d: 7200, paused: false },
  playback: { t: 0, d: 7200, paused: false, bvid: albums[0].bvid },
  conn: { connected: true, browser: 'Benchmark', port: 9222 }, settings: { hotkeys: {}, playMode: 'all-loop' },
  playModes: [{ key: 'all-loop', short: '全专循环', label: '全专循环播放', scope: '全库' }], message: '', importBusy: false };
ipcMain.handle('state', () => ({ ok: true, data: state }));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'src/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(root, 'src/index.html'));
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript('window.__stateGot || 0')) break;
      await new Promise(r => setTimeout(r, 30));
    }
    const count = await win.webContents.executeJavaScript(`window.__renderTimes = []; const originalRender = render;
      render = function(...args) { const start = performance.now(); try { return originalRender(...args); }
        finally { window.__renderTimes.push(performance.now() - start); } }; window.__stateGot;`);
    const frames = 60;
    let bytes = 0, steadyBytes = 0, publisher;
    const transportFile = path.join(root, 'src/state-packets.js');
    if (fs.existsSync(transportFile) && !process.argv.includes('--full-state')) publisher = new (require(transportFile).StatePublisher)();
    const start = performance.now();
    for (let i = 0; i < frames; i++) {
      state.playing.t = i + 1; state.playback.t = i + 1;
      const packet = publisher ? publisher.packet(state, 1, win.webContents) : state;
      const size = Buffer.byteLength(JSON.stringify(packet));
      bytes += size;
      if (i > 0) steadyBytes += size;
      win.webContents.send('state', packet);
    }
    for (let i = 0; i < 300; i++) {
      if (await win.webContents.executeJavaScript('window.__stateGot || 0') >= count + frames) break;
      await new Promise(r => setTimeout(r, 30));
    }
    const wallMs = performance.now() - start;
    const result = await win.webContents.executeJavaScript(`({ frames: window.__renderTimes.length,
      renderMs: window.__renderTimes.reduce((a,b) => a+b, 0),
      finalTime: document.querySelector('#timeNow').textContent, expectedTime: window.deck.fmt(60), error: window.__loadErr || '' })`);
    if (result.frames !== frames || result.error || result.finalTime !== result.expectedTime) throw new Error('渲染基准未完成：' + JSON.stringify(result));
    const report = { albums: albums.length, tracks: items.length, frames, bytes, averageSteadyBytes: Math.round(steadyBytes / (frames - 1)),
      wallMs: Math.round(wallMs), renderMs: Math.round(result.renderMs) };
    const label = process.argv.includes('--before') ? 'before' : 'after';
    fs.writeFileSync(path.join(__dirname, `perf-${label}.json`), JSON.stringify(report, null, 2));
    console.log('PERF', JSON.stringify(report));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
