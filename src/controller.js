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

const STATE_EXPR = `(() => {
  const v = ${PICK_VIDEO};
  const bv = (location.href.match(/BV[0-9A-Za-z]{10}/) || [])[0] || '';
  return {
    ok: !!v,
    t: v ? v.currentTime : 0,
    d: v ? v.duration : 0,
    paused: v ? v.paused : true,
    ended: v ? !!v.ended : false,
    muted: v ? v.muted : false,
    volume: v ? v.volume : 1,
    bvid: bv,
    title: document.title,
    url: location.href,
    ready: document.readyState
  };
})()`;

function seekExpr(seconds, autoPlay) {
  return `(() => {
    const v = ${PICK_VIDEO};
    if (!v) return { ok: false, error: '页面里还没找到视频元素' };
    const t = ${Number(seconds) || 0};
    try {
      if (window.player && typeof window.player.seek === 'function') window.player.seek(t);
    } catch (e) {}
    try { v.currentTime = t; } catch (e) { return { ok:false, error: String(e) }; }
    if (${autoPlay ? 'true' : 'false'} && v.paused) { try { const p = v.play(); p && p.catch(() => {}); } catch (e) {} }
    return { ok: true, t: v.currentTime, d: v.duration };
  })()`;
}

const PLAY_EXPR = `(() => {
  const v = ${PICK_VIDEO};
  if (!v) return { ok:false, error:'未找到播放器' };
  if (v.paused) { const p = v.play(); p && p.catch(()=>{}); } else { v.pause(); }
  return { ok:true, paused: v.paused };
})()`;

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
    const s = await this.evaluate(STATE_EXPR);
    this.lastState = s;
    return s;
  }

  /** 跳转到指定秒 */
  async seek(seconds, autoPlay = true) {
    await this.ensure();
    let r = await this.evaluate(seekExpr(seconds, autoPlay));
    if (!r || !r.ok) {
      // 播放器可能还没加载好，等一会重试
      for (let i = 0; i < 8 && (!r || !r.ok); i++) {
        await sleep(450);
        r = await this.evaluate(seekExpr(seconds, autoPlay));
      }
    }
    if (!r || !r.ok) throw new Error((r && r.error) || '无法跳转，请确认已打开 B 站视频页');
    return r;
  }

  /** 播放/暂停切换；force: 'play' | 'pause' */
  async togglePlay(force = '') {
    await this.ensure();
    if (!force) return this.evaluate(PLAY_EXPR);
    const expr = `(() => { const v = ${PICK_VIDEO}; if(!v) return {ok:false}; ${force === 'play' ? 'if(v.paused){const p=v.play();p&&p.catch(()=>{});}' : 'if(!v.paused)v.pause();'} return {ok:true,paused:v.paused}; })()`;
    return this.evaluate(expr);
  }

  /** 切专辑：导航到另一个 BV，再跳到指定曲目 */
  async openVideo(bvid, startSeconds = 0, autoPlay = true) {
    await this.ensure();
    const url = `https://www.bilibili.com/video/${bvid}/` + (startSeconds > 1 ? `?t=${Math.floor(startSeconds)}` : '');
    await this.send('Page.navigate', { url });
    this.target = { ...this.target, url };
    // 等待页面与播放器就绪
    let s = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      try {
        s = await this.evaluate(STATE_EXPR);
        if (s && s.ok && s.d > 1 && s.bvid === bvid) break;
      } catch (_) { /* 页面正在导航 */ }
      if (i === 12 || i === 26) {
        try { await this.send('Page.navigate', { url }); } catch (_) {}
      }
    }
    // 即使从 0 开始也走一次 seek：顺带把 autoplay 打开
    // （B 站导航过去后偶尔会停在暂停状态，看起来就像"播放一下就暂停"）
    for (let i = 0; i < 6; i++) {
      const r = await this.evaluate(seekExpr(startSeconds, autoPlay));
      if (r && r.ok) break;
      await sleep(500);
    }
    return s;
  }

  /** 在浏览器里新开标签页（用于「打开 B 站」按钮） */
  async newTab(url) {
    const r = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(4000) });
    return r.json();
  }
}

module.exports = { CdpController, STATE_EXPR, PICK_VIDEO };
