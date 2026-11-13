/**
 * 通过 Chrome DevTools Protocol 控制真实浏览器里的 B 站播放器。
 * 关键点：不需要安装任何浏览器插件；浏览器以 --remote-debugging-port 启动即可。
 */
'use strict';

const WebSocket = require('ws');
const EventEmitter = require('events');

const PICK_VIDEO = `
  (() => {
    const candidates = [];
    const push = v => { if (v && !candidates.includes(v)) candidates.push(v); };
    document.querySelectorAll('video').forEach(push);
    document.querySelectorAll('bwp-video').forEach(el => {
      try { push(el.shadowRoot && el.shadowRoot.querySelector('video')); } catch (e) {}
    });
    const valid = candidates.filter(v => !isNaN(v.duration) && v.duration > 0);
    return valid.sort((a, b) => b.duration - a.duration)[0] || candidates[0] || null;
  })()`;

// CDP 发出的播放命令不会产生可信输入事件；用序号区分网页主动暂停与接管期间的延迟暂停。
const USER_ACTION_EXPR = `(() => {
  const key = Symbol.for('albumdeck.user-action.v1');
  if (!window[key]) {
    const state = window[key] = { seq: 0 };
    const record = e => { if (e.isTrusted) state.seq++; };
    document.addEventListener('pointerdown', record, true);
    document.addEventListener('keydown', record, true);
  }
  return window[key].seq;
})()`;

// 先同步 B 站自身的播放状态，避免只操作 <video> 后又被播放器的曲尾回调暂停。
const SET_PLAYING = `const setPlaying = play => {
  try {
    const method = play ? 'play' : 'pause';
    if (window.player && typeof window.player[method] === 'function') {
      const p = window.player[method]();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (e) {}
  if (play && v.paused) { try { const p = v.play(); p && p.catch(() => {}); } catch (e) {} }
  if (!play && !v.paused) v.pause();
};`;

const STATE_EXPR = `(() => {
  const userAction = ${USER_ACTION_EXPR};
  const v = ${PICK_VIDEO};
  const bv = (location.href.match(/BV[0-9A-Za-z]{10}/) || [])[0] || '';
  return {
    ok: !!v,
    t: v ? v.currentTime : 0,
    d: v ? v.duration : 0,
    paused: v ? v.paused : true,
    ended: v ? !!v.ended : false,
    userAction,
    playbackRate: v ? v.playbackRate : 1,
    mediaReady: v ? v.readyState : 0,
    seeking: v ? v.seeking : false,
    muted: v ? v.muted : false,
    volume: v ? v.volume : 1,
    bvid: bv,
    title: document.title,
    url: location.href,
    ready: document.readyState
  };
})()`;

// 使用播放器自己的「播完暂停」，让视频完整结束后由唱片台接歌。
// 不直接改 localStorage：走页面现有控件的事件，让播放器立即采用并保存该设置。
const PAUSE_AT_END_EXPR = `(() => {
  const group = document.querySelector('.bpx-player-ctrl-setting-handoff-content');
  const input = group && group.querySelector('input[type="radio"][value="2"]');
  if (!input) return { ok: false, reason: 'not-ready' };
  if (!input.checked) input.click();
  return { ok: !!input.checked };
})()`;

