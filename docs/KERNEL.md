# 任务调度框架：Kernel 与 Hooks

这篇说明多智能体协作在中枢里怎么分层：一个与后端无关的任务调度框架（Kernel），横切行为都以 Hook 实现，副作用由 Effector 执行；全链路说 ACP v2。读者是改中枢代码的人。任务图的数据结构和撤销算法见 [TASK-GRAPH.md](TASK-GRAPH.md)，整体设计见 [DESIGN.md](DESIGN.md)。

## 0. 来由

重构前，Agent 间的一切都在 `mailroom.ts`（一个 623 行的类）里：任务状态机、汇合、级联、通知措辞、投递进会话、后台任务的调用；结果一写进邮箱就必然成为对方的一轮；看不到"对方模型看没看到"；任务结束不归因；用户不能撤任务；任务只能由承接者调 `complete_task` 结束，模型漏调就悬挂。中枢对后端和客户端都说 ACP v1，插话靠自定义的 `_session/steering`，后端不支持时只能"取消再续接"，打断工具调用。

这次按评审方案重构，冲突处采用方案，不合理之处在第 11 节说明。

## 1. 分层

```
tools.ts（team 工具面）   acp-server.ts（客户端：CLI、桌面端、编辑器）
        │                        │
        ▼                        ▼
┌──────────── Kernel（kernel.ts）与后端无关 ────────────────┐
│ 任务：创建、开始、统一收口的结束（含隐式完结）、撤销与传染      │
│ 收件箱与唯一的投递管线、汇合、台账（ledger.ts）、内置策略       │
│ Hooks（hooks.ts）：裁决链 + 观察者                          │
└───────────────┬───────────────────────────────────────────┘
                │ 观察者（异步扇出）
   ┌────────────┼──────────────┬──────────────┬──────────────┐
   ▼            ▼              ▼              ▼              ▼
Delivery     Jobs         Capabilities     Audit         UserFeed
(delivery.ts)(jobs.ts)   (capabilities.ts)(audit.ts)    (hub.ts)
   │
   ▼
LiveSession（session.ts）──ACP v2──▶ Backend（backend.ts）──▶ claude-agent-acp / codex-acp / @xsb/adapter
```

- **Kernel 只操作抽象对象**：主体（`Principal`）、任务、消息、事件。它不引用 ACP、会话、后端或客户端；它要知道的会话状态（忙不忙、有没有工具调用在等某个任务）由 Effector 通过 `Recipient` 接口回答。[test/kernel.test.ts](../packages/hub/test/kernel.test.ts) 不起任何进程就能测它。
- **一切副作用走 Effector**：调用 ACP、推送客户端、写审计，都是挂在 Hook 上的动作。Kernel 决定"发生了什么"，Hook 和 Effector 决定"因此做什么"。
- **中枢是唯一裁决者**：Agent 之间不直连，所有投递、停止、通知都经过 Kernel。
- **后端无感知**：后端看到的始终是标准的 ACP v2 会话；排队、投递裁决、撤销传染都在中枢里，被丢弃的消息对它从未存在过。

## 2. ACP v2

claude-agent-acp 0.107 和 codex-acp 2.6 都实现了 ACP v2 草案（`@agentclientprotocol/sdk/experimental/v2`），`initialize` 请求版本 2 即协商到 v2。中枢只说 v2：对后端如此，对客户端（CLI、桌面端、编辑器）也如此。用到的 v2 语义：

| v2 | 中枢怎么用 |
| - | - |
| `session/prompt` 在消息**插入**会话时以 `{ messageId }` 应答，不等工作做完 | 插入回执，台账的 `inserted`；对客户端同样如此 |
| 工作中再发 `session/prompt`：后端立即插入（claude），或扣住到当前工作结束再插入（codex） | 插话不再需要扩展，也不再打断工具调用 |
| `session/cancel`：停下前台工作；没插入的 prompt 一律以 -32800 应答 | 台账的 `discarded_unseen`；用户的消息记为丢弃，邮件退回队列 |
| `state_update`：`running` / `requires_action` / `idle`（带 `stopReason`，`error` 时带错误） | 一轮的结束；隐式完结的信号 |
| `session/resume` 是基本能力，`replayFrom` 重放历史 | 重启后恢复后端会话；客户端用它读取对话记录 |
| `tool_call_update` 以补丁描述工具调用 | 客户端按工具调用 id 归并 |

