# 向用户提问

Claude 和 Codex 都可以通过 ACP v2 的 `elicitation/create` 把问题发到 xSB 桌面端。答案通过原请求返回给提问的后端。CLI 支持发送普通消息，目前只有桌面端声明了表单能力。

| 后端工具 | 发出问题后 | 用户回答后 |
| --- | --- | --- |
| Claude `AskUserQuestion` | 当前调用等待用户 | 选项和自填内容返回原调用，Claude 在同一轮继续 |
| Codex `request_user_input` | 当前调用等待用户或后端设置的期限 | 在请求有效期内提交的答案返回原调用，Codex 在同一轮继续 |
| Codex `request_user_input_async` | 模型可以先推进与答案无关的工作 | Codex 适配器把答案交给仍在执行的后端轮次，或在后端空闲时启动后续轮次 |

Codex 的同步提问支持 Plan 模式。xSB 启动 Codex 时在该进程的 `CODEX_CONFIG` 中开启 `features.default_mode_request_user_input`，因此 Default 模式也可调用。异步工具是否可用取决于所选模型。需要用户决定才能继续的步骤应等待同步答复。异步提问适合可以先推进其他工作的情况。

## 在桌面端回答

问题显示在对应会话输入框上方。多道题逐页作答，可用数字键选择选项，也可按表单要求多选或自填。点击“提交”将答案作为 `accept` 返回。点击“跳过”返回 `decline`。后端撤回、超时或会话失效时，Hub 将问题记为取消。历史卡片保留问题和已提交的答案。升级时旧版仍待回答的卡片会关闭。

同步问题等待时，Agent 显示“等你回答”。Codex 异步问题有单独标记，Agent 可继续工作。同一轮中另发普通消息会关闭同步表单；异步表单可以继续作答。桌面端保留普通消息自身的投递记录。

## 回答的有效期

Hub 把每个表单绑定到发起问题的 turn 和后端连接。仍在该 turn 内提交答案或明确跳过，会立即保护该 turn。停止、后端撤回请求、换绑、连接失效或 Hub 重启后，旧答案失效。

主会话正常结束一轮时，Codex 的异步问题可继续作答，直至下一个 Hub turn 开始。空闲时的答复仍返回原 ACP 请求。若 Codex 随后自行启动后端执行，Hub 将其记为回合外活动。该执行不会获得新的业务任务或该会话的 Hub MCP 工具权限。

任务 Agent 的表单只在本次指派的执行轮内有效。需要答案时，任务 Agent 在同一轮收到同步答复后继续并调用 `finish`。节点结束、暂停或停止均会撤销未答问题。涉及整个方案或指派范围的决定由任务 Agent 按工作流规则升级给主会话。[工作流指南](WORKFLOWS.md)

## 关键决策征询偏好

设置中的「AI 协作 → 关键决策征询」控制 AI 主动邀请用户参与重大决策的频率。全局默认关闭，工作区可继承全局设置或显式开启、关闭。开启时，Agent 会在目标、验收标准或范围、成本、时间、质量存在重要取舍时，先查阅已有材料，再向用户说明推荐方案及理由。关闭时，Agent 优先自主判断，在用户明确要求征询或缺少必要信息时提问。

可选问题被跳过时，Agent 可以采用合理默认并说明。需要明确答复或授权的步骤继续等待。操作审批和身份验证各用自己的流程。

全局值保存在 `~/.xsb2_global/config.json` 的 `consultUser` 字段，工作区覆盖保存在 `.xsb2/config.json` 的同名字段。选择继承会移除工作区覆盖。主会话在空闲时刷新设置。已建立任务节点保留创建时固定的角色和征询偏好。

[ACP 客户端能力](ACP-CLIENT-CAPABILITIES.md) · [ACP v2 表单规范](https://github.com/agentclientprotocol/agent-client-protocol/blob/927e31867b31b1e3c961c7edee7e3680b90be718/docs/protocol/v2/draft/elicitation.mdx#foreground-state) · [Codex 异步提问](https://github.com/agentclientprotocol/codex-acp/blob/v2.12.0/docs/async-questions.md)
