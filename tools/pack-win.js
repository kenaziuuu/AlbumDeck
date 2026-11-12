/* 打包已安装的 Windows Electron 运行时和生产依赖，无需额外打包工具或联网。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const dist = path.join(root, 'dist');

function withinDist(target) {
  const absolute = path.resolve(target);
  const relative = path.relative(dist, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('打包目标必须位于 dist 子目录内');
  return absolute;
}

function findPackage(name, from) {
  for (let cursor = from; ; cursor = path.dirname(cursor)) {
    const candidate = path.join(cursor, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (path.dirname(cursor) === cursor) throw new Error(`缺少生产依赖 ${name}，请先运行 npm install`);
  }
}

function copyDependencies(manifest, from, target, ancestors = new Set()) {
  const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies };
  for (const name of Object.keys(dependencies)) {
    let source;
    try { source = findPackage(name, from); }
    catch (error) { if (manifest.optionalDependencies && name in manifest.optionalDependencies) continue; throw error; }
    if (ancestors.has(source)) continue;
    const destination = path.join(target, 'node_modules', name);
    fs.cpSync(source, destination, { recursive: true, filter: file => path.basename(file) !== 'node_modules' });
    const child = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    copyDependencies(child, source, destination, new Set([...ancestors, source]));
  }
}

function build() {
  if (process.platform !== 'win32') throw new Error('请在 Windows 上生成 Windows 便携包');
  const runtime = path.join(root, 'node_modules', 'electron', 'dist');
  const runtimeExe = path.join(runtime, 'electron.exe');
  if (!fs.existsSync(runtimeExe)) throw new Error('未找到 Electron 运行时，请先运行 npm install');
  const pe = fs.readFileSync(runtimeExe);
  const machine = pe.readUInt16LE(pe.readUInt32LE(0x3c) + 4);
  const arch = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' }[machine];
  if (!arch) throw new Error('无法识别 Electron 运行时架构');
  const name = `AlbumDeck-v${pkg.version}-windows-${arch}`;
  const folder = withinDist(path.join(dist, name));
  const archive = withinDist(path.join(dist, name + '.zip'));
  const checksum = withinDist(archive + '.sha256');
  fs.mkdirSync(dist, { recursive: true });
  for (const target of [folder, archive, checksum]) {
    if (!fs.existsSync(target)) continue;
    if (!process.argv.includes('--force')) throw new Error(`打包产物已存在：${target}。需要重建时运行 npm run pack:win -- --force`);
    // 删除前逐一验证最终绝对路径仅位于本项目 dist 内。
    fs.rmSync(withinDist(target), { recursive: true, force: true });
  }

  console.log('复制完整 Electron 运行环境…');
  fs.cpSync(runtime, folder, { recursive: true });
  fs.renameSync(path.join(folder, 'electron.exe'), path.join(folder, 'AlbumDeck.exe'));
  if (fs.existsSync(path.join(folder, 'electron_wer.dll'))) {
    fs.renameSync(path.join(folder, 'electron_wer.dll'), path.join(folder, 'AlbumDeck_wer.dll'));
  }
  const defaultApp = withinDist(path.join(folder, 'resources', 'default_app.asar'));
  if (fs.existsSync(defaultApp)) fs.rmSync(defaultApp);
  const appDir = path.join(folder, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  for (const dir of ['src', 'assets']) fs.cpSync(path.join(root, dir), path.join(appDir, dir), { recursive: true });
  for (const file of ['README.md', 'RELEASE_NOTES.md', 'LICENSE']) fs.copyFileSync(path.join(root, file), path.join(appDir, file));
  const manifest = {
    name: pkg.name, version: pkg.version, description: pkg.description,
    main: pkg.main, license: pkg.license, dependencies: pkg.dependencies
  };
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  copyDependencies(pkg, root, appDir);
  fs.copyFileSync(path.join(root, 'start.bat'), path.join(folder, 'start.bat'));
  fs.writeFileSync(path.join(folder, 'README.md'), `# AlbumDeck v${pkg.version} · Windows 便携版\n\n`
    + '将整个压缩包解压到一个文件夹，双击 AlbumDeck.exe 或 start.bat 即可启动。无需安装 Node.js，无需运行 npm install。\n\n'
    + '请保留整个目录中的 resources、locales、DLL 等文件；单独复制 exe 不能运行。\n\n'
    + '首次使用：点击「启动专用浏览器」，在浏览器中登录 B 站，再回到应用导入专辑。\n\n'
    + '升级：从托盘菜单退出旧版，完整解压新版后启动。曲库、收藏夹与设置保存在 %APPDATA%\\album-deck\\album-deck.json。\n\n'
    + '项目与使用说明：https://github.com/kenaziuuu/AlbumDeck\n');

  console.log('使用便携包内的 exe 验证主进程、页面、预加载桥及运行依赖…');
  // 验证时不借用开发机 PATH 中的 Node.js 或 npm。
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['PATH', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())) delete env[key];
  }
  env.PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const check = spawnSync(path.join(folder, 'AlbumDeck.exe'), ['--deck-packcheck'], {
    cwd: folder, env, encoding: 'utf8', timeout: 30000, windowsHide: true
  });
  if (check.error || check.status !== 0 || !check.stdout.includes('PACK_CHECK_OK')) {
    throw new Error('便携包启动验证失败：' + (check.error ? check.error.message : check.stderr + check.stdout));
  }
  console.log(check.stdout.trim());
  console.log('压缩 Windows 便携包…');
  const zipped = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = "Stop"; Compress-Archive -LiteralPath $env:ALBUMDECK_PACK_DIR -DestinationPath $env:ALBUMDECK_PACK_ZIP -CompressionLevel Optimal'], {
    env: { ...process.env, ALBUMDECK_PACK_DIR: folder, ALBUMDECK_PACK_ZIP: archive },
    encoding: 'utf8', windowsHide: true
  });
  if (zipped.error || zipped.status !== 0) throw new Error('压缩失败：' + (zipped.error ? zipped.error.message : zipped.stderr));
  const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(checksum, `${hash}  ${path.basename(archive)}\n`);
  console.log(`完成：${archive} (${(fs.statSync(archive).size / 1024 / 1024).toFixed(1)} MB)`);
  console.log('请将 ZIP 上传到 GitHub Release 的附件，不要把 dist 或 node_modules 提交到源码仓库。');
}

try { build(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