// 直接选择 DASH 的视频分辨率，避免点网页画质菜单时顺带降低普通音轨码率。
// 不使用 requestQuality，也不更改音频质量、音频自适应或 Hi-Res / 杜比开关。
const VIDEO_360_EXPR = `(() => {
  try {
    const host = window.player;
    const core = host && typeof host.__core === 'function' && host.__core();
    const dash = core && core.player;
    if (!dash || !['getBitrateInfoListFor', 'getQualityFor', 'setQualityFor', 'getAutoSwitchQualityFor'].every(k => typeof dash[k] === 'function') ||
        typeof core.setAutoSwitchQualityFor !== 'function') return { ok: false, reason: 'independent-video-unavailable' };
    const audio = dash.getQualityFor('audio');
    const audioList = dash.getBitrateInfoListFor('audio');
    if (!Number.isInteger(audio) || audio < 0 || !audioList.some((a, i) => (a.qualityIndex ?? i) === audio)) {
      return { ok: false, reason: 'audio-not-ready' };
    }
    const list = dash.getBitrateInfoListFor('video');
    const options = list.map((v, i) => ({ index: v.qualityIndex ?? i, height: Number(v.height), width: Number(v.width), bitrate: Number(v.bitrate) || 0 }))
      .filter(v => v.height === 360 || (v.width === 360 && v.height > 360)).sort((a, b) => a.bitrate - b.bitrate);
    if (!options.length) return { ok: false, reason: '360p-unavailable' };
    const target = options[0].index;
    const current = dash.getQualityFor('video');
    const auto = dash.getAutoSwitchQualityFor('video');
    const audioAuto = dash.getAutoSwitchQualityFor('audio');
    if (!Number.isInteger(current) || current < 0) return { ok: false, reason: 'video-not-ready' };
    if (auto) core.setAutoSwitchQualityFor('video', false);
    if (current !== target) dash.setQualityFor('video', target);
    if (dash.getQualityFor('audio') !== audio || dash.getAutoSwitchQualityFor('audio') !== audioAuto) {
      dash.setQualityFor('video', current);
      core.setAutoSwitchQualityFor('video', auto);
      dash.setQualityFor('audio', audio);
      core.setAutoSwitchQualityFor('audio', audioAuto);
      return { ok: false, reason: 'audio-change-reverted' };
    }
    return { ok: dash.getQualityFor('video') === target, changed: current !== target || auto, audioUnchanged: true, audioIndex: audio, videoIndex: target };
  } catch (e) { return { ok: false, reason: 'not-ready' }; }
})()`;

function stateExpr(pauseAtEnd, prefer360p) {
  return `(() => {
    const endPause = ${pauseAtEnd ? PAUSE_AT_END_EXPR : 'null'};
    const quality360 = ${prefer360p ? VIDEO_360_EXPR : 'null'};
    return { ...${STATE_EXPR}, endPause, quality360 };
  })()`;
}

function seekExpr(seconds, autoPlay) {
  return `(() => {
    const userAction = ${USER_ACTION_EXPR};
    const v = ${PICK_VIDEO};
    if (!v) return { ok: false, error: '页面里还没找到视频元素' };
    if (v.readyState < 1 || !(v.duration > 0)) return { ok: false, error: '视频还在加载，正在等待定位' };
    const wasAtEnd = v.ended || v.currentTime >= v.duration - 0.5;
    const t = ${Number(seconds) || 0};
    ${SET_PLAYING}
    try {
      if (window.player && typeof window.player.seek === 'function') window.player.seek(t);
    } catch (e) {}
    try { v.currentTime = t; } catch (e) { return { ok:false, error: String(e) }; }
    setPlaying(${!!autoPlay});
    return { ok: true, t: v.currentTime, d: v.duration, userAction, wasAtEnd };
  })()`;
}

