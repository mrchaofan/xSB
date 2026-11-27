# ACP 客户端能力

桌面端内置 Claude ACP 0.112.0 和 Codex ACP 2.12.0，分别使用 ACP SDK 2.12.0 和 2.9.1。适配器调用本机配置或安装的 CLI。Codex 同步和异步提问均已在 Codex CLI 0.171.0 验证。ACP v2 握手使用 `capabilities` 和 `info`。

| 字段 | 用途 | xSB 当前状态 |
| --- | --- | --- |
| `elicitation.form` | 选择题、自由输入和其他结构化表单 | Claude 与 Codex 均可通过 Hub 转给桌面端。CLI 尚未声明此能力 |
| `elicitation.url` | 在外部页面授权或填写敏感信息 | Hub 已支持。桌面端具备 URL 交互处理器时声明该能力 |
| `auth.terminal` | 通过交互终端登录 | Hub 未声明。用户自行配置后端 |
| `session.promptSuggestions` | 显示后续输入建议 | 输入框支持预览和填入建议 |
| `session.commands.skill` | 识别技能命令 | Hub 与桌面端支持该能力，发送技能内容块还需后端支持 `session.prompt.skill` |
| `_meta` | 命名空间扩展 | 用于会话观察、历史、语言、来源和适配器兼容等 |

两段握手分别协商能力。桌面端向 Hub 声明 `capabilities.elicitation.form: {}`，Hub 向后端声明同一能力。`form` 和 `url` 两种模式分别用字段存在且值非 `null` 来声明，值可以是空对象 `{}`。单写 `elicitation: {}` 表示没有支持的模式。表单答案返回发起 `elicitation/create` 的 JSON-RPC 请求。会话级权限审批另走 `session/request_permission`。

同步表单可使前台工作进入 `requires_action`。Codex 异步问题通过同一表单协议发送，适配器使用 `_meta.codex.delivery: "async"` 标明模型仍可继续。主会话正常结束一轮后，仍有效的异步表单可以保留。答案的有效期和 Hub 的 turn 归属见[向用户提问](ASK.md)。

[ACP v2 初始化](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/draft/initialization.mdx) · [ACP v2 表单](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/draft/elicitation.mdx) · [Claude 问题字段](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.112.0/docs/air-extensions.md#question-custom-answers) · [Codex 异步问题](https://github.com/agentclientprotocol/codex-acp/blob/v2.12.0/docs/async-questions.md)
