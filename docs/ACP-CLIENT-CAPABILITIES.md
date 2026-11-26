# ACP 客户端能力

核对对象：项目锁定的 SDK 2.6.0（Codex 适配器内部为 2.4.0）、Claude ACP 0.107.0、Codex ACP 2.6.0，以及当前 ACP v2 draft。v2 的初始化字段是 `capabilities` 和 `info`；`clientCapabilities` / `clientInfo` 属于 v1。

## 规范与当前实现

| 字段 | 用途 | xSB 当前状态 |
| --- | --- | --- |
| `elicitation.form` | 原生选择题和结构化输入 | Claude → Hub → Desktop 已接入；Codex 使用自研 ask |
| `elicitation.url` | URL 表单、OAuth 等外部授权流程 | 未声明；需要 URL 展示、用户打开及 `elicitation/complete` 关联处理 |
| `auth.terminal` | 在交互终端复现 Agent 启动命令，完成终端登录 | 未声明；现有独立 CLI 登录入口不等同于该协议能力 |
| `_meta` | 带命名空间的客户端扩展 | 已使用 xSB 会话观察、历史、语言、来源、模型设置等扩展 |

`form` 和 `url` 必须各自非空标记存在：`elicitation: {}` 不声明任何模式。只能声明运行时已经处理的能力，不能用握手字段代替 handler。声明在两段链路分别生效：桌面端声明给 Hub，Hub 再按后端支持策略声明给 Agent。

## 当前 draft 的可选补充

当前上游初始化文档另列出 `session` 下的 unstable 能力，尚未出现在本项目锁定 SDK 的 `ClientCapabilities` 定义中：

- `session.promptSuggestions`：展示 Agent 给出的后续输入建议；基础支持文本和资源链接，可另外声明 `image`、`audio`、`embeddedContext`。需要处理 `prompt_suggestions_update`；桌面端将首条建议显示为空输入框的 placeholder，用户按 Tab 将完整内容补入草稿，再自行发送。
- `session.commands.skill`：识别可用命令中的 `skill` 并用 skill 内容块调用；需要命令列表、选择 UI 和内容块通路。

建议优先补 URL 授权，其次输入建议；终端协议登录和 skill 命令需结合产品需求接入。升级 SDK/适配器后应按协商版本验证每项通路，不直接套用 v1 的 `fs`、`terminal` 能力。普通权限请求、会话状态、工具更新和 v2 压缩回执属于现有协议通路，并非额外的 ClientCapabilities 开关；Claude 0.107.0 的 v2 实现始终发送压缩更新，`session.compaction` 是其 v1 兼容判断。

来源：[ACP v2 初始化](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/draft/initialization.mdx)、[表单请求](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/draft/elicitation.mdx)、[Claude 问题字段](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.107.0/docs/air-extensions.md#question-custom-answers)、[Codex 2.6.0 异步问题](https://github.com/agentclientprotocol/codex-acp/blob/v2.6.0/docs/async-questions.md)。