Gemini CLI 0.68 和 Grok 1.0.88 只说 v1（实测：请求 v2 时协商为 1），不再内置；能说 v2 的任何 agent 仍可在全局配置里登记。没有 ACP 入口的三方 agent 由 [@xsb/adapter](../packages/adapter) 封装成 v2：插入回执、`state_update`、工作中来的 prompt 的扣住与 -32800，都在封装里统一实现一次。

**一轮（turn）**：从中枢交给后端的第一条 prompt 起，到后端报 `idle` 且中枢给它的东西都已插入为止。回执和工作状态到达的先后不定：插入之后见过 `running`、回执到达时已 `idle`，就是这条消息的工作已经做完。每个会话同时只有一条 prompt 处于"已交给后端、未插入"，之后来的在中枢里排，用户的排在最前，所以用户的话总是先于别人的进入会话，不管后端怎样处理它扣着的东西。

## 3. 核心抽象与代码的对应

| 方案里的抽象 | 代码 |
| - | - |
| `Principal = USER \| agentId \| SYSTEM` | `Principal`（[ext.ts](../packages/protocol/src/ext.ts)）。归因到 Agent，不到会话 |
| `Task { initiator, executor, state, stopReason, stopper }` | `Task.initiator`、`to`（执行方与会话）、`from`（派发会话，用户的任务没有）、`status`、`ended: { reason, stopper, cause? }`、`deliveryPref`、`grants` |
| `Message { kind, deliveryPref, deliveryState }` | `MailItem`（[state.ts](../packages/hub/src/state.ts)）：`kind` 为 `task`（派发）、`message`（对话；插话由裁决决定，不是一种 kind）、`results`（结束通知）；`pref`；投递状态在台账 |
| Inbox（按收件方索引，写入即已送达） | 未确认的消息（`mailbox.jsonl`），按会话；台账为 `inboxed` 的是等下一轮的 |
| Ledger | `ledger.jsonl`，以消息 id 为键 |
| Event / Hook | `KernelObserve` / `KernelDecide`（[kernel.ts](../packages/hub/src/kernel.ts)），引擎在 [hooks.ts](../packages/hub/src/hooks.ts) |

**统一通信原语**：派发、对话、插话、结果、结束通知都是消息，写进收件方的收件箱即"已送达"，然后走同一条投递管线（第 6 节）。用户说的话也是：它以用户为发起方写进会话的收件箱。

## 4. 任务的生命周期

```
blocked ──前置都结束──► queued ──交给执行方──► running ──► 结束
                                                   ├ completed   回合正常结束（隐式完结），或执行方 report_result
                                                   ├ failed      执行方说做不了，或回合因模型上限、拒绝而结束
                                                   ├ cancelled   发起方或用户撤销
                                                   ├ cascaded    随它为之而起的任务一起撤（stopper = 根因）
                                                   ├ superseded  派发方以 onBusy: replace 派来新任务取代它（status 为 cancelled）
                                                   ├ error       中枢跑不了它，或交付契约追问后仍未满足（stopper = SYSTEM）
                                                   └ interrupted 退出时用户选择不继续（stopper = USER）
```

