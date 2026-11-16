# @xsb/cli

`xsb` 命令。它只是 Hub 的一个 ACP 客户端：除了经 `@xsb/hub` 找到 / 启动 Hub 和 `init` 之外，不直接读写 `.xsb/` 下的任何状态，所有操作都经 ACP 及其扩展（[@xsb/protocol](../protocol)）发给 [@xsb/hub](../hub)。

## 安装

在仓库根目录执行一次：

```bash
npm install
```

之后用 `npx xsb ...`，或直接运行 `packages/cli/bin/xsb`。需要 Node ≥ 22.18，没有构建步骤。

## 命令

```
xsb init                              在当前目录创建 .xsb/
xsb agent add <id> [选项]              新增或修改一个 Agent
      --role <名称>                    它是哪个角色的实例：.xsb/roles/<名称>/
      --backend <名称>                 `xsb backends` 里的名称（默认取角色的，否则 claude）
      --name <文字> --desc <文字>       别的 Agent 看到的名字和描述
      --instructions <文字|@文件>       它是谁、怎么工作
      --workspace <目录>               工作目录（默认 .xsb/agents/<id>/workspace）
xsb agent list | remove <id>
xsb agent show <id>                   它的新会话会被告知的全部文字（系统说明）
xsb agent restart <id>                重启它的后端，使修改立即生效（正在运行的一轮会失败）
xsb role add <名称> [--desc <文字>] [--backend <名称>] [--workspace project|own] [--instructions <文字|@文件>]
                                      新增或修改角色；工具和 skills 是 .xsb/roles/<名称>/ 下的文件
xsb role list | show <名称> | remove <名称>
xsb role check <名称>                  启动角色的 MCP server 并列出工具
xsb team list                          xsb 自带的预设团队，以及项目用了哪些
xsb team use <团队> | drop <团队>      使用或停用一支团队的角色（不复制文件）
xsb backends                          本机的后端，以及是否已安装

xsb chat <agent> [--new] [--history]  对话
xsb send <agent> <消息> [--interject] [--new]
                                      发一条消息并打印回复
xsb watch                             跟随所有 Agent 的输出、任务和权限请求
xsb status | tasks | sessions
xsb assets [--type <类型>]             共享资产库

xsb acp [--agent <id>]                在 stdio 上提供 ACP，供编辑器等客户端接入
xsb hub start | stop | status | log   后台进程（平时按需自动启动）

--project <目录>                       使用该目录下的 .xsb，而不是向上查找
```

`chat` 里：直接输入是发消息（Agent 正忙时排队成为下一轮）；`/i <内容>` 插话进正在运行的那一轮；`/cancel` 停止当前一轮；`/quit` 退出（Agent 继续工作）。

`--new`、`--history`、`--interject` 是开关，不带值，可以放在任何位置。

## 行为

- **Hub 按需启动**：第一个需要它的命令在后台启动 Hub，之后的命令连到同一个（要在前台运行，用 `@xsb/hub` 的 `xsb-hub <项目目录>`）。改了后端的登录状态或环境变量后，用 `xsb hub stop` 让下次启动生效。
- **权限请求**：后端问"能否使用某工具"时，`chat` / `watch` / 终端里的 `send` 会在终端列出选项让你选。没有终端（如脚本里的 `send`）则拒绝。
- **退出码**：后端相关的失败有固定退出码，便于脚本判断。

  | 退出码 | 原因 |
  | - | - |
  | 10 | 后端未登录 |
  | 11 | 后端命令未安装 |
  | 12 | 后端启动失败 |
  | 13 | Agent 引用的后端名不存在 |
  | 14 | 后端的 ACP 协议版本不兼容 |
  | 1 | 其他错误 |

- **接入编辑器**：把 ACP agent 的命令配置为 `xsb acp --agent <id>`（必要时加 `--project <目录>`）。每个 Agent 配一个入口；不加 `--agent` 则连到默认 Agent。

## 结构

| 文件 | 内容 |
| - | - |
| [src/cli.ts](src/cli.ts) | 参数解析与各个命令 |
| [src/client.ts](src/client.ts) | 到 Hub 的 ACP 连接（找到或启动 Hub 是 `@xsb/hub` 的 `hubSocket`，与桌面端共用） |
| [src/printer.ts](src/printer.ts) | 把 `session/update` 通知变成终端输出 |

## 测试

```bash
npm test -w @xsb/cli
```

对着真实的后台 Hub 跑：按需启动、发消息、经桥调用工具、开关参数、退出码、同一项目拒绝第二个 Hub、停止后状态保留。
