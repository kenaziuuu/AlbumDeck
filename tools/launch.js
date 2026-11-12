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
  console.error('未找到 Electron 运行时，请先执行 npm install');
  process.exit(1);
}
const child = spawn(exe, ['.'], { cwd: root, env, stdio: 'inherit' });
child.on('exit', code => process.exit(code || 0));
