# xSB

xSB 在一个工作区中管理多个独立的 Agent 会话。简单任务直接对话，复杂任务由主 Agent 用工作流协调任务 Agent。CLI 和 Electron 连接同一个 ACP v2 Hub，可以打开同一个会话。需要 Node.js 22.18 或更高版本。

## 结构

npm workspaces 的 monorepo，六个库，依赖只向下（cli 与 desktop 并列，互不依赖）：

| 库 | 职责 |
| - | - |
| [@xsb/desktop](packages/desktop) | 桌面应用（Electron），Hub 的一个 ACP 客户端；设计见 [docs/GUI.md](docs/GUI.md) |
| [@xsb/cli](packages/cli) | `xsb` 命令，Hub 的一个 ACP 客户端 |
| [@xsb/hub](packages/hub) | Hub 守护进程：会话与回合、后端进程、邮件与任务、权限、协作工具 |
| [@xsb/adapter](packages/adapter) | 把没有 ACP 入口的三方 agent 封装成一个普通后端 |
| [@xsb/store](packages/store) | 只追加的 JSONL 日志 + 预写日志 |
| [@xsb/protocol](packages/protocol) | 线上定义：JSON-RPC、ACP 类型、ACP 扩展、错误码 |

## 使用

在仓库执行 `npm install` 后可以运行下列命令。其他工作目录可使用本仓库的 `packages/cli/bin/xsb`，也可传入 `--project DIR` 指定项目。

```bash
npx xsb init
npx xsb backends
npx xsb session new "短片制作" --backend codex
npx xsb sessions
npx xsb chat SESSION_ID
```

`xsb chat` 省略 ID 会新建会话。主 Agent 可先展示候选方案，再按用户要求采用。执行复杂任务时，用 `xsb workflow show SESSION_ID` 查看 DAG、节点状态和已派发任务的会话 ID。用 `xsb send TASK_SESSION_ID "这版用了哪张底图？"` 直接向任务 Agent 提问。

```bash
npx xsb workflow pause SESSION_ID draw
npx xsb workflow resume SESSION_ID draw
npm start -w @xsb/desktop
```

桌面左栏列出主会话。进入有工作流的会话后，右栏的工作流标签显示 DAG，选中已启动节点可在图下方查看对话、发消息、停止或续做任务。右栏「文件」列出本会话及任务 Agent 成功生成或修改的文件，可直接预览。旧角色工作区的历史不会导入新会话。工作流工具与 JSONL 示例见[工作流指南](docs/WORKFLOWS.md)。

## 开发

```bash
npm test
```

```bash
npm run typecheck
```
