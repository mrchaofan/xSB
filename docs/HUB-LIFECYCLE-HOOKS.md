# Hub 生命周期、事件与 ACP v2 能力

## 审查与边界

现有 `Hooks.decide` 在提交前同步决定，异常即否决；运行时也拒绝异步 decision handler，防止 Promise 被误当授权。`observe` 在提交后异步分发，不能参与授权，也不能延长模型 turn。保留这两个入口。原有 `settled()` 只保证事件已分发，不保证异步观察者完成；增加独立 `completed()`，仅用于测试或显式清理。观察者应幂等；有外部副作用的观察者可关闭自动重试。

session 是持久对话；turn 是 Hub 授权的一段串行执行；run 是后端 running 到 idle 的执行窗口；step 是可观察的工具调用。不能从文本或模型内部推理推断 step。无主 run 仍是回合外执行，不因此创建 turn。

## API 与事件

`Lifecycle` 统一构造不可变事件，提供 session opened/bound/unbound/closed/background_changed、turn started/ended、step started/ended。事件包含独立 eventId、时间、source（agentId、sessionId、backendSessionId、contextEpoch、turnId、可选 stepId）和 data。null turnId 明确表示无 turn 来源。生命周期观察事件不作为持久消息自动重放；需可靠执行的后台工作必须先登记 Task。旧 `acp.*` 钩子保留为传输及既有消费者入口，不另建调度器。

`source()` 在调用当下捕获来源；观察者收到的是当时的快照。创建任务时将来源写入 Task，与任务原子提交；Jobs 以持久 taskId 重查可执行状态，并使用 Task.source，不读取处理时的 current turn 来认领它。step 结束、后台结果、URL 交互完成均不能重新激活来源 turn。

后台工作可以在 turn 中登记、在 turn 结束后启动或完成。只有登记提交点需要有效授权；已登记工作独立于创建 turn 的时长，仍受 task parents、workGeneration、停止代次约束。事件关联是因果信息，不是权限或取消边。结果通过既有内核通知和输入队列投递，不能插入无关受保护 turn。

ACP tool_call 按 backend binding + toolCallId 关联 step；Hub MCP 按请求 receipt 关联 step，两个命名空间分别保留。idle 关闭未结束的前台 step；标准 state_update.background 独立维护后台 step，terminal_update/output_chunk 保留原来源并映射到工具详情，其迟到状态按首次工具调用的来源归属，不新建 turn。断开关闭所有 step。已知工具的迟到 tool_call_update 可以更新原记录，不能开启新 step 或获得新 turn 权限。session 绑定改变时清理能力缓存并隔离旧响应。

## ACP 能力接入

1. Claude、Codex 都通过 ACP v2 原生 form 提问，提交、跳过与取消通过原请求回传。Codex 主会话的异步表单可跨正常的前台结束边界保留。两个后端也可请求 URL 授权。URL 请求支持 session 或 request 作用域，保留不透明的 elicitationId，并在不同连接之间转换 requestId。用户同意打开页面后，外部授权仍由相应服务完成。凭据不进入对话。[表单生命周期](ASK.md)
2. xSB 不发起后端登录，不消费 authMethods、不声明 terminal auth、不提供登录扩展或终端。用户自行完成后端与服务配置；ACP 返回的错误码、消息与数据保留原样，界面展示错误。
3. promptSuggestions 缓存为会话 UI 状态，点击只填入草稿。新输入/绑定变化清理旧建议；历史重放不复活建议。
4. commands.skill 保留协议输入兼容；桌面端不提供“命令与技能”下拉。只有后端声明 session.prompt.skill 才发送 skill block。无 inline 能力时只能一个 skill 且位于首位，Hub 动态上下文置于其后；技能发现与加载仍由 Agent 负责。命令目录、登录状态和事件 ID 不进入常驻 systemPrompt。

仅声明已实现的 client capability；Agent 的实际能力以握手和当前会话目录为准。新能力沿 Desktop → Hub → Backend 全链路传递。标准能力优先；不能等价替换的 AIR 能力保留在独立兼容边界，见下文。

## 验证

验证事件来源不可变、turn 结束不等待观察者、延迟 job 仍关联旧 turn、停止提交后不能挂接工作、迟到结果不控制新 turn，以及 URL 请求取消/完成/连接关闭、能力协商、建议失效和 skill 排序。保留 turns、stop、kernel 与 ACP 端到端不变量测试。

## AIR 替代评估（Claude ACP 0.112.0 / Codex ACP 2.12.0）

| 能力 | 标准替代与处理 |
| --- | --- |
| 后续建议 | Claude 已实现标准 prompt_suggestions_update；Codex 仍以 AIR 客户端标记启用生成，并发送 _meta.promptSuggestions。保留 Codex AIR 握手与解析，转换为统一 PromptSuggestion；收到标准格式后优先标准，避免重复。 |
| 单选、多选、自定义输入 | 桌面端根据原生 form schema 展示题目和选项。支持 Claude 的自定义答案字段、Codex 的附注字段以及 AIR customAnswer 元数据。 |
| 运行状态、标题、用量、压缩 | 使用标准 state_update、session_info_update、usage_update、compaction_update；未知 AIR 元数据继续透传。 |
| 技能命令 | 标准 commands.skill + prompt.skill；Agent 未声明时不伪造支持。原生普通 command 仍可用。 |
| 执行中插入 | 已核对官方 Claude ACP 0.112.0 与 Codex ACP 2.12.0：标准 session/prompt 优先尝试插入普通输入。Hub 删除 _session/steering 调用；权限/提问回调及控制命令仍可能延后。 |
| preview、细粒度 diff/phase、计划增量 | 标准尚不覆盖全部结构；保留原始元数据，不声明未实现的 AIR 消费能力。 |
| session rewind/index/goal/subagent 特殊控制 | 不因建议功能声明这些能力。Hub 的会话账本和任务图不由 AIR 接管。 |

Codex 的 AIR 判断会因 _meta.jetbrains.air 对象存在启用若干基础元数据；并非真正逐功能开关。因此仅声明 version:1、capabilities:[]，不认领额外可选能力，仍使用 xsb 客户端身份。后端配置 airCompatibility:false 可完全关闭；其他后端默认关闭，确有需要可显式开启。前缀不注入这些能力、建议或登录状态。升级适配器时重新审查此兼容边界。

## 标准 prompt 与定向插话

ACP v2 只有统一的 session/prompt，未定义强制加入当前执行、下一 turn 或 targetTurnId 等标准字段。消息插入对话不等于 LM 已处理。Hub 的定向追加仍绑定逻辑 turn，并在提交点复核。锁定的官方适配器以标准 prompt 优先尝试插入当前执行，无法插入或需要独立执行的输入仍按回执与 running/idle 结算；Hub 不再使用 _session/steering。不要以返回 messageId、running 状态或写入管道替代输入的真实归属与消费校验。

核对依据：[Claude 0.112.0 会话](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.112.0/src/v2/session.ts)、[Claude 优先级规则](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.112.0/src/steering-priority.ts)、[Codex 2.12.0 promptV2](https://github.com/agentclientprotocol/codex-acp/blob/v2.12.0/src/CodexAcpServer.ts)。版本已精确锁定，适配器升级时重新核对普通输入优先插入的实现。匿名回显不按 FIFO 认领，保存原生插入标记，等待原请求响应关联；消息、任务结果与交接的派生历史按插入位置整理，保留先于响应到达的输出；定向追加在 idle 后未确认时失效，隔离旧进程及绑定后再执行后继。
