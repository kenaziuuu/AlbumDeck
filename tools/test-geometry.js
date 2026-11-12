const g = require('../src/mini-geometry');
const wa = { x: 0, y: 0, width: 1707, height: 1010 };
const full = g.miniSize('full'), compact = g.miniSize('compact');
let fail = 0;
const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) fail++; };

const vertical = g.miniSize('vertical');
console.log('尺寸 full=', JSON.stringify(full), 'compact=', JSON.stringify(compact), 'vertical=', JSON.stringify(vertical));
ok('MP3样式尺寸 120x200', vertical.width === 120 && vertical.height === 200);
ok('三种样式尺寸互不相同', new Set([JSON.stringify(full), JSON.stringify(compact), JSON.stringify(vertical)]).size === 3);

// 1) 右侧收起，full -> compact
{
  const collapsed = g.collapsedBounds({ x: 1367, y: 848, ...full }, 'right', wa);
  const after = g.resizedCollapsedBounds(collapsed, compact, 'right', wa);
  ok('右侧收起切紧凑：宽高换成新尺寸', after.width === compact.width && after.height === compact.height, JSON.stringify(after));
  ok('右侧收起切紧凑：仍只露 3px', after.x === wa.width - 3, 'x=' + after.x);
  ok('右侧收起切紧凑：纵向不出屏', after.y >= 0 && after.y + after.height <= wa.height, 'y=' + after.y);
}
// 2) 左侧收起，compact -> full（宽度变化时 x 必须重算）
{
  const collapsed = g.collapsedBounds({ x: 0, y: 800, ...compact }, 'left', wa);
  const after = g.resizedCollapsedBounds(collapsed, full, 'left', wa);
  ok('左侧收起切完整：露出宽度仍是 3px', after.x + after.width === 3, 'x=' + after.x + ' 露出=' + (after.x + after.width));
  ok('左侧收起切完整：纵向不出屏', after.y >= 0 && after.y + after.height <= wa.height, 'y=' + after.y);
}
// 3) 顶部收起
{
  const collapsed = g.collapsedBounds({ x: 600, y: 0, ...full }, 'top', wa);
  const after = g.resizedCollapsedBounds(collapsed, compact, 'top', wa);
  ok('顶部收起切紧凑：露出高度仍是 3px', after.y + after.height === 3, 'y=' + after.y);
  ok('顶部收起切紧凑：横向不出屏', after.x >= 0 && after.x + after.width <= wa.width, 'x=' + after.x);
}
// 4) 展开状态切换：右下角为锚点，且不越界
{
  const b = { x: 1300, y: 880, ...full };
  const after = g.resizedExpandedBounds(b, compact, wa);
  ok('展开切紧凑：右下角对齐', after.x + after.width === b.x + b.width && after.y + after.height === b.y + b.height, JSON.stringify(after));
  ok('展开切紧凑：夹在屏内', after.x >= 0 && after.x + after.width <= wa.width, 'x=' + after.x);
}
// 5) 贴边判断：超出屏幕也算贴边
{
  ok('拖出右边缘 80px 仍判为 right', g.edgeOf({ x: 1707 - 340 + 80, y: 500, ...full }, wa) === 'right');
  ok('拖出左边缘判为 left', g.edgeOf({ x: -200, y: 500, ...full }, wa) === 'left');
  ok('中间不判贴边', g.edgeOf({ x: 600, y: 500, ...full }, wa) === '');
}
// 6) 收起 -> 展开用的 bounds 换尺寸后仍在屏内
{
  const expanded = { x: 1367, y: 848, ...full };
  const sized = g.clampToWorkArea({ ...expanded, ...compact }, wa);
  ok('展开位置换尺寸后仍在屏内', sized.x >= 0 && sized.y + sized.height <= wa.height, JSON.stringify(sized));
}
// 7) 竖直样式：收起状态切换后仍只露 3px
{
  const collapsed = g.collapsedBounds({ x: 1367, y: 800, ...full }, 'right', wa);
  const after = g.resizedCollapsedBounds(collapsed, vertical, 'right', wa);
  ok('右侧收起切MP3样式：尺寸正确', after.width === 120 && after.height === 200, JSON.stringify(after));
  ok('右侧收起切MP3样式：仍只露 3px', after.x === wa.width - 3, 'x=' + after.x);
  ok('右侧收起切MP3样式：纵向不出屏', after.y >= 0 && after.y + after.height <= wa.height, 'y=' + after.y);
}
// 8) 弹出面板：贴着卡片放，不盖住卡片；下方放不下就放上方
{
  const cardBottom = { x: 1343, y: 848, ...full };            // 贴屏幕右下
  const r1 = g.popBounds(cardBottom, { width: 340, height: 300 }, wa);
  ok('弹窗：底部卡片 → 放在上方', r1.side === 'above', r1.side);
  ok('弹窗：不压住卡片', r1.bounds.y + r1.bounds.height <= cardBottom.y, 'y=' + r1.bounds.y);
  ok('弹窗：右边缘与卡片对齐', r1.bounds.x + r1.bounds.width === cardBottom.x + cardBottom.width, 'x=' + r1.bounds.x);
  ok('弹窗：不出屏', r1.bounds.y >= 0 && r1.bounds.x >= 0, JSON.stringify(r1.bounds));

  const cardTop = { x: 40, y: 40, ...full };                  // 屏幕左上
  const r2 = g.popBounds(cardTop, { width: 340, height: 300 }, wa);
  ok('弹窗：顶部卡片 → 放在下方', r2.side === 'below', r2.side);
  ok('弹窗：下方不与卡片重叠', r2.bounds.y >= cardTop.y + cardTop.height, 'y=' + r2.bounds.y);
  ok('弹窗：左边缘与卡片对齐', r2.bounds.x === cardTop.x, 'x=' + r2.bounds.x);

  // MP3样式窄卡片：弹窗不跟着变窄，右对齐
  const v = { x: 1587, y: 700, width: 120, height: 200 };
  const r3 = g.popBounds(v, { width: 300, height: 240 }, wa);
  ok('窄卡片弹窗宽度取 300', r3.bounds.width === 300, 'w=' + r3.bounds.width);
  ok('窄卡片弹窗贴右边', r3.bounds.x + r3.bounds.width >= 1707 - 8, 'x=' + r3.bounds.x);

  // 内容太高：夹进工作区
  const r4 = g.popBounds({ x: 100, y: 100, ...full }, { width: 320, height: 5000 }, wa);
  ok('弹窗过高时夹进工作区', r4.bounds.height <= wa.height - 8 && r4.bounds.y >= 0, JSON.stringify(r4.bounds));
}