- **开始**：必有发起方。Agent 经 `dispatch_task`；用户在一个空闲、没有开着的用户任务的会话里说话，就是一个以 USER 为发起方的任务（`Kernel.dispatchUser`），之后在那个会话里说的话都属于它，直到它结束。会话在工作时用户说的话是插话，不开任务，属于这一轮（[DESIGN.md](DESIGN.md) 3.1）。任务在交给模型的那一刻开始（`running`）：它的输入进了对话，不是它所在的那一轮开始。
- **隐式完结（默认）**：执行方的一轮以 `idle(end_turn)` 结束时，它在那个会话里开着的任务就结束，结果是任务从交给模型起的完整经过（智能体的每条消息、用户插话、其他输入和工具调用各一行，[DESIGN.md](DESIGN.md) 3.1 第 10 条），不只是最后一条消息。执行方不需要调用任何工具。例外：为它启动、结果要唤醒执行方的工作（`wake`/`sync` 的子任务、后台任务）、执行方会话的订阅、或已在路上的这类结果，还有一样没完的，这一轮的结束就不算，等带回结果的那一轮结束再判断。
- **ResultExtractionHook / QualityGateHook**（`task.pre_complete`）：有产物契约（`produces`）的任务，从执行方在任务创建后登记的资产里取出契约要的类型；没有就追问执行方（插进下一轮），最多两次，仍没有就以 `error` 结束并写明原因。执行方显式 `report_result` 时以显式为准。
- **非自然结束**：撤销、用户停止、传染、后端出错，见第 9 节。
- **统一收口**：无论哪种结束，都在 `Kernel.finish` 这一个事务里记录结束、通知发起方、结算汇合、放行被 `after` 挡住的任务，再发出同一个 `task.ended` 事件。

## 5. Hooks

### 5.1 点清单

所有点都存在，有没有处理者都一样；系统自己的行为也是注册上去的处理者，可以被推翻或替换。

| 阶段 | 点 | 类型 | 内置处理者 | 谁触发 |
| - | - | - | - | - |
| 任务 | `task.pre_create` | 裁决 | `after` 只能指已有任务 | 创建任务 |
| | `task.created` | 观察 | Jobs（开始后台任务）、Audit | 创建后 |
| | `task.started` | 观察 | Audit | 交给执行方 |
| | `task.changed` | 观察 | UserFeed（`tasks/update`）、工具列表变化通知 | 任务的每次变化 |
| | `task.pre_stop` | 裁决 | 只有发起方、用户、中枢能停 | 撤销 |
| | `task.stopping` | 观察 | Delivery（停下只为它工作的会话）、Jobs（中止调用）、Audit | 撤销要等的时候 |
| | `task.pre_complete` | 裁决 | ResultExtractionHook、QualityGateHook | 隐式完结 |
| | `task.ended` | 观察 | Jobs（撤出等待队列）、Audit | 结束（统一收口） |
| 级联 | `cascade.pre_propagate` | 裁决 | 无：默认 `spare`，可改为 `force` | 撤销 |
| 投递 | `message.pre_deliver` | 裁决 | 投递策略（第 6 节） | 每条消息 |
| | `message.pre_submit` | 裁决 | 无：可改写送进会话的内容，否决则不送 | 交给会话之前 |
| | `message.routed` | 观察 | Delivery（按决定执行）、Audit | 裁决之后 |
| | `message.withdrawn` | 观察 | Delivery（从会话队列里拿掉）、Audit | 撤销、订阅收回尚未送达的消息 |
| | `message.insertion_receipt` | 观察 | LedgerHook、Audit | 会话：插入回执，或 -32800 / 停下时还在中枢里 |
| | `message.seen` / `message.discarded` | 观察 | 无 | 台账到达这两种终态 |
| | `message.ledger` | 观察 | UserFeed（`messages/update`）、Audit | 台账的每次变化 |
| | `notify.delivered` | 观察 | Audit | 通知写进收件箱并决定了去向，即"已通知" |
| ACP | `acp.session_update` | 观察 | LedgerHook（有后续输出即 `seen`） | 后端的每条更新 |
| | `acp.turn_ended` | 观察 | LedgerHook、Kernel（撤销的确认）、Audit | 一轮结束 |
| | `acp.session_renewed` | 观察 | LedgerHook（未处理的作废）、Audit | 后端会话被替换 |

