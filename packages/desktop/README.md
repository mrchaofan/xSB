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

GitHub [Desktop CI](../../.github/workflows/desktop.yml) 在 PR 和推送 `main` 时，先执行所有工作区的测试与类型检查，再分别在 macOS 和 Windows runner 打包。Actions 的 `xsb-mac-arm64`、`xsb-win-x64` 制品保存 30 天，包含应用 zip 和对应的 `.sha256` 校验文件。普通合并只跑 CI，不递增版本、不创建标签、不发布 Release；推送标签也不会触发发布。

发布只能在 GitHub Actions 的 [Release App](../../.github/workflows/release.yml) 点击 **Run workflow**，选择 `main` 和版本递增方式（默认 `patch`，也支持 `minor` / `major`）。流程自动同步根项目、所有工作区、内部依赖及 lockfile 的版本，提交回写 `main`，再针对该提交执行完整检查与双平台构建。成功后创建并推送对应的 annotated Git tag（如 `v0.1.1`），发布 GitHub Release，上传应用包和校验文件，无需额外密钥。自动回写使用 `GITHUB_TOKEN`，由本次发布流程直接构建该提交，不会递归触发发布。

手动发布串行运行。构建失败时版本提交会保留，尚不创建标签或 Release；使用同一运行记录的 **Re-run failed jobs** 重试可继续发布，完整重跑同一记录也会复用已提交的版本。重新点击 **Run workflow** 才会再递增版本。并发修改导致版本提交无法快进推送时，流程会失败，不覆盖 `main`。

设计、接口对应关系和已知限制见 [docs/GUI.md](../../docs/GUI.md)。
