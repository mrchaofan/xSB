# 工作流任务 Agent 配置与缓存

节点的 `prompt`、`input`、`inputSchema`、`model` 和交付 `schema` 描述当前工作，`agent` 定义长期执行这类工作的角色和技能。主 Agent 在规划新节点时生成配置，Hub 校验并持久化。

```jsonl
{"node":"审阅","prompt":"检查记录是否符合交付标准。","input":{"标准":"全部检查通过","记录":"3 项检查均通过"},"inputSchema":{"type":"object","properties":{"标准":{"type":"string"},"记录":{"type":"string"}},"required":["标准","记录"],"additionalProperties":false},"schema":{"type":"boolean","description":"记录是否符合标准"},"agent":{"systemPrompt":"依据实际交付和验证证据审阅，明确区分事实与推测。","skills":[{"name":"证据核对","description":"核对记录与验收标准。","content":"逐项核对验收条件和实际证据，报告检查方法与未验证项。"}]}}
{"node":"完成","kind":"end","inputSchema":{"type":"object","properties":{"通过审阅":{"type":"boolean"}},"required":["通过审阅"],"additionalProperties":false}}
{"from":"审阅","to":"完成","bind":{"通过审阅":""}}
```

## 不可变配置与可变任务

`NodeAgentConfig` 只允许 `systemPrompt` 与 `skills`，结束节点不接受 agent 配置。技能只允许 name、description、content；名称唯一，不绑定文件路径或后端 slash command。模型、输入和产物契约继续使用现有节点字段，不开放任意后端参数或 systemPrompt override 模式。

同名同类型节点重用原 Instance：

- 省略 agent 或其中某个字段，继承旧值。已有默认角色也已固定，不能后来追加角色/技能。
- 显式修改系统提示词、技能顺序、名称、描述或正文，plan 和 execute 都拒绝；候选、版本、任务与正在执行的会话不发生部分变更。
- 修改职责或技能集合需要新节点名；删除后重建的节点是新 Instance，不会复用已退役会话。

校验在版本写入之前完成，使用规范化结构比较。创建执行实例时，AgentSpec 保存独立的配置副本；节点身份、会话与完整 workflowPrompt 在同一 WAL 事务提交。执行方读取自己的副本，不从正在修改的 DAG 重新取角色或技能。

## 前缀稳定与大小限制

任务 Agent 完整常驻提示词按确定次序生成：语言与通用目录说明、生命周期规则、公共工作规则、固定 Hub 工具说明、创建时的征询偏好，然后才是节点身份、角色、技能目录。相同语言和偏好的节点在专属内容之前共享相同前缀。

完整提示词在创建时保存到 SessionRec.workflowPrompt；普通追加、改图、暂停/恢复、重启、上下文续接和后端重绑定均复用原文。历史任务会话没有此字段时，在首次绑定请求前固化。修改全局偏好、说明文件、语言或插件目录不改写已有任务前缀，只影响新建实例。工具的实际可用性由 MCP 的最新目录决定，前缀不列易变化的外部服务名。

常驻提示词不携带当前任务、结果、工作文件路径、时间、运行 ID 或物理 cwd；cwd 以 ACP session 的目录为准，项目移动不会使提示词里留下旧目录。角色正文也应只写稳定职责，不写当前材料与阶段状态。Hub 限制新增配置，避免常驻上下文被大段过程占满：

| 配置 | 上限 |
| --- | --- |
| systemPrompt | 2048 估算 tokens |
| 技能数量 | 8 |
| 技能名称与描述目录 | 合计 1024 估算 tokens |
| 每项技能正文 | 8192 估算 tokens |

估算沿用 ContextPlanner 的 UTF-8 字节数 / 2，属于保守预算。整体常驻提示词仍受后端 promptTokens 与输出预留约束。超限明确拒绝，不静默截断。正文不放进前缀，只列固定名称和描述；需要时调用 workflow.load_skill({name})。大正文经过现有工具输出预算，全文保存在本 Agent 的 read_context 引用中，原访问边界不扩大。

前缀稳定改善缓存命中的必要条件；实际缓存仍取决于模型服务、工具定义、后端附加内容、最小缓存长度与缓存期限。固定提示词不替代运行时授权，停止、输入归属、回执和旧后端工具隔离继续使用当前内核规则。

## ACP v2 接入与技能评估

项目固定的 Claude ACP 0.112.0 与 Codex ACP 2.12.0 支持 ACP v2 的 systemPrompt；Hub 根据 initialize.capabilities.session.systemPrompt 协商，在 session/new 与 session/resume 发送 `{mode:"append",content:[{type:"text",text:workflowPrompt}]}`。没有该能力时，沿用 standing-instructions preface；只有真实插入回执消费前缀，恢复和拒收不能丢掉它。

ACP v2 的 prompt.skill 是后端已有技能的名称引用，并受 inline 能力和位置规则限制；它没有在 session/new 注册任意技能正文的通用接口。因此节点 skills 是 Hub 管理的可移植指令模块，独立于后端原生技能目录；load_skill 由当前执行实例查找，保留工具权限、回执、预算及上下文引用隔离。用户已有原生技能仍走原来的 ACP skill 通道，二者不互相冒充。

ACP v2 还有初始 configOptions。当前 model 沿用已有的模型配置与继承接口；本次不引入任意 configOptions 透传，避免把凭据、权限模式或后端特定选项混进节点角色。需要增加具体选项时，应分别定义类型、能力检查和恢复策略。

## 人类可读的任务消息

Hub 从本次 Work 生成 Markdown 指派，包含任务正文、命名输入、输出要求和必要元数据。契约图的命名输入来自校验后的结构化记录，边引用具体前驱交付的 result。继续任务只在原指派已确认插入且 contextEpoch 相同时使用短正文，上下文更新后仍发送完整指派。撤回列表保留明确指令和准确 ID。

模型和对话记录使用同一份正文，界面支持普通 Markdown 渲染和原文复制。字段绑定、schema 校验和调度由 workflow 插件完成，Claude 和 Codex 等后端沿用标准 ACP 输入和 MCP 工具调用。节点的具体值与输出要求随指派发送，常驻前缀只说明如何读取输入、交付和处理校验错误。
