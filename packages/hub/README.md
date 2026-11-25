# xSB Hub

每个项目有一个本地 Hub。CLI、Electron 与其他 ACP v2 客户端通过项目套接字连接。每次 `session/new` 创建独立主会话，`session/resume` 打开同一个 ID。首次派发才为 DAG 任务创建会话。任务会话的生命周期由所属主会话的活动图管理。

| 模块 | 职责 |
| --- | --- |
| `acp-server.ts`、`session.ts` | 客户端协议、单执行 turn、输入回执、上下文及后端隔离 |
| `workflow-graph.ts` | JSONL、结果 Schema、拓扑排序与有预算的选路校验 |
| `workflow-state.ts` | 采用版本、三态边与入口、依据失效、选路、暂停和交付 |
| `workflows.ts` | 持久化收据、会话绑定、派发、通知、重启恢复与资产授权 |
| `workflow-tools.ts`、`mcp.ts` | 模型工具及权限入口 |
| `kernel.ts`、`delivery.ts` | 输入投递、因果图、停止和待办清理 |

全局后端定义位于 `~/.xsb2_global/config.json`，可通过 `XSB_HOME` 指定目录。项目配置位于 `.xsb2/config.json`。新编排的索引写入 `.xsb2/conversations/`。按名称和版本登记的文件保存在项目的资产库。

运行 `npm test -w @xsb/hub` 可验证调度器、turn、停止、内核及真实 ACP/MCP 进程。更多接口和示例见[工作流指南](../../docs/WORKFLOWS.md)。
