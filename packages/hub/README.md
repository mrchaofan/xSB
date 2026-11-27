# xSB Hub

每个项目有一个本地 Hub。CLI、Electron 与其他 ACP v2 客户端通过项目套接字连接。每次 `session/new` 创建独立主会话，`session/resume` 打开同一个 ID。首次派发才为 DAG 任务创建会话。任务会话的生命周期由所属主会话的活动图管理。

| 模块 | 职责 |
| --- | --- |
| `acp-server.ts`、`session.ts` | 客户端协议、单执行 turn、输入回执、上下文及后端隔离 |
| `workflow-graph.ts` | JSONL、入口输入校验、拓扑排序、候选目标与可达终点校验 |
| `workflow-state.ts` | 采用版本、拼接已就绪的前驱交付、保存来源节点的选择、暂停与回退 |
| `workflows.ts` | 持久化收据、会话绑定、派发、通知、重启恢复与交付验收 |
| `workflow-tools.ts`、`mcp.ts` | 模型工具及权限入口 |
| `workflow-guide.ts` | 常驻的规划能力说明，以及模型按需读取的本地化建图指南 |
| `kernel.ts`、`delivery.ts` | 输入投递、因果图、停止和待办清理 |

内置 workflow 通过 `Hub.sessionProviders` 提供模型工具、简短的规划提示和当前图的上下文。插件派发消息时显式标记来源，通用队列在出队和提交 ACP 前向来源核验这条消息是否仍然有效。桌面端依据工作流快照展示节点和选路，终点的 Markdown 以插件署名写入主对话。

全局后端定义位于 `~/.xsb2_global/config.json`，可通过 `XSB_HOME` 指定目录。项目配置位于 `.xsb2/config.json`。新编排的索引写入 `.xsb2/conversations/`。桌面的文件列表由会话日志中成功的 ACP v2 文件变更生成。

运行 `npm test -w @xsb/hub` 可验证调度器、turn、停止、内核及真实 ACP/MCP 进程。更多接口和示例见[工作流指南](../../docs/WORKFLOWS.md)。

要验证主 Agent 能从自然语言主动规划，用已配置的真实后端运行 `XSB_LIVE_BACKEND=codex node packages/hub/test/live-smoke.ts --discovery`，也可以指定 `claude`。用例只描述展览排期、预算条件与先审阅的要求，检查模型是否主动生成含汇合和条件边的候选图，并等待确认。

要用已配置的真实后端验证一份 Markdown 订单工作流，可在仓库根目录运行 `XSB_LIVE_BACKEND=codex node packages/hub/test/live-smoke.ts`，或将后端设成 `claude`。入口任务根据订单明细选择核算或补充资料，脚本核对任务收到的正文、选中的节点和终点实际发布的总额。可在命令末尾传先前生成的订单图 JSONL 文件路径，旧契约图会执行原有的命名输入、绑定和类型验证。
