'use strict';
const $ = s => document.querySelector(s);
const menuEl = $('#menu');
const tipEl = $('#tip');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

window.deck.onTrayData(data => render(data));

function render(data) {
  if (!data) return;
  const items = data.items || [];
  menuEl.innerHTML = `
    <div class="m-head">
      <div class="m-title">唱片台 · AlbumDeck</div>
      <div class="m-conn ${data.connected ? 'on' : ''}">${data.connected ? '● 已连接 ' + esc(data.browser || '') : '○ 未连接浏览器'}</div>
    </div>
    ${data.trackName ? `<div class="m-track">♫ ${esc(data.trackName)}</div>` : ''}
    ${items.map(it => it.sep
      ? '<div class="m-sep"></div>'
      : `<button class="m-item ${it.danger ? 'danger' : ''}" data-act="${esc(it.act)}" data-tip="${esc(it.tip || '')}">
           <span class="m-label">${esc(it.label)}</span>
           ${it.checked ? '<span class="m-check">✓</span>' : ''}
         </button>`).join('')}`;
  bind();
  requestAnimationFrame(() => {
    const h = Math.ceil(menuEl.getBoundingClientRect().height) + 2;
    window.deck.trayResize(h);
  });
}

function bind() {
  menuEl.querySelectorAll('.m-item').forEach(el => {
    el.addEventListener('mouseenter', () => {
      const tip = el.dataset.tip;
      if (!tip) { hideTip(); return; }
      const r = el.getBoundingClientRect();
      tipEl.textContent = tip;
      tipEl.style.top = Math.max(6, Math.round(r.top + r.height / 2 - 13)) + 'px';
      tipEl.classList.add('show');
      window.deck.trayExpand(true);
    });
    el.addEventListener('click', () => {
      window.deck.trayAction(el.dataset.act);
    });
  });
  menuEl.addEventListener('mouseleave', hideTip);
}

function hideTip() {
  tipEl.classList.remove('show');
  window.deck.trayExpand(false);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') window.deck.trayHide();
});
