# AlbumDeck v0.15

发布日期：2026-11-12 · Git 标签：`v0.15` · 包版本：`0.15.0`

本次更新提供包含完整运行环境的 Windows 64 位便携版，解决下载源码 ZIP 后双击 `start.bat` 提示找不到 `electron.exe` 的问题。

## 下载与使用

普通用户请下载本页附件 **`AlbumDeck-v0.15.0-windows-x64.zip`**。

1. 将整个 ZIP 完整解压到一个文件夹。
2. 双击 **`AlbumDeck.exe`** 或 **`start.bat`** 启动。
3. 首次使用时点击「启动专用浏览器」，登录 B 站后导入专辑。

**无需安装 Node.js，无需运行 `npm install`。** 请保留解压目录中的 `resources/`、`locales/`、DLL 等全部文件。

GitHub 自动生成的 `Source code (zip)` 是开发源码，不包含运行环境；源码用户仍需安装 Node.js 18+ 并运行 `npm install`。

## 更新内容

- 新增 Windows 64 位便携 ZIP，随包提供完整 Electron 运行环境、应用代码和生产依赖。
- 启动脚本支持便携版 `AlbumDeck.exe`；源码缺少依赖时显示安装方法与便携版下载地址。
- 新增 `npm run pack:win`，自动打包并检查包内程序的主进程、预加载桥与曲库渲染。
- 生成 ZIP 对应的 `.sha256` 校验文件。
- 更新 README 的下载、升级与发布步骤，明确区分便携版与源码包。

## 升级

从托盘菜单退出旧版，完整解压新版便携包后启动。曲库、收藏夹和设置仍保存在 `%APPDATA%\album-deck\album-deck.json`，升级前可复制该文件备份。

## 验证

- 已通过全部逻辑自检，包含 28 项播放回归测试。
- 源码包缺少 Electron 或生产依赖时，启动脚本会给出可操作的提示。
- 打包时使用包内的 `AlbumDeck.exe` 在隐藏窗口中验证主页面和通信桥；验证环境不使用开发机 PATH 中的 Node.js/npm，不连接用户正在使用的浏览器。

使用环境：Windows 10 / 11（64 位）、Chrome 或 Edge。
