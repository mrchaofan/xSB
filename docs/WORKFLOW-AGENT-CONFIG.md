# 工作流任务 Agent 配置与缓存

节点有两个生命周期：`prompt/input/model/schema` 描述当前工作，`agent` 定义长期执行这类工作的角色和技能。主 Agent 在规划新节点时推理生成配置，Hub 校验、持久化并强制执行。

```jsonl
{"node":"审阅","prompt":"检查这次交付并给出结果。","agent":{"systemPrompt":"依据实际文件和验证证据审阅，明确区分事实与推测。","skills":[{"name":"证据核对","description":"核对文件、测试和验收标准。","content":"逐项核对验收条件；读取实际产物；报告具体检查方法与未验证项。"}]}}
{"node":"完成","kind":"end"}
{"from":"审阅","to":"完成"}
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

Hub 直接从 Work 生成 Markdown assignment，包含任务正文、输入材料、历史结果、版本和必要元数据；历史结果以引用表达，结构化结果和内部 ID 放入可展开详情。继续任务只在原 assignment 已确认插入且 contextEpoch 相同时使用短正文；上下文更新后仍发送完整 assignment。撤回列表保留明确指令和准确 ID。

界面沿用普通 Markdown 渲染和原文复制，无文案正则解析。模型与用户记录使用同一份内容；格式修改发生在动态输入，不污染常驻前缀。结构化图与工具契约保持不变；语义完整性用生成与真实 ACP 测试核对，实际模型任务质量需要单独实验，不能仅由格式测试证明。