function playExpr(force = '') {
  return `(() => {
  const v = ${PICK_VIDEO};
  if (!v) return { ok:false, error:'未找到播放器' };
  ${SET_PLAYING}
  setPlaying(${force ? force === 'play' : 'v.paused'});
  return { ok:true, paused: v.paused };
})()`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class CdpController extends EventEmitter {
  constructor(port = 9222) {
    super();
    this.port = port;
    this.target = null;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.connected = false;
    this.lastState = null;
    this.busy = false;
    this.pauseAtEnd = true; // 启动后首次连接 / 轮询就关闭网页自动切集，无需先点歌。
    this.prefer360p = true;
    this.playGeneration = 0;
  }

  setPort(port) { this.port = port; this.disconnect(); }

  async version() {
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(2500) });
      return await r.json();
    } catch (e) { return null; }
  }

  async listTargets() {
    const r = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(3000) });
    return await r.json();
  }

  /** 找到 B 站视频标签页（优先匹配指定 bvid） */
  async findTab(preferBvid = '') {
    const list = await this.listTargets();
    const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
    const bili = pages.filter(t => /bilibili\.com/.test(t.url || ''));
    const pick = (arr) => arr.find(t => preferBvid && (t.url || '').includes(preferBvid)) || arr[0];
    return pick(bili.filter(t => /\/video\//.test(t.url || ''))) || pick(bili) || pick(pages) || null;
  }

  disconnect() {
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    for (const [, p] of this.pending) { try { p.reject(new Error('连接已断开')); } catch (_) {} }
    this.pending.clear();
    this.connected = false;
    this.emit('status', { connected: false });
  }

  async connect(preferBvid = '') {
    const v = await this.version();
    if (!v) { this.disconnect(); throw new Error(`端口 ${this.port} 上没有可用的调试浏览器`); }
    const tab = await this.findTab(preferBvid);
    if (!tab) throw new Error('没有找到可控制的标签页，请先在浏览器里打开 B 站视频');
    if (this.ws && this.target && this.target.id === tab.id && this.ws.readyState === WebSocket.OPEN) {
      this.browser = v.Browser || 'Chromium';
      return { target: tab, browser: v.Browser };
    }
    this.disconnect();
    this.target = tab;
    this.browser = v.Browser || 'Chromium';
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 6000);
      ws.on('open', () => { clearTimeout(timer); this.connected = true; this.emit('status', { connected: true, browser: this.browser, target: tab }); resolve(); });
      ws.on('message', data => {
        let msg; try { msg = JSON.parse(data.toString()); } catch (_) { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message || 'CDP 调用失败'));
          else p.resolve(msg.result);
        }
      });
      ws.on('error', err => { clearTimeout(timer); this.connected = false; reject(err); });
      ws.on('close', () => {
        this.connected = false;
        this.emit('status', { connected: false, reason: '浏览器标签页已关闭' });
      });
    });
    return { target: tab, browser: this.browser };
  }

  send(method, params = {}, timeout = 8000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('未连接到浏览器'));
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面脚本执行失败');
    return r.result && r.result.value;
  }

  async ensure(preferBvid = '') {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) await this.connect(preferBvid);
    return true;
  }

  /** 读取播放状态 */
  async state(preferBvid = '') {
    await this.ensure(preferBvid);
    // 页面加载 / 换视频后控件可能重新生成，读取状态时再次确认，但不会重复点击已选项。
    const s = await this.evaluate(stateExpr(this.pauseAtEnd, this.prefer360p));
    this.lastState = s;
    return s;
  }

  /** 确认网页使用「播完暂停」；默认从应用启动连接时起生效。 */
  async setPauseAtEnd() {
    this.pauseAtEnd = true;
    await this.ensure();
    return this.evaluate(PAUSE_AT_END_EXPR);
  }

  /** 手动暂停时取消尚未完成的旧定位，避免后续重试再次开播。 */
  cancelPendingPlay() { this.playGeneration++; }

  /** 跳转到指定秒 */
  async seek(seconds, autoPlay = true) {
    const generation = ++this.playGeneration;
    await this.ensure();
    return this.seekForRequest(seconds, autoPlay, generation);
  }

  async seekForRequest(seconds, autoPlay, generation) {
    let r;
    for (let i = 0; i < 9; i++) {
      if (generation !== this.playGeneration) return { cancelled: true };
      r = await this.evaluate(seekExpr(seconds, autoPlay));
      if (generation !== this.playGeneration) return { cancelled: true };
      if (r && r.ok) {
        // 跳回曲首后 B 站可能延迟再次暂停。定位和持续播放均确认后才完成接管。
        const started = Date.now();
        let settleMs = autoPlay && r.wasAtEnd && r.d - seconds > 2 ? 1200 : 0;
        let located = false, playingSince = 0;
        for (let check = 0; check < 24; check++) {
          await sleep(100);
          if (generation !== this.playGeneration) return { cancelled: true };
          const s = await this.evaluate(stateExpr(this.pauseAtEnd, this.prefer360p));
          if (generation !== this.playGeneration) return { cancelled: true };
          if (!s || !s.ok) continue;
          // 用户在网页里按暂停 / 播放，优先于尚未完成的自动续播。
          if (s.userAction !== r.userAction && s.paused === !!autoPlay) {
            this.lastState = s;
            return { ok: true, t: s.t, d: s.d, paused: s.paused, userOverride: true };
          }
          if (s.mediaReady < 1 || s.seeking) continue;
          const elapsed = Date.now() - started;
          const target = Number(seconds) || 0;
          const rate = Math.max(1, Number(s.playbackRate) || 1);
          if (Math.abs(s.t - target) < 1) located = true;
          if (!located || s.t < target - 1 || s.t > target + elapsed / 1000 * rate + 1) continue;
          this.lastState = s;
          if (autoPlay && s.paused && !s.ended) {
            settleMs = 1200;
            playingSince = 0;
            await this.evaluate(playExpr('play'));
            continue;
          }
          if (autoPlay && !s.paused) {
            if (!playingSince) playingSince = Date.now();
            if (elapsed < settleMs || Date.now() - playingSince < Math.min(400, settleMs)) continue;
          } else if (!autoPlay && !s.paused) continue;
          return { ok: true, t: s.t, d: s.d, paused: s.paused };
        }
        r = { ok: false, error: '播放器未稳定播放所选曲目，正在重试' };
      }
      if (i < 8) await sleep(450);
    }
    if (!r || !r.ok) throw new Error((r && r.error) || '无法跳转，请确认已打开 B 站视频页');
    return r;
  }

  /** 播放/暂停切换；force: 'play' | 'pause' */
  async togglePlay(force = '') {
    await this.ensure();
    return this.evaluate(playExpr(force));
  }

  /** 切专辑：导航到另一个 BV，再跳到指定曲目 */
  async openVideo(bvid, startSeconds = 0, autoPlay = true) {
    const generation = ++this.playGeneration;
    await this.ensure();
    if (generation !== this.playGeneration) return { cancelled: true };
    const url = `https://www.bilibili.com/video/${bvid}/` + (startSeconds > 1 ? `?t=${Math.floor(startSeconds)}` : '');
    await this.send('Page.navigate', { url });
    this.target = { ...this.target, url };
    // 等待页面与播放器就绪
    let s = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      if (generation !== this.playGeneration) return { cancelled: true };
      try {
        s = await this.evaluate(stateExpr(this.pauseAtEnd, this.prefer360p));
        if (generation !== this.playGeneration) return { cancelled: true };
        this.lastState = s;
        if (s && s.ok && s.d > 1 && s.bvid === bvid) break;
      } catch (_) { /* 页面正在导航 */ }
      if (i === 12 || i === 26) {
        if (generation !== this.playGeneration) return { cancelled: true };
        try { await this.send('Page.navigate', { url }); } catch (_) {}
      }
    }
    if (!s || !s.ok || !(s.d > 1) || s.bvid !== bvid) throw new Error('视频尚未加载完成，未能定位到所选曲目');
    // 即使从 0 开始也走一次 seek：顺带把 autoplay 打开
    // （B 站导航过去后偶尔会停在暂停状态，看起来就像"播放一下就暂停"）
    const r = await this.seekForRequest(startSeconds, autoPlay, generation);
    if (r && r.cancelled) return r;
    return { ...s, ...r };
  }

  /** 在浏览器里新开标签页（用于「打开 B 站」按钮） */
  async newTab(url) {
    const r = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(4000) });
    return r.json();
  }
}

module.exports = { CdpController, STATE_EXPR, PICK_VIDEO, PAUSE_AT_END_EXPR, VIDEO_360_EXPR };
