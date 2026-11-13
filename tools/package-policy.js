/* 发布只保留应用使用的资产和中英文语言资源；保留全部运行 DLL 与许可证。 */
const locales = new Set(['en-US.pak', 'zh-CN.pak', 'zh-TW.pak']);
const assets = ['icon.png', 'tray.png', 'seed-library.json', 'sponsor/wechat.png', 'sponsor/alipay.png'];
function includeRuntime(relative) {
  const name = relative.replace(/\\/g, '/');
  if (name === 'resources/default_app.asar') return false;
  if (name.startsWith('locales/')) return locales.has(name.slice('locales/'.length));
  return true;
}
module.exports = { includeRuntime, locales, assets };
