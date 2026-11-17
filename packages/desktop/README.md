# @xsb/desktop

xsb 的桌面应用：一个工作区一个窗口。它和 `@xsb/cli` 一样只是 Hub 的一个 ACP 客户端，不读写 `.xsb/` 下的状态（除了把一个文件夹初始化为工作区，用的是 `@xsb/hub` 的 `initProject`）。

```bash
npm start -w @xsb/desktop                 # 欢迎页
npm start -w @xsb/desktop -- <文件夹>      # 直接打开一个工作区
```

| 文件 | 内容 |
| - | - |
| [src/main.ts](src/main.ts) | 窗口，以及只有操作系统能做的事 |
| [src/workspace.ts](src/workspace.ts) | 一个窗口到 Hub 的 ACP 连接，线上数据到界面数据的转换 |
| [src/preload.cjs](src/preload.cjs) | `window.xsb`：界面与 main 之间唯一的通道 |
| [src/bridge.ts](src/bridge.ts) | main 与界面之间的契约，只有类型 |
| [src/pages.ts](src/pages.ts) | 右栏的网页：主进程持有的 WebContents，界面用 `<webview2>` 显示；独立窗口 |
| [src/notices.ts](src/notices.ts) | 系统通知：工作完成、失败、等用户确认或授权时告诉用户；macOS 与 Windows 的差别 |
| [src/browser.ts](src/browser.ts) | browser use：Agent 经 MCP 操控右栏的网页，走 CDP（`webContents.debugger`） |
| [renderer/](renderer) | 界面。打包后在浏览器里直接打开 `dist/renderer/index.html`，会用 `mock.js` 的假数据运行 |

Electron 用的是带 `<webview2>` 的私有构建：`npm install` 后 [scripts/patch-electron.mjs](scripts/patch-electron.mjs) 给 `electron` 包打补丁（[patches/](patches)），首次运行时它按 [.electron.mirror.mjs](.electron.mirror.mjs) 从私有镜像下载二进制。版本在 `package.json` 里写死为 43.8.1。

代码由 Rolldown 打进 `dist/`（[rolldown.config.js](rolldown.config.js)），`npm start` 会先打包；单独打包用 `npm run build -w @xsb/desktop`。`npm run package -w @xsb/desktop` 用 electron-builder 把 `dist/` 做成应用（[electron-builder.config.mjs](electron-builder.config.mjs)），产物在 `release/`：macOS arm64 与 Windows x64 各一个 zip，不签名（macOS 只做 ad-hoc）。里面的 Electron 同样来自私有镜像；图标在 [build/](build)。

设计、接口对应关系和已知限制见 [docs/GUI.md](../../docs/GUI.md)。
