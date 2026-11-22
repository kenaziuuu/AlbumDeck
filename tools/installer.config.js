'use strict';

const { assets, locales } = require('./package-policy');

module.exports = {
  appId: 'com.albumdeck.app',
  productName: 'AlbumDeck',
  directories: { output: 'dist/installer' },
  files: ['src/**/*', 'LICENSE', 'RELEASE_NOTES.md', ...assets.map(file => 'assets/' + file)],
  electronLanguages: [...locales].map(file => file.replace(/\.pak$/, '')),
  compression: 'maximum',
  win: {
    executableName: 'AlbumDeck',
    icon: 'assets/icon.png',
    target: [{ target: 'nsis', arch: ['x64'] }]
  },
  nsis: {
    artifactName: 'AlbumDeck-v${version}-windows-${arch}-setup.${ext}',
    oneClick: false,
    perMachine: false,
    include: 'tools/installer.nsh',
    installerLanguages: ['en_US', 'zh_CN', 'zh_TW'],
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    shortcutName: '唱片台 AlbumDeck',
    deleteAppDataOnUninstall: false,
    differentialPackage: false,
    runAfterFinish: true
  }
};