方案表外补的点（`task.changed`、`task.stopping`、`task.pre_complete`、`message.routed`、`message.withdrawn`、`message.ledger`、`notify.delivered`、`acp.turn_ended`、`acp.session_renewed`）都有内置的使用者：Effector 要有事件可挂，台账和撤销要知道一轮怎么结束。

### 5.2 执行语义

- **裁决**：按注册顺序成链，每个处理者拿到前一个的结果，原样或改写后返回，或者否决；处理者抛异常也算否决（fail-closed）。否决写进审计。Kernel 自己的策略最先注册，后注册的看得到它的答案，可以推翻。
- **观察**：在变化提交之后异步扇出，按发出的顺序，但不在发出它的那次调用之内。每个处理者都拿到每个事件；失败的重试两次，仍失败就记为死信（写进审计）；一个失败不影响其他。
- **内置 Hooks**：NotificationHook（第 7 节）、CascadeHook（第 9 节）、ResultExtractionHook 与 QualityGateHook（第 4 节）、LedgerHook（第 10 节）、AuditHook（`.xsb2/audit.jsonl`）、UserFeedHook（推给客户端）。
- **通知在事务里，投递在事务外**：谁被通知在 `finish` 的同一个 WAL 事务里写定，崩溃不会丢；怎么投递是提交之后的裁决与 Effector。

## 6. 唯一的投递管线：被通知 ≠ 调用后端

消息写进收件方的收件箱（已送达、已通知），然后 `message.pre_deliver` 决定副作用。内置策略按顺序：

| | 条件 | 去向 | 调用后端？ |
| - | - | - | - |
| a | 收件方有一个工具调用在等它（`sync` 的派发、`ask`） | 作为那次调用的返回值 | 否：零额外轮次 |
| b | 收件方已不存在 | 丢弃（台账 `discarded_unseen`） | 否 |
| c | 收件方在工作，而这是用户的话（规则 0），或中枢对它手上工作的话 | 插进正在进行的工作 | 是 |
| d | `lazy` | 留在收件箱，收件方下一轮开始时作为摘要附在前面；或它用 `inbox` 读取 | 否：摊销到下一轮 |
| e | 其余（`wake`） | 一轮：收件方空闲就现在，否则排在它这一轮之后（只在中枢里，模型不知情） | 是 |

用户的消息没有收件方为 USER 的投递：用户在自己的会话里看到任务的结束（最后一条消息、任务列表）。

**投递档位 `deliveryPref: sync | wake | lazy`**，一个维度取代原来的 `mode` 与订阅：

| 档位 | 语义 | 成本 |
| - | - | - |
| `sync` | 派发的工具调用挂起，结果作为返回值（`ask` 也是）；最多等 `limits.awaitSeconds`（默认 50 秒），超时返回回执，结果之后按 `wake` 送达 | 零额外轮次 |
| `wake` | 一轮：收件方空闲就唤醒它，在工作就排在这一轮之后 | 一次投递 |
| `lazy` | 任务结果的默认档：随下一轮附上 | 零 |

**插话看当前 turn 属于谁。** 用户开启或插话过的 turn 受保护，属于用户；其余属于 Agent。

- **用户**：对方忙时总是插话，并立即把这一轮提升为用户级（受保护）。
- **Agent**：对方这一轮属于 Agent 时，任务和聊天插进这一轮，不改变保护状态（`lazy` 的仍留在收件箱）；任务结果不插话，它是请求它的那份工作的事实，随自己的一轮送达，那份工作被停止时作为事实保留；这一轮属于用户时排队，排队期间对方的模型看不到它。路由时判定一次，插入提交点（`LiveSession.steer`）再判定一次，期间用户插话了就改为排队。
- **显式改派**：派发方要停止对方正在做的事，而不是追加，才用下面的改派。
- **显式改派**：`onBusy: "replace"` 并携带 `list_agents` 返回的 `current_turn_id` 作为 `target_turn_id`。目标已切换、缺少 ID 或当前 turn 已受用户插话保护时，新任务排队。这个会话里正在做的、由同一派发方发起的任务被停下（`Kernel.replace`），结束原因记为 `superseded`，停止方是派发方，所以照第 7 节不通知它；为它而起的活照常沿任务图传染（第 9 节）；对方停下后接着做新任务。派发方自己手上的工作若正是为那件任务而起的，那件不取代，否则会连自己一起停掉。