// 9) 隐藏后露出的宽度可调（1~16px，越大越明显）
{
  const r10 = g.collapsedBounds({ x: 1367, y: 848, ...full }, 'right', wa, 10);
  ok('露出 10px：右侧剩 10px 在屏内', r10.x === wa.width - 10, 'x=' + r10.x);
  const l8 = g.collapsedBounds({ x: 0, y: 800, ...full }, 'left', wa, 8);
  ok('露出 8px：左侧剩 8px 在屏内', l8.x + l8.width === 8, '露出=' + (l8.x + l8.width));
  const t5 = g.collapsedBounds({ x: 600, y: 0, ...full }, 'top', wa, 5);
  ok('露出 5px：顶部剩 5px 在屏内', t5.y + t5.height === 5, '露出=' + (t5.y + t5.height));
  const big = g.collapsedBounds({ x: 1367, y: 848, ...full }, 'right', wa, 99);
  ok('超出上限夹到 16px', big.x === wa.width - 16, 'x=' + big.x);
  const small = g.collapsedBounds({ x: 1367, y: 848, ...full }, 'right', wa, 0);
  ok('低于下限夹到 1px', small.x === wa.width - 1, 'x=' + small.x);
  const rs = g.resizedCollapsedBounds(g.collapsedBounds({ x: 1367, y: 848, ...full }, 'right', wa, 10), compact, 'right', wa, 10);
  ok('收起状态切样式仍保持 10px', rs.x === wa.width - 10, 'x=' + rs.x);
}
console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
