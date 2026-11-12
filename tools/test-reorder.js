/* 校验拖拽落点归一化 + 曲目重排后当前索引修正（纯数据，不启动应用） */
let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) fail++; };

// ---- 1) 落点归一化：与 renderer.js drop handler 里的公式一致 ----
function dropTo(rows, from, overIndex, after) {
  let to = overIndex;
  if (after) to += 1;
  if (to > from) to -= 1;
  return to;
}
function applyMove(arr, from, to) {
  const a = arr.slice();
  const [x] = a.splice(from, 1);
  a.splice(to, 0, x);
  return a;
}
const base = ['A', 'B', 'C', 'D'];
const cases = [
  ['A 拖到 B 上半（原地）', 0, 1, false, ['A', 'B', 'C', 'D']],
  ['A 拖到 B 下半', 0, 1, true, ['B', 'A', 'C', 'D']],
  ['D 拖到 A 上半', 3, 0, false, ['D', 'A', 'B', 'C']],
  ['B 拖到 D 下半', 1, 3, true, ['A', 'C', 'D', 'B']],
  ['B 拖到 C 上半（原地）', 1, 2, false, ['A', 'B', 'C', 'D']],
  ['C 拖到 B 下半（原地）', 2, 1, true, ['A', 'B', 'C', 'D']],
  ['C 拖到 A 上半', 2, 0, false, ['C', 'A', 'B', 'D']],
  ['A 拖到 D 下半', 0, 3, true, ['B', 'C', 'D', 'A']]
];
for (const [name, from, over, after, want] of cases) {
  const got = applyMove(base, from, dropTo(base, from, over, after));
  ok(name, got.join('') === want.join(''), got.join(''));
}

// ---- 2) 重排后当前曲目索引修正：与 main.js reorderTracks 的逻辑一致 ----
function reorderTracks(album, current, from, to) {
  const curStart = album.tracks[current.trackIndex] ? album.tracks[current.trackIndex].start : null;
  const [moved] = album.tracks.splice(from, 1);
  album.tracks.splice(to, 0, moved);
  let ni = current.trackIndex;
  if (curStart != null) {
    const k = album.tracks.findIndex(t => t.start === curStart);
    if (k >= 0) ni = k;
  }
  return ni;
}
{
  const album = { tracks: [{ name: 'A', start: 0 }, { name: 'B', start: 100 }, { name: 'C', start: 200 }] };
  const cur = { trackIndex: 1 };                       // 正在播 B
  const ni = reorderTracks(album, cur, 0, 2);          // A 移到末尾 -> [B,C,A]
  ok('重排后顺序正确', album.tracks.map(t => t.name).join('') === 'BCA', album.tracks.map(t => t.name).join(''));
  ok('当前曲目跟着走（B 索引 1→0）', ni === 0 && album.tracks[ni].name === 'B', 'index=' + ni + ' name=' + album.tracks[ni].name);
}
{
  const album = { tracks: [{ name: 'A', start: 0 }, { name: 'B', start: 100 }, { name: 'C', start: 200 }] };
  const cur = { trackIndex: 0 };                       // 正在播 A
  const ni = reorderTracks(album, cur, 2, 0);          // C 移到最前 -> [C,A,B]
  ok('当前曲目跟着走（A 索引 0→1）', ni === 1 && album.tracks[ni].name === 'A', 'index=' + ni + ' name=' + album.tracks[ni].name);
}
// ---- 3) 收藏夹条目重排 ----
{
  const f = { items: ['s1', 's2', 's3', 's4'] };
  const [m] = f.items.splice(1, 1); f.items.splice(3, 0, m);
  ok('收藏夹条目重排', f.items.join(',') === 's1,s3,s4,s2', f.items.join(','));
}
// ---- 4) 越界/无效参数应被拒绝 ----
{
  const valid = (n, from, to) => !(n < 2 || from < 0 || from >= n || to < 0 || to >= n || from === to);
  ok('拒绝 from===to', valid(4, 2, 2) === false);
  ok('拒绝越界', valid(4, 0, 4) === false && valid(4, -1, 0) === false);
  ok('接受合法移动', valid(4, 0, 3) === true);
}
console.log('--- 曲目/收藏夹断言完成，继续专辑排序 ---');

// ---- 5) 专辑排序：拖到目标编号 -> 排到那张专辑下面（公式同 renderer drop handler）----
function albumTo(from, target) { return from < target ? target : target + 1; }
function moveTo(arr, from, to) {
  const a = [...arr];
  const [x] = a.splice(from, 1);
  a.splice(to, 0, x);
  return a.join('');
}
{
  const base5 = 'ABCD';
  const cases5 = [
    ['A 拖到 C 上 → 排 C 下面', 0, 2, 'BCAD'],
    ['D 拖到 B 上 → 排 B 下面', 3, 1, 'ABDC'],
    ['B 拖到 A 上 → 不变（已在下方）', 1, 0, 'ABCD'],
    ['A 拖到 B 上 → 排 B 下面', 0, 1, 'BACD'],
    ['C 拖到 D 上 → 排 D 下面', 2, 3, 'ABDC'],
    ['D 拖到 C 上 → 不变（已在下方）', 3, 2, 'ABCD'],
    ['A 拖到 D 上 → 排最后', 0, 3, 'BCDA'],
    ['D 拖到 A 上 → 排到 A 下面', 3, 0, 'ADBC']
  ];
  for (const [name, from, target, want] of cases5) {
    const to = albumTo(from, target);
    const got = to === from ? 'ABCD'.slice(0, 0) + 'ABCD' : moveTo('ABCD', from, to);
    ok(name, got === want, got);
  }
}
console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