改派由派发方声明，中枢不从"是不是同一个发起方"去推断：同一派发方连派两件事，可能是想换一件，也可能是想两件都做，猜错就会误杀。

派发时声明；`subscribe` 把任务的档位升为 `wake`，订阅多个就是汇合（全部或任一结束后一起送来，唤醒）；`inbox` 是 `lazy` 的主动出口。用户的话、聊天消息、任务本身都是 `wake`。

## 7. 通知规则（NotificationHook）

- 任务结束（做完或停止）→ 给发起方一条结果消息，按发起方声明的档位走管线。
- 停止方就是发起方时不通知（自己停的、自己收尾的），不论从它的哪个会话停的；它在原会话上的订阅照常解除。
- 级联停止的停止方记为根因，规则照常适用：A 停自己的树不会收到回音。
- 发起会话本身因这次撤销被停下的，它派出的任务也不通知：它的那份工作已经整体撤掉，没有可做的事。
- 执行方：它的工作被整体停下（见第 9 节），就不再告诉它；它还有别的任务开着、或它当时空闲，就告诉它哪些撤了、哪些因还服务于别的工作而没撤（`lazy`：在工作就插进去，空闲就随下一轮附上）。方案只要求通知发起方；这样做是为了不让执行方的模型以为一件已撤的事还在等它。

## 8. 权限按角色（capabilities.ts）

**工具清单固定**：每个会话的 `team` 工具服务始终列出全部工具，不随任务变化。后端可能只取一次清单，之后不再取（codex 0.166 收到 `notifications/tools/list_changed` 也不重取，已实测）；所以清单不能依赖运行时状态，能不能用在调用时判断。

**派活和发消息的权限以角色为单位**（没有角色的 Agent 使用独立授权键 `agent:<id>`）。一个角色能联系谁：

| 来源 | 写在哪 | 说明 |
| - | - | - |
| 角色定义的默认值 | `role.json` 的 `grants: ["dispatch", "message"]` | 能联系所有人；预设团队里导演、技术负责人有 |
| 项目配置 | `.xsb2/config.json` 的 `permissions: { "<角色>": { "dispatch": ["<角色>" 或 "*"], "message": [...] } }` | 用户运行时选"始终允许"时写入 |

**没有这些权限时，运行时问用户**：`dispatch_task`、`send_message`、`broadcast`、`ask`（问发起方以外的人）调用时，中枢经权限请求（`session/request_permission`）问用户，选项是"允许一次 / 始终允许 / 拒绝"；调用一直等到用户回答。"始终允许"写进项目配置，之后不再问。拒绝时调用返回原因。

动态团队同样使用这张授权图。`list_roles` 列出尚未实例化的角色；`create_role` 创建角色类型，`create_agent` 创建该类型的实例，两者都检查调用者向目标类型的 `dispatch` 权限，没有时走同一个用户授权流程。一次允许仅覆盖当前调用；始终允许保存类型边，因此即使目标还没有实例，也能授权。创建工具不允许覆盖已有角色或实例，新角色不带 `grants`。

`grant_permission { role, cap, to }` 把权限授予 `role` 类型。能向该类型派发任务，就能给它授权，但所授 `cap` 的每个目的类型必须已经在调用者自己的同种权限内；`*` 只能由该能力已无限制的角色授出。`dispatch` 不自动带来 `message`。任务发起方和当前消息发送者的临时联系权不能转授。检查在授权等待结束后重新执行；停止使在途创建和授权失效。

