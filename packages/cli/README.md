# xSB CLI

从仓库根目录执行 `npm install`，运行 `npx xsb help` 查看命令。在其他目录可直接使用仓库里的 `packages/cli/bin/xsb`。

| 命令 | 用途 |
| --- | --- |
| `xsb init` | 初始化当前工作区 |
| `xsb backends` | 查看本机可用的 ACP 后端 |
| `xsb session new [标题] --backend codex` | 创建主会话，输出会话 ID |
| `xsb sessions` | 列出主会话 |
| `xsb chat [会话ID] [--history]` | 新建或打开会话，可回放历史 |
| `xsb send 会话ID 消息` | 向主会话或已启动节点发消息并等待回答 |
| `xsb workflow show 主会话ID` | 输出当前 DAG、候选及节点状态 |
| `xsb workflow pause 主会话ID [节点…]` | 暂停全图或指定节点及受影响的下游 |
| `xsb workflow resume 主会话ID [节点…]` | 明确继续 |
| `xsb assets [--history]` | 查看当前登记或全部历史版本 |
| `xsb watch` | 订阅工作区活动 |
| `xsb hub status\|start\|stop\|log` | 管理本工作区的 Hub |
| `xsb acp` | 从标准输入输出连接 Hub |

交互输入 `/cancel` 停止当前会话工作，`/quit` 离开 CLI。`chat` 和 `send` 支持 `--history-only` 询问节点历史，或 `--workflow-target` 将主会话插话绑定到活动图。工作区可通过 `--project DIR` 指定。详见[工作流指南](../../docs/WORKFLOWS.md)。
