/*
 * 自检启动器：用隔离的 userData 跑 main.js 里的 --deck-* 自检，跑完自动退出。
 * 用法：node tools/selftest.js --deck-minitest
 *      node tools/selftest.js --deck-repro      （用真实曲库的副本复现界面问题）
 * 说明：会清掉宿主可能带过来的 ELECTRON_RUN_AS_NODE，否则 Electron 会以纯 Node 模式启动。
 */
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

const args = ['.', '--deck-shot', ...process.argv.slice(2)];
const child = spawn(exe, args, { cwd: root, env, stdio: 'inherit' });
child.on('exit', code => process.exit(code || 0));