持久边保存的是角色类型，执行时才解析成具体实例。这使同类型的现有和未来实例复用权限，不必增加一套实例到实例的持久授权图。无角色 Agent 的 `agent:<id>` 是独立实例键，不能被同名动态角色继承。启动时旧配置中明确对应无角色 Agent 的键会迁移；若旧键同时是已存在的角色名，保留为类型权限，无角色的同名 Agent 需重新获得授权。

**不需要权限**（随工作而来）：向派自己活的 Agent 交差、提问（`report_result`、`ask`）；回复正在读的消息的发送方；`escalate_to_user`；查看、订阅、撤销自己发起的东西；非协作工具（资产、记忆、技能、后台任务）。`report_result` 在没有 Agent 派来的任务时被拒，并说明原因。

## 9. 停止与传染（CascadeHook + 任务图）

算法见 [TASK-GRAPH.md](TASK-GRAPH.md)：沿起因边求撤销集；多依赖的活默认不撤，只告知（`cascade.pre_propagate` 可改为强制）。

- **谁能停**：发起方停自己的（`cancel_task`，或以 `onBusy: "replace"` 改派，第 6 节）；用户可停任何任务（`_dev.xsb/tasks/cancel`、`xsb tasks cancel`）；中枢停跑不了的。
- **用户按停止（Esc）**：先冻结那个会话的调度，批量撤销当前及已有的排队、等待前置任务，沿任务图传染；未执行消息撤回，结果保留但不自动唤醒。工作代次递增，旧任务晚到的结果只进收件箱。停止后的新请求是新工作，等旧轮确认结束再执行。普通单任务撤销和改派保持原有范围。
- **顺序与确认**：执行方会话如果只为被撤的工作而忙，就向它发 `session/cancel`，等它报 `idle`（一轮结束）后，整次撤销才在一个事务里落账；等不到（10 秒）也落账。还没交给执行方的任务邮件当即收回，被撤销集挡住的任务这期间不会被放行。工具调用 `cancel_task` 因此可能答"正在停"。
- **在途消息**：中枢里还排着的全部丢弃，从未触达后端；已交给后端的，按插入回执结算（第 10 节）。

## 10. 台账（LedgerHook）

```
queued ──开始一轮──► submitted ──插入回执──► inserted ──之后有输出 / 正常 idle──► seen
  │撤销、订阅收回      │-32800，或停下时还在中枢里   │停下，之后没有输出
  ▼                   ▼                          ▼
discarded_unseen ◄──────────────────── inserted_unprocessed ──会话继续──► seen
                    （会话被替换）
inboxed ──随下一轮──► inserted …
```

`submitted` 在写入后端前带上持久化的 `offered`；连接断开或重启时仍没有回执、也没有 -32800 的，记为 `insertion_uncertain`（插入未确认，不重放、不自动重发）。信号都是 v2 的：`inserted` 是 `session/prompt` 的应答，`discarded_unseen` 是 -32800 或停下时还在中枢里，`seen` 是之后后端报告了任何输出、或这一轮正常结束。台账只向前走，写在 `.xsb2/ledger.jsonl`，推给观察者（`_dev.xsb/messages/update`）；Agent 用 `message_status` 查自己发出的消息，`task_status` 里也有承接者是否已看到任务。用户的消息不会是 `queued`（规则 0）。

## 11. 与方案不同之处

