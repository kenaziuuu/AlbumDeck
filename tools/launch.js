/* 跨平台启动器：清掉宿主可能带过来的 ELECTRON_RUN_AS_NODE，避免 Electron 以纯 Node 模式启动 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(exe)) exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron');
if (!fs.existsSync(exe)) {
  console.error('源码包缺少 Electron 运行时。请先运行 npm install，或下载 GitHub Releases 中的 Windows 便携包。');
  console.error('下载地址：https://github.com/kenaziuuu/AlbumDeck/releases/latest');
  process.exit(1);
}
if (!fs.existsSync(path.join(root, 'node_modules', 'ws', 'package.json'))) {
  console.error('缺少应用依赖，请先在项目目录运行 npm install。');
  process.exit(1);
}
const child = spawn(exe, ['.'], { cwd: root, env, stdio: 'inherit' });
child.on('error', error => { console.error('启动失败：' + error.message); process.exit(1); });
child.on('exit', code => process.exit(typeof code === 'number' ? code : 1));
