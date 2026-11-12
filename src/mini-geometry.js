/**
 * 悬浮窗几何计算（纯函数，不依赖 Electron，方便单测）
 * workArea 形如 { x, y, width, height }
 */

/** 三种样式对应的窗口尺寸 */
function miniSize(style) {
  if (style === 'compact') return { width: 384, height: 72 };
  if (style === 'vertical') return { width: 120, height: 200 };
  return { width: 340, height: 126 };
}

/** 把矩形夹进工作区，保证完整可见 */
function clampToWorkArea(b, wa) {
  const width = Math.min(b.width, wa.width);
  const height = Math.min(b.height, wa.height);
  return {
    width, height,
    x: Math.max(wa.x, Math.min(b.x, wa.x + wa.width - width)),
    y: Math.max(wa.y, Math.min(b.y, wa.y + wa.height - height))
  };
}

/**
 * 展开状态切换样式：右下角为锚点缩放，再夹进工作区
 * @param {{x,y,width,height}} b 当前 bounds
 * @param {{width,height}} sz 新尺寸
 */
function resizedExpandedBounds(b, sz, wa) {
  if (b.width === sz.width && b.height === sz.height) return { ...b };
  return clampToWorkArea({
    x: b.x + b.width - sz.width,
    y: b.y + b.height - sz.height,
    width: sz.width, height: sz.height
  }, wa);
}

/**
 * 收起状态切换样式：按贴边方向重算位置，保证仍只露出 3px
 * @param {{x,y,width,height}} b 当前（已收起的）bounds
 * @param {{width,height}} sz 新尺寸
 * @param {'left'|'right'|'top'} edge 收起的边
 */
function resizedCollapsedBounds(b, sz, edge, wa, peek) {
  const k = Math.max(1, Math.min(16, Number.isFinite(Number(peek)) ? Math.round(Number(peek)) : 3));
  const nb = { width: sz.width, height: sz.height, x: b.x, y: b.y };
  if (edge === 'left') {
    nb.x = wa.x - sz.width + k;
    nb.y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - sz.height));
  } else if (edge === 'right') {
    nb.x = wa.x + wa.width - k;
    nb.y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - sz.height));
  } else {
    nb.y = wa.y - sz.height + k;
    nb.x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - sz.width));
  }
  return nb;
}

/** 收起时的目标位置（不改变尺寸） */
function collapsedBounds(b, edge, wa, peek) {
  const k = Math.max(1, Math.min(16, Number.isFinite(Number(peek)) ? Math.round(Number(peek)) : 3));
  const nb = { ...b };
  if (edge === 'left') nb.x = wa.x - b.width + k;
  else if (edge === 'right') nb.x = wa.x + wa.width - k;
  else nb.y = wa.y - b.height + k;
  return nb;
}

/**
 * 悬浮窗弹出面板（独立小窗口）的位置：贴着卡片放，不盖住卡片。
 * 优先放在卡片下方；下方放不下就放上方；再不够就贴边夹紧。
 * 横向与卡片对齐：卡片在屏幕右半边就右对齐，否则左对齐。
 * @param {{x,y,width,height}} card 卡片窗口矩形
 * @param {{width:number,height:number}} size 弹窗想要的尺寸
 * @param {{x,y,width,height}} wa 工作区
 * @returns {{side:'below'|'above', bounds:{x,y,width,height}}}
 */
function popBounds(card, size, wa) {
  const gap = 6;
  const width = Math.min(wa.width - 8, Math.max(160, Math.round(Number(size.width) || 300)));
  const height = Math.min(wa.height - 8, Math.max(70, Math.round(Number(size.height) || 240)));
  const bottomRoom = wa.y + wa.height - (card.y + card.height);
  const topRoom = card.y - wa.y;
  const side = bottomRoom >= height + gap ? 'below'
    : (topRoom >= height + gap ? 'above' : (bottomRoom >= topRoom ? 'below' : 'above'));
  const rightHalf = (card.x + card.width / 2) >= (wa.x + wa.width / 2);
  let y = side === 'below' ? card.y + card.height + gap : card.y - height - gap;
  y = Math.max(wa.y + 4, Math.min(y, wa.y + wa.height - height - 4));
  let x = rightHalf ? card.x + card.width - width : card.x;
  x = Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - width - 4));
  return { side, bounds: { x, y, width, height } };
}

/** 贴边判断：贴边或已被拖出屏幕都算 */
function edgeOf(b, wa) {
  if (b.x <= wa.x + 3) return 'left';
  if (b.x + b.width >= wa.x + wa.width - 3) return 'right';
  if (b.y <= wa.y + 3) return 'top';
  return '';
}

module.exports = { miniSize, clampToWorkArea, resizedExpandedBounds, resizedCollapsedBounds, collapsedBounds, edgeOf, popBounds };