| 方案 | 这里 | 理由 |
| - | - | - |
| 工具名 `team.dispatch_task` 等 | MCP server 名为 `team`，工具名不带点；后端里显示为 `team/dispatch_task`、`mcp__team__dispatch_task` | 工具名只能是 `[a-zA-Z0-9_-]`（Claude API 的要求），点会让工具无法调用 |
| `cancel_task`、`task_status`、`subscribe`、`inbox` 随派发能力授予 | 始终可用，只作用于调用者自己发起的东西 | Agent 能自己启动后台任务（`start_job` 不是协作），就必须能撤销、订阅它；所有权校验已是权限边界 |
| 方案的工具清单里没有汇合 | `subscribe(task_ids, mode, note)`：订阅多个即汇合 | 派出几件活、全部回来再继续是常用的模式；把它放进 `subscribe` 不多一个工具 |
| 权限随任务授予 | 权限按角色，未授权时运行时问用户，"始终允许"写进项目配置 | 后端只取一次工具清单，随任务变化的清单会和模型看到的脱节 |
| 只通知发起方 | 执行方没被停下工作时也告诉它（`lazy`） | 不让它的模型以为一件已撤的事还在等它 |
| 等 `idle(cancelled)` 确认后落账 | 照做，另加 10 秒的兜底 | 后端一直不确认时，任务不该永远悬着 |
| Gemini P1、Grok P2 | 不内置 | 两者都只说 v1，按决定不做 v1 桥 |
| 任务状态 `requires_action` | 留在 Agent 状态上 | 权限请求属于会话，一轮可能同时服务几个任务 |
| 同一发起方的 dispatch 隐式抢占（后经评审改为显式） | `onBusy: "replace"` 才取代，默认排队；结束原因 `superseded` | 同一派发方连派两件，中枢分不清是换一件还是两件都做；业界（LangGraph 的 double texting 默认 enqueue，interrupt 由调用方选）也由调用方声明 |
| 状态 `pending`、`error`、`cascaded` | `status` 保留原值（`blocked` 即 pending），`ended.reason` 区分 | 客户端与 CLI 已按现有状态显示 |

## 12. 不变量与验证

| 方案的不变量 | 如何成立 | 测试 |
| - | - | - |
| 排队消息永不触达 ACP；丢弃对模型无痕、对台账有痕 | 排队只在中枢的会话队列；收回、-32800 记 `discarded_unseen` | kernel 5、e2e 7、32 |
| 每条消息处于确定的一态 | 台账只向前；信号来自 v2 回执与状态 | kernel 7、e2e 20、32、35 |
| initiator、stopper 可审计；统一收口；停止方即发起方时不通知 | `Task.initiator`、`Task.ended`、`finish`；`audit.jsonl` | kernel 1、e2e 14、34、35 |
| 通知完成与调用后端解耦，只有一条投递管线 | 写进收件箱即 `notify.delivered`；去向由 `message.pre_deliver` 决定 | kernel 4、e2e 2、35 |
| 用户的消息不会 `queued` | 规则 0；用户的输入进会话队列的最前 | kernel 5、e2e 20 |
| 用户总能插话并保护这一轮；Agent 只插进未受保护的一轮，否则排队；停止对方工作要显式改派 | `deliveryPolicy`、`LiveSession.steer`、`Kernel.replace` | kernel 5、5b、turns（同伴归入 Agent 的 turn） |
| 停止只沿起因边传染，根因唯一；确认后落账 | `doom`；`ended.cause`；等 `acp.turn_ended` | kernel 3、e2e 14、32、34 |
| Kernel 零 ACP/UI 依赖 | kernel.ts 只引用 protocol 与 store 的类型、hooks、ledger、state、task-graph、prompts（措辞）、util | kernel.test.ts |
| 后端无感知 | 后端只收到标准的 v2 请求 | 全部 e2e（mock 后端说 v2） |
| 隐式协作优先：任务完结不依赖模型调用工具 | 隐式完结；契约由 QualityGate 追问 | kernel 6、e2e 2、14、25 |
| 权限按角色，工具清单固定 | `capabilities.ts`；`tools.ts` 的 `authorize` | e2e 8、33、35；cli 2 |

当前 turn ID、保护状态、追加指令、未读输入恢复及后端隔离的具体规则见 [TURN-LIFECYCLE.md](TURN-LIFECYCLE.md)。
