'use strict';

const { build, Platform, Arch } = require('electron-builder');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const config = require('./installer.config');
const { version } = require('../package.json');

function runtimeDirectory() {
  const exe = require('electron');
  const fd = fs.openSync(exe, 'r');
  const header = Buffer.alloc(64);
  try {
    fs.readSync(fd, header, 0, header.length, 0);
    fs.readSync(fd, header, 0, 6, header.readUInt32LE(0x3c));
    if (header.readUInt32LE(0) !== 0x4550 || header.readUInt16LE(4) !== 0x8664) {
      throw new Error('制作 Windows x64 安装包需要 x64 Electron 运行环境');
    }
    return path.dirname(exe);
  } finally { fs.closeSync(fd); }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('请在 Windows 上构建并验证安装包');
  const projectDir = path.resolve(__dirname, '..');
  const output = path.join(projectDir, config.directories.output);
  const installer = path.join(output, `AlbumDeck-v${version}-windows-x64-setup.exe`);
  const checksum = installer + '.sha256';
  fs.rmSync(checksum, { force: true });
  await build({
    projectDir, targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), publish: 'never',
    config: { ...config, electronDist: runtimeDirectory(),
      afterPack: ({ appOutDir }) => fs.promises.rm(path.join(appOutDir, 'resources', 'default_app.asar'), { force: true })
    }
  });

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['PATH', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())) delete env[key];
  }
  env.PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const installedApp = path.join(output, 'win-unpacked', 'AlbumDeck.exe');
  for (const lang of ['zh-CN', 'en-US', 'fr']) {
    const check = spawnSync(installedApp, ['--deck-packcheck', '--lang=' + lang], {
      env, cwd: path.dirname(installedApp), windowsHide: true, encoding: 'utf8', timeout: 30000
    });
    if (check.error || check.status !== 0 || !check.stdout.includes('PACK_CHECK_OK')) {
      throw new Error(`应用启动验证失败 (${lang})：` + (check.error?.message || check.stderr + check.stdout));
    }
    console.log(lang + ': ' + check.stdout.trim());
  }
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(installer)) hash.update(chunk);
  fs.writeFileSync(checksum, `${hash.digest('hex')}  ${path.basename(installer)}\n`);
  const size = (fs.statSync(installer).size / 1024 / 1024).toFixed(1);
  console.log(`${installer} (${size} MiB)`);
  console.log(`SHA-256: ${checksum}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
