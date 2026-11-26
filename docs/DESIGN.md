# xsb 设计说明

> 历史设计记录。当前版本的编排接口、会话和交付约定见[工作流指南](WORKFLOWS.md)。

xsb 是一个多主 Agent 协作系统。每个 Agent 是一个长期存在、有自己工作区和记忆的"主 Agent"；用户可以和任何一个直接对话，Agent 之间也可以直接对话、派发任务。系统里没有任何角色的概念，"编剧 / 导演 / 灯光师"只是 `xsb agent add` 时写进去的名字、描述和说明文字。

## 1. 总体结构

```
 编辑器 / 其他 ACP 客户端 ──stdio──▶ xsb acp ─┐
 xsb chat / send / watch ───────────────────┤  ACP v2 + 扩展
                                            ▼
                                   ┌─────────────────┐
                                   │    Hub 守护进程   │  .xsb2/ 下的 jsonl + wal
                                   │  会话 · 邮箱 · 任务 │
                                   └──┬───────────▲──┘
                         ACP v2 + 扩展 │           │ MCP（协作工具 team）
                                      ▼           │
                              后端 Agent 进程（claude / codex / 封装的三方 agent …）
```

- **Hub** 是唯一的常驻进程，持有所有后端进程和全部状态，按需自动启动。
- **对外**它是一个标准 ACP agent。不懂扩展的客户端把它当普通 agent 用；懂扩展的可以选 Agent、插话、观察任务。
- **对内**它是每个后端的标准 ACP client。Agent loop 完全由后端自己跑，Hub 不实现。
- **协作工具**通过 ACP 标准的 `mcpServers` 注入给后端，是一个普通的 stdio MCP server。

同一份 JSON-RPC 实现（[jsonrpc.ts](../packages/protocol/src/jsonrpc.ts)）承载这三条链路。

### 1.1 代码结构：依赖只向下

```
@xsb/cli        xsb 命令。只是 Hub 的一个 ACP 客户端
@xsb/desktop    桌面应用（Electron）。同样只是 Hub 的一个 ACP 客户端，见 GUI.md
   │
@xsb/hub        Hub 守护进程：会话与回合、后端进程、邮件与任务、权限、协作工具
   │      │
   │   @xsb/store      只追加的 JSONL + 预写日志，不了解 Hub 的任何概念
   │
   │   @xsb/adapter    把没有 ACP 入口的 agent 封装成后端；Hub 不依赖它，只通过 ACP 与它启动的进程对话
   │      │
@xsb/protocol   线上的一切：JSON-RPC、用到的 ACP 类型、ACP 扩展及其数据形状、错误码
```

| 库 | 职责 | 不做什么 |
| - | - | - |
| [@xsb/protocol](../packages/protocol) | 两个进程之间说的每一句话的定义 | 不含任何行为；不依赖其他库 |
| [@xsb/store](../packages/store) | 事件日志的持久化与跨文件原子性 | 不知道日志里记的是什么 |
| [@xsb/adapter](../packages/adapter) | 三方 agent 的唯一封装：`AgentAdapter` → stdio 上的 ACP | 不补能力；缺的由 Hub 统一补 |
| [@xsb/hub](../packages/hub) | 系统的全部行为 | 不实现 agent loop；不依赖 CLI |
| [@xsb/desktop](../packages/desktop) | 窗口里的交互（[GUI.md](GUI.md)） | 与 CLI 相同；也不依赖 CLI |
| [@xsb/cli](../packages/cli) | 终端上的交互 | 不读写 `.xsb2/` 下的状态，一切经 ACP |

约束：下层不引用上层。Hub 需要另起进程的两处（守护进程自身、给后端用的 MCP 桥）都是 `@xsb/hub` 自己的入口（`xsb-hub`、`xsb-mcp-bridge`），不经过 CLI。CLI 与 Hub 之间共享的数据形状（`AgentInfo`、`Task`）定义在 `@xsb/protocol`，因为它们是 ACP 扩展的一部分。

Hub 内部按"谁拥有什么"分模块（[packages/hub/src](../packages/hub/src)）：

| 模块 | 拥有 |
| - | - |
| `hub.ts` | 组合根：Agent、会话、已连接客户端的登记，两个 socket 的生命周期 |
| `acp-server.ts` | 对外的 ACP agent：一个已连接客户端的全部请求处理 |
| `session.ts` | 一个会话的回合引擎：排队、运行、插话、取消，与后端会话的绑定；向台账报告输入的去向。不区分后端 |
| `backend.ts` / `backends.ts` | 一个后端进程：链路末端，握手、能力、补齐缺的能力，对上提供统一的 `prompt` / `steer` / `cancel` / 每个 Agent 至多一个进程的进程池 |
| `kernel.ts` / `hooks.ts` / `task-graph.ts` / `ledger.ts` | 任务调度框架，与后端无关：任务、撤销与传染、汇合、收件箱、通知、台账，以及挂载一切横切行为的 Hooks（[KERNEL.md](KERNEL.md)） |
| `delivery.ts` / `jobs.ts` / `audit.ts` | 挂在 Hooks 上的 Effector：投进会话、跑后台任务、审计 |
| `roles.ts` | 角色：按名字查找（项目自己的优先，再找所用的预设团队），读取说明、MCP 配置和 skills |
| `presets.ts` | 预设团队：应用自带的（`presets/<团队>/<语言>/`）和用户自己的（`~/.xsb2_global/presets/`），组织相同；继承（`extends`）与叠加、冲突与问题、检查。写法见 [PRESETS.md](PRESETS.md) |
| `assets.ts` | 资产库：登记、版本、查找 |
| `mcp-client.ts` | 调用一次 stdio MCP server 的一个工具（后台任务用） |
| `permissions.ts` | 把后端的权限请求转给人 |
| `tools.ts` / `mcp.ts` / `mcp-bridge.ts` | 协作工具面向模型的一侧（参数与措辞）/ MCP server / 桥接进程 |
| `prompts.ts` | Hub 对模型说的所有文字 |
| `state.ts` | 内存状态 = 对事件日志的折叠 |
| `daemon.ts` | 后台进程：独占一个项目、启动、停止 |
| `config.ts` / `paths.ts` | 两个配置文件 / `.xsb2/` 的布局 |

## 2. 接入后端

### 2.1 配置：两个文件

| 文件 | 字段 | 含义 |
| - | - | - |
| `~/.xsb2_global/config.json`（这台机器） | `backends.<名称>.command` | 启动该后端的可执行文件，按 PATH 查找 |
| | `backends.<名称>.args` | 启动参数 |
| | `plugins.<名称>.enabled` | 在这台机器上停用某个插件（见下） |
| | `approvedPlugins` | 这台机器确认过的工作区插件的指纹 |
| `<项目>/.xsb2/config.json`（这个项目） | `defaultAgent` | 普通 ACP 客户端不指定时连到哪个 Agent |
| | `teams` | 项目使用的预设团队 |
| | `language` | Agent 的工作语言（`en` 或 `zh-CN`），见 3.4 |
| | `plugins.<名称>.enabled` | 在这个项目里停用某个插件 |

**插件（工具服务，MCP）**（[plugins.ts](../packages/hub/src/plugins.ts)）：每个插件一个文件夹，三处位置结构相同——应用自带 `<应用>/plugins/<名称>/`（随代码放在 `dist/plugins`，开发与发布时相对位置一致，不在 asar 内）、这台机器 `~/.xsb2_global/plugins/<名称>/`、项目 `.xsb2/plugins/<名称>/`，后面的同名代替前面的。每个插件文件夹是一个 npm 包（不必发布）：`package.json` 的 `main` 是要运行的文件（未写时按 npm 惯例为 `index.js`），必须是插件文件夹里的文件；它用应用自带的 Node 以 stdio 方式作为 MCP 服务启动。`description` 是告诉会话的说明；插件自己的环境变量写在 `xsb.env`，其中可用 `${pluginDir}`、`${node}`（应用自带的 Node）、`${env:变量名}`。插件名是文件夹名，不是包名。内置的 browser、media 也是这样的文件夹（`main` 为打包出的 `server.mjs`）。添加插件就是放入文件夹，重启桌面端或调用 `_dev.xsb/tools/apply`；中枢在启动后端时读取，按名称排序，工具与提示词不变的会话不会被重启。项目插件随项目走，要在这台机器上确认（按项目路径、名称、`package.json` 和 `main` 文件的内容算指纹，任一改动都要重新确认；`main` 再加载的其他文件不在指纹内）后才启动。文件夹缺失或被删、`package.json` 缺失或格式错误、`main` 不在文件夹内或不存在、配置文件损坏，都只让那个插件标为"无法使用"并跳过，不影响会话和桌面端。

两个文件各有一个 `version`，只表示该文件自身的格式。后端只在全局定义，项目不能覆盖；Agent 用后端的**名称**引用它（`agents.jsonl` 的 `backend`）。两个文件都是每次使用时读取，修改后不必重启 Hub。

### 2.2 优先用官方 ACP 封装，只说 ACP v2

Hub 对后端和对客户端都只说 ACP v2（草案，claude-agent-acp 0.107、codex-acp 2.6 都已实现，见 [KERNEL.md](KERNEL.md) 2）。内置两个后端，都是各家自己的 ACP 入口：

| 名称 | 命令 | 来自 |
| - | - | - |
| claude | `claude-agent-acp` | `@agentclientprotocol/claude-agent-acp` |
| codex | `codex-acp` | `@agentclientprotocol/codex-acp` |

Gemini CLI（0.68）和 Grok（1.0.88）的 ACP 入口只说 v1，不内置；全局配置里可以登记任何说 v2 的 agent。说 v1 的会在握手时被拒绝（`backend_incompatible`）。

代码里没有按厂商分支。插话、扣住、插入回执、工作状态是 v2 本身的，各后端由自己实现；Hub 只看后端在 `initialize` 里报告的能力，缺什么补什么，补齐发生在 `backend.ts` 和会话绑定处：

| 能力 | 有 | 没有 |
| - | - | - |
| `session.systemPrompt` | 说明文字作为系统提示词追加 | 拼在该会话第一条 prompt 前面 |
| `session/resume`（v2 的基本能力） | 进程重启后恢复原会话 | 恢复失败时新开会话，并交接对话（见 6） |
| `session.additionalDirectories` | 把共享目录挂进去 | 只在说明文字里给出绝对路径 |
| `session.prompt.image` | 图片原样送达 | 换成一句"这里附了一张图片，你看不到"，其余内容照常；对话记录里保留原图 |

### 2.3 没有 ACP 入口的三方 agent：同一条链路，只有末端不同

```
Hub ── Backend ──ACP──▶ claude-agent-acp / codex-acp / …              官方 ACP agent
                └─ACP──▶ serveAdapter(AgentAdapter 的实现) ──▶ 三方 agent
```

- **一个**通用封装，不按 agent 各写一个：[@xsb/adapter](../packages/adapter) 的 `serveAdapter` 在 stdio 上提供 ACP v2（插入回执、工作状态、工作中来的 prompt 扣住或插入、取消时以 -32800 回应未插入的），把请求映射到 `AgentAdapter`（`newSession`、`prompt`、`cancel`，可选的 `resume`、`steer`，和一组能力声明）。agent 之间的差别放在这个接口的实现和它的配置里。
- 封装出来的程序在 `~/.xsb2_global/config.json` 里登记为一个普通后端（`command`、`args`）。
- Hub 不知道它是封装。对 Hub 来说后端只有一个契约："一条在 stdio 上说 ACP 的命令"。官方入口和封装由同一份代码启动、调度、报错（[backend.ts](../packages/hub/src/backend.ts)），配置里也没有区分两者的字段。
- 封装不补能力：适配器没声明的能力不通告，Hub 按 2.2 的表同样补齐。所以"补能力"的代码只有一份，对官方 agent 和三方 agent 都生效。

### 2.4 xsb 不管的事，以及错误码

xsb 只负责启动后端，**不安装、不登录、不决定权限**：

- 不安装：命令不在 PATH 上就报错，不会 `npx` 下载。（桌面应用同样不安装；它自带 claude 和 codex 的 ACP 封装，并在启动 Hub 之前把它们放到 PATH 上，见 GUI.md 第 8 节。）
- 不处理凭据：配置里没有 env 或密钥字段，后端进程原样继承启动 Hub 时的环境，登录状态用各后端自己的 CLI 和设置。
- 不决定权限：是否询问、是否 bypass 是后端自己的设置。后端若发来权限请求，Hub 一律转给人（见 6）。

后端相关的失败都带错误码（[errors.ts](../packages/protocol/src/errors.ts)），消息里写明是哪个 Agent、哪个后端：

| `error.code` | `error.data.reason` | CLI 退出码 | 何时 |
| - | - | - | - |
| -32000 | `auth_required` | 10 | 后端报告未登录（ACP 标准码） |
| -33101 | `backend_not_installed` | 11 | 启动命令不存在 |
| -33102 | `backend_start_failed` | 12 | 进程在握手完成前退出；附退出码和 stderr 末尾几行 |
| -33103 | `backend_unknown` | 13 | Agent 引用的后端名在全局配置里没有 |
| -33104 | `backend_incompatible` | 14 | 后端的 ACP 协议版本不是 v2 |

判断请用 `data.reason`：`-331xx` 这一段在 ACP 里没有保留给扩展的约定，将来可能与别的扩展重号。

### 2.5 给人看的报错：原因加事实

Hub 不知道读报错的人用什么语言，所以它不负责措辞。凡是要给人看的报错（上表的五种，以及"没有这个角色""团队还有人在用""角色名不合法"等，共二十来种）都带 `data.reason` 和这件事的事实（是哪个角色、被哪些 Agent 占用……）；`message` 是英文措辞，留给不认识 `reason` 的客户端。

原因、每种语言的措辞、以及把一个错误按语言说出来的函数 `explain(e, language)` 都在 [errors.ts](../packages/protocol/src/errors.ts)，CLI 和桌面应用共用这一份。调用方用错了协议的报错（参数形状不对之类）不带 `reason`，保持英文：它们是写给开发者的。写给模型的报错（协作工具的返回）同样保持英文。

## 3. ACP 扩展

规则：**一种功能一个扩展，所有 ACP 链路共用同一份定义**（[ext.ts](../packages/protocol/src/ext.ts)）。ACP v2 本身有的（工作中再发消息、插入回执、工作状态）直接用，不再自定义。线上约定遵循 ACP Extensibility：自定义方法以 `_` 开头，自定义数据放 `_meta`，能力在 `initialize` 的 `_meta` 里通告。

| 功能 | 扩展 | 对外（客户端 → Hub） | 对内（Hub → 后端） |
| - | - | - | - |
| 多 Agent 寻址与目录 | `dev.xsb/agents` | 选 Agent、增删查、状态通知 | 不适用（后端是单个 agent） |
| 角色编辑 | `dev.xsb/roles` | 读写、检查 MCP server、变更通知 | 不适用 |
| 预设团队 | `dev.xsb/teams` | 有哪些团队、项目用了哪些、使用与停用 | 不适用 |
| 后端清单 | `dev.xsb/backends` | 这台机器有哪些后端、是否已安装 | 不适用 |
| 任务观察与停止 | `dev.xsb/tasks` | 列表、状态通知、用户撤任务 | 不适用 |
| 台账 | `dev.xsb/messages` | 每条消息的去向（模型看没看到） | 不适用 |
| 资产库 | `dev.xsb/assets` | 列表、新版本通知 | 不适用 |
| 消息来源 | `_meta["dev.xsb/origin"]` | 标在 `user_message_chunk` 上 | 标在 `session/prompt` 上 |
| 语言 | `_meta["dev.xsb/language"]` | 客户端声明用户读哪种语言 | 不适用（写进系统说明，见 3.4） |

### 3.1 插话、停止与回执

**后端怎么接收工作中来的话**（以实际后端的代码为准）：

- claude-agent-acp：只有 `session/prompt`。空闲时它开始一段工作；工作中收到的进 Claude Code 的输入队列，在下一个工具调用之间并入当前工作；当前工作不再调用工具时，它在这段工作结束后开始下一段。应答（`{ messageId }`）在并入时到达。
- codex-acp：工作中收到的 `session/prompt` 排到当前工作之后，不插进去。插进当前工作要用扩展 `_session/steering`（initialize 应答的 `_meta.steering.supported`）。中枢总是带 `_meta.steering.idleBehavior = "promptRequired"`：没有在跑的工作时它什么都不做，答 `promptRequired`，中枢改发 `session/prompt`。steering 的应答只说明交给了 Codex；进没进对话，以随后那条 `user_message_chunk` 为准；这段工作结束前没进去的，Codex 静默丢弃。

**一轮**是后端的一段工作：从中枢交给空闲后端的那条输入起，到后端报 `idle` 止。中枢的一轮与后端的一段工作一一对应，不把后端的两段工作并成一轮。

| # | 情形 | 结果 |
|---|---|---|
| 1 | 会话空闲，用户说话 | 开一轮。会话没有开着的用户任务时，这是一个新的用户任务；有（它在等子任务）时，是那个任务的继续 |
| 2 | 会话在工作，用户说话 | 立即单独发给后端，插进当前工作（claude `session/prompt`，codex `_session/steering`），不与任何输入合并，带自己的 messageId 和来源。这份工作有任务时，不开任务，话里点名的同事授权给这些任务；没有任务时（比如它在读一份结果），这是一个新的用户任务，同样插进去 |
| 3 | 同上，但这一轮的第一条输入后端还没接收（后端在启动或恢复，或第一条已交出、还没应答） | 在中枢里等第一条被接收，然后按到达顺序逐条单独发出 |
| 4 | 插话在这段工作结束前进了对话 | 属于这一轮；这一轮结束时完结的任务，结果里有它 |
| 5 | 后端报 `idle` 时，插话还没进对话（claude 还在队列里；codex 已交出、没落地） | 这一轮就此结束，任务按这一轮完结，结果里没有它，和用户没说这句话一样。它是下一轮的第一条：claude 自己会开始下一段工作，中枢不重发；codex 丢弃了的，中枢用 `session/prompt` 重发。下一轮是用户的：没有开着的用户任务时，开一个用户任务，从这句话起记它的经过 |
| 6 | 同伴的消息、任务、结果到达正在工作的会话 | 在中枢排队，等这一轮结束，不交给后端（[KERNEL.md](KERNEL.md) 6）。中枢自己的通知（任务被停止、交付物追问）按第 2 条插进当前工作 |
| 7 | 用户停止（`session/cancel`） | 停止当前工作及此时已接收的待办：运行、排队、等待前置的任务批量冻结并按任务图撤销；未执行普通消息和用户插话撤回，发送请求以 -32800 结算，不转入下一轮。已进对话的留在对话里。结果和非指令性系统通知保留但不自动唤醒；停止之后的新请求等旧轮结束再执行。工作代次和撤销写入持久化状态，重启也不恢复旧待办 |
| 7b | 会话只为被撤的任务工作，中枢停下它 | 保持单任务撤销范围：未进对话的用户插话保留，其他独立邮件退回队列；任务按 [KERNEL.md](KERNEL.md) 9 停止 |
| 8 | 停止之后，下一轮因新请求开始 | 用户停止后不重放撤回的输入。中枢单任务撤销后，先把第 7b 条保留的用户插话按原顺序作为一轮，再处理触发的邮件 |
| 9 | 一轮失败（后端出错） | 没进对话的输入记为丢弃，会话记录里追加 `_meta["dev.xsb/discarded"] = { messageId, origin, content }`（[ext.ts](../packages/protocol/src/ext.ts) 的 `Discarded`）；同伴的发送方被告知 |
| 10 | 任务隐式完结（[KERNEL.md](KERNEL.md) 5） | 结果是任务交给模型起、到完结为止的完整经过，按时间顺序：智能体的每条消息全文，用户的插话全文，其他输入各一行，每次工具调用一行（名称、状态）；不含思考和工具输出，不含任务自己的说明。超过上限时，最后一条消息和用户插话保持全文，其余消息截短 |
| 11 | 执行方调用 `report_result` | 结果就是它交的 |

每条输入（用户的、同事的、中枢的）的去向记在台账里（`Ledger`，[KERNEL.md](KERNEL.md) 10）：插入回执、-32800、之后有没有输出，都是 v2 的信号。

### 3.2 多 Agent：`dev.xsb/agents`

```
通告   agentCapabilities._meta["dev.xsb/agents"] = { version: 1 }
选择   session/new 的 params._meta["dev.xsb/agent"] = "<agentId>"；不带则用默认 Agent
标注   SessionInfo._meta["dev.xsb/agent"]、_meta["dev.xsb/main"]
请求   _dev.xsb/agents/list | get | put | remove | restart
通知   _dev.xsb/agents/update { agent }、_dev.xsb/agents/removed { id }
```

`get` 除了 Agent 本身，还返回它自己的说明和 `systemPrompt`：一个新会话会被告知的全部文字（角色说明 + 自己的说明 + skill 目录 + 协作说明 + 记忆摘要），用于预览和调试。`restart` 停掉它的后端进程，使改过的说明、工具、skills 从下一轮起生效；正在运行的那一轮会失败。

角色是另一个扩展 `dev.xsb/roles`，供编辑界面使用：

```
请求   _dev.xsb/roles/list | get | put | remove | check
通知   _dev.xsb/roles/update { role }、_dev.xsb/roles/removed { name }
```

通知只在经 `put` / `remove` 修改时发出。直接改角色目录里的文件仍然会在下次使用时生效，但没有人被告知。

预设团队是 `dev.xsb/teams`（见 5.6）。使用或停用一支团队后，来去的角色同样以上面两个通知告知：

```
请求   _dev.xsb/teams/list | use | drop
```

这台机器有哪些后端是 `dev.xsb/backends`：

```
请求   _dev.xsb/backends/list -> { backends: [{ name, command, args, installed, installHint? }] }
```

是否已安装由 Hub 回答，因为启动后端的是 Hub：客户端（尤其是桌面应用）的 PATH 可能与它不同。

客户端在 `clientCapabilities._meta["dev.xsb/agents"]` 声明后成为"观察者"：收到上面的通知，并且会收到**无人值守会话**的权限请求（见 6）。

不认识扩展的编辑器可以为每个 Agent 配一个入口：`xsb acp --agent <id>`。

### 3.3 来源标注：`dev.xsb/origin`

一个会话的输入可能来自用户、别的 Agent 或 Hub 自己，而 ACP 只有一种输入（用户消息）。来源写在 `_meta["dev.xsb/origin"]` 里：`{ kind: "user" | "agent" | "system", agentId?, sessionId?, messageId?, taskId?, role?, steered? }`。不认识它的一方看到的就是一条普通用户消息。

**自己的输入何时进入会话。** 按 ACP 的惯例，客户端不会收到自己发出的输入。在 `capabilities._meta["dev.xsb/origin"]` 声明后，客户端自己的输入也会像别人的一样送给它，时机是它插入会话的那一刻。客户端在 `session/prompt` 的 `_meta["dev.xsb/origin"].messageId` 里给消息起名，回来的 `user_message_chunk` 和 `session/prompt` 的应答都带同一个 `messageId`。没有声明的客户端不收到自己的输入。

（ACP 的 Subagent Sessions RFD 里有 `session_message` 更新，语义相近，但仍是 Preview 且面向父子会话。等它稳定后，这个扩展可以换成它，改动集中在一处。）

### 3.4 语言：`dev.xsb/language`

语言有两处，各归各管：

| | 是什么 | 由谁决定 |
| - | - | - |
| 界面语言 | 窗口、命令输出、报错用什么语言 | 每个客户端自己：桌面应用取系统语言，CLI 取终端的 `LC_ALL` / `LC_MESSAGES` / `LANG`。没有对应文字表的语言用英文 |
| 工作语言 | Agent 对用户说话、互相派任务、写交付物用什么语言；预设团队读哪一份 | 项目：`.xsb2/config.json` 的 `language` |

```
声明   clientCapabilities._meta["dev.xsb/language"] = "zh-CN"
```

- 项目还没有工作语言时，取第一个声明了语言的客户端的；之后不再跟着客户端变，要改就改配置文件。这样在英文终端里跑一次 `xsb status`，不会把一个中文项目的 Agent 切成英文。
- 工作语言写在每个 Agent 系统说明的 "Language" 一节：给人看的文字用这种语言，标识符（资产 id 与类型、工具和参数名、路径、代码）保持原样。Hub 自己写给模型的协作说明仍是英文。
- 这不涉及后端的任何设置：模型、接口、会话模式仍由用户在各后端里自己决定，xsb 只是在系统说明里多说一句话。
- 目前支持 `en` 和 `zh-CN`（[ext.ts](../packages/protocol/src/ext.ts) 的 `LANGUAGES`）。加一种语言要补三处：`errors.ts` 的措辞、CLI 和桌面应用各自的文字表、预设团队的一份目录。

## 4. Agent 之间：工具调用

Hub 给每个后端会话注入名为 `team` 的 MCP server（工具定义在 [tools.ts](../packages/hub/src/tools.ts)，行为在 Kernel，见 [KERNEL.md](KERNEL.md)）。工具名不能带点，所以方案里的 `team.dispatch_task` 在后端里是 `team/dispatch_task`、`mcp__team__dispatch_task`。

**协作是隐式的**：一个任务在执行方的一轮结束时结束，这期间的完整经过就是结果（3.1 第 10 条），通常不用调用任何工具（见 6）。**工具清单固定，权限按角色**（[KERNEL.md](KERNEL.md) 8）：每个任务都让执行方能触达发起方；派发和给别人发消息看角色的权限（`grants` 默认值、项目配置 `permissions`），没有时运行时问用户。

| 工具 | 何时有 | 作用 |
| - | - | - |
| `list_roles` | 始终 | 查看角色类型、技能、现有实例及调用者的类型授权；含零实例角色 |
| `create_role` / `create_agent` | 向目标角色类型的派发权限，没有时问用户 | 动态创建角色定义或实例；不可覆盖已有条目；新角色不带权限 |
| `grant_permission` | 向受权角色的派发权限；只能转授自己已有的同种能力 | 新增类型到类型的持久授权边，应用于当前和未来的全部实例 |
| `dispatch_task` | 角色权限，没有时问用户 | 派发任务。`deliveryPref`：`sync`（在调用里等结果，最多 `limits.awaitSeconds`）、`wake`（结果到了唤醒自己）、`lazy`（默认，随下一轮附上）。`after` 指定前置任务。与团队的契约不符时在返回里提示（见 5.6） |
| `report_result` | 执行 Agent 派来的任务时 | 提前、或以别的结果、或以失败交出任务。平常不需要 |
| `ask` | 问发起方总是可以；问别人看角色权限，没有时问用户 | 问发起方一个问题，在调用里等答复 |
| `subscribe` | 始终（只对自己发起的） | 让这些任务的结果唤醒自己；多个就是汇合，全部（或任一）结束后一起送来 |
| `task_status` / `cancel_task` / `inbox` | 始终（只对自己发起的、自己的收件箱） | 查看（含结束原因、谁结束的、承接者是否已看到）/ 撤销（只为它而起的活一并撤掉，见 [TASK-GRAPH.md](TASK-GRAPH.md)）/ 读取等下一轮的通知 |
| `send_message` / `broadcast` / `message_status` | 角色权限，没有时问用户；回复正在读的消息的发送方总是可以 | 给一个或几个 Agent 发消息，是否插话由中枢裁决；查对方的模型看到没有（台账） |
| `list_agents` | 有任何协作能力时 | 团队里有谁、各自能产出哪些资产类型、是否在忙、对接过哪些话题、自己能对它做什么 |
| `escalate_to_user` | 始终 | 告诉用户自己在等他决定 |
| `start_job` | 始终 | 把一次慢的工具调用放到后台执行（见 5.4） |
| `put_asset` / `find_assets` / `get_asset` | 始终 | 读写共享资产库（见 5.5） |
| `load_skill` | 始终 | 读取本角色的一个 skill（见 5.6） |
| `remember` / `recall` | 始终 | 按话题读写长期记忆 |

身份不靠参数：每个会话有一个 Hub 发的 token（Hub 运行期间不变，重启后重发），它的桥接进程 `xsb-mcp-bridge` 带着这个 token 连回 Hub，工具调用天然知道是谁在调，也无法冒充别人。

### MCP 表达不了的部分

MCP 只能"应答一次调用"，不能事后再对模型说话。任务结果、别人发来的消息、凑齐的一批结果，都发生在调用返回之后。这部分不走 MCP，而是回到 ACP：它们都是写进收件方收件箱的消息，经唯一的投递管线（[KERNEL.md](KERNEL.md) 6）作为一条带来源标注的 prompt 送进会话（插进正在进行的工作，或成为一轮），或留在收件箱随下一轮附上。

例外是 `sync` 的派发和 `ask`：调用在一个时间窗内等结果，结果就是返回值，不花额外的一轮。窗口有上限（`limits.awaitSeconds`，默认 50 秒），因为后端会掐断长的工具调用，卡在调用里的 Agent 也回应不了用户；超时就返回回执，结果之后按 `wake` 送达。

## 5. 约束、汇合与记忆

### 5.1 派发后等多方响应

```
导演这一轮： dispatch_task → 编剧
            dispatch_task → 灯光师1
            subscribe([t1, t2], mode: "all", note: "两份都到了再定分镜；若剧本没定稿先退回")
            结束本轮                           ← 导演此时是空闲的
用户 → 导演： "进度怎么样？"                    ← 普通的一轮，不是插话
t1 完成                                        ← 结果被门扣住，不打扰导演
t2 完成                                        ← 门满足：两份结果 + note 合成一条消息，成为导演的下一轮
```

- **确定性的部分由 Hub 做**：`all` / `any` 的判定、结果的扣留与合并、崩溃后不丢不重。
- **需要判断的部分交给模型**：`note` 是 Agent 写给自己的提醒和条件，随结果一起回来，由它推理"条件是否满足、要不要再派发"。
- 没有订阅的任务，结果按派发时的档位一个一个送达（`lazy` 的随下一轮附上）。两者是同一种消息：单个结果就是"只含一个任务、没有汇合条件"的结果集。

### 5.2 任务的启动约束

`dispatch_task` 的 `after: [taskId…]` 表示"这些任务结束之前不要开始"。任务先处于 `blocked`，前置全部结束时 Hub 才投递，并把前置任务的结果作为输入附上。前置失败了也会投递，由接到任务的模型判断输入是否足够、是否该在结果里说明。

### 5.3 记忆与"找对人"

两层，互相补充：

- **话题账本（Hub 自动维护）**：每条消息、每个任务都带 `topic`。Hub 从实际流过邮箱的记录里维护"Agent → 话题 → 对接过的 Agent、次数、最后时间"。它不依赖模型自觉，重启后由日志重建。
- **笔记（Agent 自己维护）**：`remember(topic, content)` 是**覆盖写**，一个话题一条当前结论，不是无限追加；`recall(query)` 同时查笔记、账本和相关任务。

它们在这些地方起作用：

- `list_agents` 给每个同事列出"你和它对接过的话题"。
- 往一个有历史的话题里发消息 / 派任务，而对象不是之前对接的人时，工具结果里会明确提示"这个话题之前是和 灯光师1 对接的，你发给了 灯光师2"。这是提示而不是拦截，是否换人由模型决定。
- 收到带话题的消息时，Hub 把接收方自己关于这个话题的笔记附在后面。
- 新会话开始时（包括后端上下文丢失后重建），记忆摘要进入系统说明。

### 5.4 后台任务（job）：慢的工具调用不占住 Agent

生成一段视频要几分钟，而 MCP 调用只能阻塞等待。`start_job { server, tool, arguments, title }` 让 Hub 代 Agent 去调它**所属角色的 MCP server** 里的那个工具，调用立即返回任务号。

job 不是新机制，它就是"执行者是工具而不是 Agent 的任务"（`Task.tool`）：结果以普通的 `<xsb-task-result>` 送回，可以 `subscribe` 汇合、`cancel_task` 取消、在 `xsb tasks` / `watch` 里看到。MCP server 不需要做任何配合。

- Hub 为每个 job 单独启动一次该 MCP server，调用完即关闭，所以只适合无状态的工具（提交生成、渲染、转码）。只支持 stdio 的 server。
- **job 不重跑**。Hub 停止或崩溃时还在跑的 job，重启后标为 `failed` 并告知"结果未知、没有重跑"，由派发它的模型决定是否再提交。这与 Agent 任务的"至少一次"相反，因为一次生成可能已经花了钱。
- job 没有 `after`；需要先后顺序时由模型在拿到前一个结果后再提交。
- 取消 job（`cancel_task`）是对那次调用发 MCP 的 `notifications/cancelled`，再等工具应答（最多 15 秒）后才停掉 server：工具借此把它在外面发起的东西叫停，它的应答（例如"已在提供方取消，不计费"或"已经开始，仍会计费"）就是任务结果。取消晚了、调用照常完成的，任务按完成算。
- 一个任务被取消时，中枢按任务图把只为它启动的后台任务和子任务一并撤掉（[TASK-GRAPH.md](TASK-GRAPH.md)），并告诉承接者撤了哪些、哪些因还服务于别的任务而没撤。
- 已获授权的后台工具调用直接启动，Hub 不设工具并发数上限。
- 用户停掉一个智能体的工作，就停掉它正在做的任务（停止方是用户），连同为它启动的后台任务和子任务；派发者收到 `cancelled` 的结果（[KERNEL.md](KERNEL.md) 9）。
- 用户直接给某个智能体发消息，而它手上有别人派来的任务时，Hub 在一小段时间（默认 20 秒）里把说的话攒起来，作为一条消息告诉派发者。只看任务关系，不认角色。
- 一轮失败了（比如后端没装、后端出错），失败写进会话记录（`dev.xsb/turn_failed`），用户在这个智能体的对话里看得到：开始它的那条消息的 `session/prompt` 可能早已应答。
- job 由 Hub 发起，不经过后端的权限询问。后端只看得到 `start_job` 这一次调用。
- 在任务里用 job：承接者 `start_job` 之后结束本轮；job 的结果会唤醒它，任务在那之前不会随回合结束（见 6），结果回来的那一轮检查后结束即交差。摄影师生成镜头就是这样做的。

### 5.5 资产库与产物契约：一致性的唯一事实来源

角色形象、画风、场景、剧本、镜头表、成片，凡是团队要达成一致的东西，都是**资产**：一个有 id 的文件，id 为 `<类型>/<名称>`（如 `character/lin`）。

- `put_asset` 把文件（或一段文本）**复制**进 `.xsb2/assets/<类型>/<名称>/v<n>`，库里的文件不再被改写。对已有 id 再登记是新增一个版本，旧版本保留，可用 `character/lin@1` 引用。
- 索引是事件日志 `assets.jsonl`，与其他状态一样重启后重建。
- Agent 之间传 id，不传各自工作目录里的路径。

任务用两个字段把资产变成契约，两者都由 Hub 执行，不靠模型自觉：

| `dispatch_task` 的字段 | Hub 做什么 |
| - | - |
| `inputs: [资产 id…]` | 派发时校验存在；送达时把这些资产（描述、路径，小的文本资产连同正文）附在任务后面，并说明"以它们为准，不要重新定义" |
| `produces: 类型` | 送达时告知必须登记一个该类型的资产；任务结束时，结果里自动列出它登记的资产，**没有登记该类型时明确写出"没有交付"** |

确定性的部分（有没有交、交了什么）由 Hub 核对；交的东西好不好由派发者的模型判断。

### 5.6 角色：Agent 之间的差异从哪来

一个角色能做什么，是它**声明**出来、由 Hub 执行的东西，不是说明文字里的人设。四层各回答一个问题，下层不重复上层：

| 层 | 回答 | 内容 | 在哪 |
| - | - | - | - |
| 系统 | Agent 之间怎么协作 | 协作工具、资产机制、通用约定 | `prompts.ts`，只此一份 |
| 团队 | 这类工作怎么流转 | 每种资产由谁产出、依据什么 | 不存储：由各角色的契约推导（`Hub.team`） |
| 角色 | 这个岗位贡献什么 | 产出契约、工具、职责 | `.xsb2/roles/<角色>/` |
| Agent | 谁来做 | 后端、工作目录、记忆 | `AgentSpec` |

角色是用户写的一个目录，Agent 是角色的实例（`xsb agent add gaffer1 --role gaffer`），多个 Agent 可以共用一个角色：

```
.xsb2/roles/<角色>/
  role.json                 { "description", "backend", "mcpServers": { 名称: { command, args, env } } }
  instructions.md           这个角色是谁、怎么工作
  skills/<名称>/SKILL.md     做某一类工作的步骤；旁边可以放它引用的文件
```

| 角色给什么 | 怎么到达模型 | 何时读取 |
| - | - | - |
| `description`、`backend` | 新建 Agent 时的默认值，之后是 Agent 自己的字段（两个同角色的 Agent 可以用不同后端） | 仅在 `agent add` 时 |
| `instructions.md` | 系统说明里，排在 Agent 自己的说明之前 | 每次会话绑定 |
| `mcpServers` | ACP `session/new` 的标准字段，与协作工具并列。对所有后端一致，包括封装的三方 agent | 每次会话绑定 |
| skills | 见下 | 每次使用 |

`mcpServers` 的格式与 `.mcp.json` 相同。生成服务的密钥写在对应 server 的 `env` 里，只有这个角色的 Agent 拿得到。

角色可以直接改文件，也可以经 `dev.xsb/roles` 扩展读写（`xsb role ...` 用的就是它）。`put` 里没给的字段保持不变；`mcpServers` 和 `skills` 给了就是全集，不在其中的被删除。有 Agent 在用的角色不能删除。`check` 启动角色的 MCP server 并列出各自的工具，配置错误在这里暴露，而不是等到模型"不会用工具"。

**预设团队：项目快照与显式同步。** xsb 自带几支团队（`packages/hub/presets/<团队>/`：`team.json` 加上若干角色目录，格式与项目自己的完全相同）。首次使用时，团队角色和继承内容复制到 `.xsb2/templates/<团队>/`，项目配置 `teams` 记录使用关系。角色按名字查找，只在 `loadRole` 一处：

1. 项目自己的 `.xsb2/roles/<角色>/`；
2. 项目所用各团队在 `.xsb2/templates/<团队>/roles/` 中的同名角色。

副本与覆盖版本的行为：

- 升级 xsb 不会改变项目快照；同一支团队可以反复“建立”，只补智能体。显式 `teams/sync-preview`、`teams/sync` 在用户确认自定义改动丢失后才更新副本。
- `roles/put` 改的永远是项目自己的角色。改一个团队的角色时，先把它整个目录复制成项目自己的再改（skill 旁边的文件一并带上），此后以项目的为准。
- `roles/remove` 删的也是项目自己的角色。团队里有同名角色时，这就是"恢复预设"，有 Agent 在用也可以；只属于团队的角色不能单独删，随团队一起停用。
- 停用一支团队时，若有 Agent 的角色只有它才有，则拒绝。

同步按来源根目录类别、团队文件夹名和角色文件夹名匹配，不增加模板 ID。`templates.ts` 负责复制、预览与确认、完整目录替换及失败回滚；`.template-origin.json` 区分模板修改与独立创建的同名角色。

`RoleDetail.preset = { team, own }` 告诉客户端一个角色与预设的关系：来自哪支团队，项目是否已有自己的版本。

**skill 怎么被用上。** 模型不需要"知道去找 Hub"：

- **确定性注入（主路径）**：`SKILL.md` 的 front matter 里写了 `produces: <资产类型>` 的 skill，就是"如何产出这种资产"的步骤。任务带 `produces: shot_list` 且接收方的角色有一个声明 `produces: shot_list` 的 skill 时，Hub 把它的正文直接附在任务后面。与送达消息时附上话题笔记是同一个做法，不依赖模型判断。skill 的名称没有语义。
- **按需加载（辅路径）**：所有 skill 的名称和一句话说明列在系统说明里（声明了 `produces` 的会注明），模型用 `load_skill` 取正文。这条路依赖模型自觉。

skill 不依赖任何后端的原生 skills 机制，所以对每个后端行为一致。

**契约与团队。** 声明了 `produces` 的 skill 是一条产出契约，四个要素各有着落：

| 要素 | 写在哪 | Hub 做什么 |
| - | - | - |
| 产出哪种资产 | front matter 的 `produces` | 任务结束时核对是否登记（5.5） |
| 依据哪些资产 | front matter 的 `inputs: 类型, 类型` | 派发时核对 `inputs` 里有没有这些类型的资产 |
| 怎么做 | skill 正文 | 随任务注入 |
| 用什么工具 | 角色的 `mcpServers` | 只给这个角色的 Agent |

预设团队（[packages/hub/presets/](../packages/hub/presets)）每种语言一份：`presets/<团队>/<语言>/`，读哪一份由项目的工作语言决定。各语言之间只有文字不同，团队、角色、skill、契约、工具必须相同，测试逐项比对。`team.json` 里除了角色还有 `assets`：每种资产类型的显示名，界面用它代替 `shot_list` 这样的标识符。

团队不是一个存储的对象：项目里各 Agent 的角色所声明的全部契约就是团队（`Hub.team`）。它有三个去处，对任何团队都一样，代码里没有按角色或预设的分支：

- 每个 Agent 的系统说明里有一节 "The team"，逐行列出"资产类型：谁能产出，依据什么"。负责统筹的角色不必在说明里手写流程。
- `list_agents` 返回每个 Agent 能产出的类型。
- `dispatch_task` 带了 `produces` 而对方没有这条契约（并指出谁有，或提示可能拼错了类型），或契约要求的某类输入不在 `inputs` 里时，在返回里提示。和话题提示一样，是提示而不是拦截。

系统说明里的那一节在会话绑定时生成，角色或成员变了要到下次绑定才更新；后两处每次调用时现算。

## 6. 会话、回合与权限

任务开启、插话保护、抢占、停止和两次归纳证明的规范见 [多 Agent 生命周期契约](TURN-LIFECYCLE.md)。模型启动时收到对应规则摘要，运行时校验负责强制执行。

上下文容量、轮内增长和安全恢复见 [上下文生命周期设计与实现记录](context-lifecycle-design.md)，已实现范围与配置列在第 13 节。

- **每个 Agent 只有一条对话：它的主会话。** 用户和它说话、同事派来的任务和消息、中枢的通知都进这里，它的所有工作都在这里一轮一轮地做。用户因此看得到它在做的一切，插话、停止都作用于它正在做的事；它自己也记得替谁做过什么；同一个 Agent 不会有两个会话同时改同一批文件。不存在第二条会话：客户端的 `session/new` 得到的就是这一条，`xsb chat --new` 只是先清空它的上下文。
- 会话容量按用量、估算和窗口保守判断，最终合并输入也受总预算约束。跨轮更新释放旧进程，保留模型选项与增量交接；明确的容量拒绝且未观察到执行时可以在同一业务任务中有限恢复，不提前传播为任务失败。执行状态不明时禁止重放，提示核实。对话 id 保持不变，恢复、交接和执行证据持久化，旧桥接与迟到回执不能作用于新绑定。
- 已完整给过的同版资产只给引用；换版时差异与全文择一。过大的材料以引用或带原文引用的摘录提供，不能把摘录标为已完整见过。记忆采用有限索引和按需查询；更新、重启或原生用量下降后使全文已见标记失效。结果与协作工具返回超出预算时，用接收方的 `read_context` 分页检索完整内容。
- 同一个 Agent 一次只做一件事，不论话题；同事的活排在当前这一轮之后（任务状态 `queued`），要并行就派给不同的 Agent。用户的话不排队，插进正在进行的这一轮。
- 一个会话一次只做一件事。用户输入、同事消息、任务、结果都进同一个队列，依次成为一轮。
- **任务随回合结束（隐式完结）。** 执行方的一轮以 `end_turn` 结束时，它在这个会话里开着的任务就结束，任务交给模型以来的完整经过就是结果（3.1 第 10 条）；有 `produces` 的，交付物是它在任务创建后登记的那种类型的资产。例外是为任务启动、结果要唤醒它的工作（`wake`/`sync` 的子任务、后台任务）、或它的订阅还有没完的：那就等带回结果的那一轮结束。执行方也可以用 `report_result` 提前交、换一个结果交、或说做不了；显式的为准。（这取代了原来"只有 `complete_task` 能结束任务"的设计：任务完结不再依赖模型记得调用工具，漏调不会让任务悬挂。代价是同一轮里的几个任务拿到同一份经过，几件事要分开交时用 `report_result`。）
  - 中枢只管三件事。**核对**：有 `produces` 的任务，回合结束时没有那种类型的资产，就追问执行方（插进下一轮），最多两次，仍没有就以 `error` 结束（QualityGateHook）；`report_result` 时 `assets` 里没有那种类型就不能以完成交出，只能 `failed`；只能交自己登记的资产；已结束的任务不能再交。**投递**：会话正在工作时新任务一律排队，哪怕来自给了它手上工作的那一方；派发方以 `onBusy: "replace"` 显式改派时，先停下它在这个会话里正在做的任务（`superseded`，照常传染、不通知派发方），再做新任务；任务后面附上这个会话还开着的任务清单。**结束**：回合结束时按上面的规则结束任务。
  - 任务状态：`queued`（在会话队列里）→ `running`（模型已拿到：轮次开始或插进了一轮）→ 结束。Hub 重启后，插进一轮却没做完的任务，其邮件会重新投递（至少一次）。
  - 后端出错、一轮失败时，那一轮带来的任务和这个会话开着的任务记为 `failed`（`error`）；回合因模型上限或拒绝而结束时记为 `failed`，结果是它最后说的话。
- 后端请求权限时，Hub 不做任何决定，一律转给人：先给正挂在该会话上的客户端，没有就给任意观察者，都没有就挂起等下一个客户端连上，期间该 Agent 状态显示为 `requires_action`。答不了的客户端（没有终端的脚本、重定向的 `watch`：它们不处理这个请求）被跳过，接着问其余的。只有一种情况 Hub 会代为拒绝：这一轮是某个客户端发起并且还在等它结束（脚本里的 `xsb send`），而此刻连着的客户端没有一个答得了，否则那个脚本会一直挂着。这包括对 xsb 自己协作工具的请求。想无人值守，在后端自己的设置里放开。

## 7. 存储

全部在 `.xsb2/` 下，都是只追加的 JSONL 事件日志，内存状态是对日志的折叠（[state.ts](../packages/hub/src/state.ts)）：

```
.xsb2/
  config.json                       项目设置（机器设置在 ~/.xsb2_global/config.json）
  agents.jsonl                      Agent 及其 workspace
  sessions.jsonl                    会话 ↔ 后端会话
  tasks.jsonl  gates.jsonl          任务、汇合门
  mailbox.jsonl                     收件箱：Agent 间的消息与通知，enqueue / ack
  ledger.jsonl                      台账：每条输入的去向（模型看没看到）
  audit.jsonl                       审计：Kernel 的事件、否决、死信；只写不读
  wal.jsonl                         预写日志
  agents/<id>/instructions.md       这个 Agent 是谁、怎么工作（可手改）
  agents/<id>/memory.jsonl          它的笔记
  agents/<id>/sessions/<sid>.jsonl  会话记录（`session/resume` 带 `replayFrom` 时回放）
  agents/<id>/scratch/              它的草稿和中间文件
  shared/                           Agent 之间交接的零散文件
  assets.jsonl  assets/             资产库：索引与文件
  roles/<角色>/                      项目自己的角色：role.json、instructions.md、skills/（用户编写）。所用预设团队的角色不在这里
  run/                              锁、pid、socket、日志
```

- 单文件的修改就是追加一行；崩溃留下的半行在下次打开时丢弃。
- 跨文件的修改走 WAL（[store.ts](../packages/store/src/store.ts)）：先把整组记录写进 `wal.jsonl` 并落盘，再逐个追加（每条带事务标记），最后写 commit。重启时对没有 commit 的事务补写缺失的记录。例如"任务完成"是一个事务：任务状态、确认原邮件、关门、投递合并结果、释放被它挡住的任务，要么全有要么全无。
- 邮件是**至少一次**投递：一轮结束才 ack。Hub 停止或崩溃时没跑完的任务，重启后会重新执行。插话投递失败时退回为排队的下一轮，不会丢。
- **也可以让它不接着做。** 停止 Hub 的一方可以留下一个标记（`run/abandon`，`stopHub(paths, true)`）：下一次启动的 Hub 看到它，就把没做完的一切放弃再开始（[kernel.ts](../packages/hub/src/kernel.ts) 的 `abandon`），标记随即删除。放弃是一个事务：未确认的邮件全部确认掉，没结束的任务记为 `interrupted`（停止方是用户），还开着的汇合门关掉。不唤醒任何人，因为那本身就是一轮，会把用户不想继续的事又做起来；派发者、承接者和没送达的邮件的发件人各收到一条通知，留在收件箱，随它们下一轮附上。标记是留给下一个 Hub 的，不是对当前这个的请求，所以不管当前这个怎么结束（包括被直接杀掉）都算数。桌面应用在用户确认"仍然退出"时用它（GUI.md）；`xsb hub stop` 不用，仍是下次接着做。
- 一个项目只有一个 Hub，因为 Hub 是这个项目日志的唯一写入者、Agent 进程的持有者、两个 socket 的监听者：两个 Hub 会各写各的日志、把同一封邮件跑两遍、互相抢走 socket。单例由内核保证，不靠文件内容：Hub 在运行期间持有 `run/hub.lock` 上的文件锁（[lock.ts](../packages/hub/src/lock.ts)），进程不管怎么结束（包括被强杀、断电）锁都随之释放，所以没有"残留的锁"要判断，也没有接管的竞争。同时启动的第二个 Hub 拿不到锁，在碰到 socket 和日志之前就退出。`run/hub.json` 只说明持锁的是谁（pid、启动时间），只在锁被持有时才作数：Hub 被强杀后它会留下，里面的 pid 可能已经是别的程序，`xsb hub status` / `stop` 不会把它当成 Hub。Node 没有自己的 `flock`，标准库里够得着的文件锁只有 SQLite 的：对一个空数据库开独占事务（`node:sqlite`），POSIX 上是 fcntl 锁，Windows 上是 LockFileEx。

## 8. 已验证与未验证

`npm test`（三个库各有自己的测试）：

- `@xsb/store`：在事务的每一步模拟崩溃，恢复后全有或全无，恢复可重复执行。
- `@xsb/hub`，Kernel 单测（不起任何进程）：统一收口与通知规则、裁决链否决与 fail-closed、级联与 `cascade.pre_propagate`、唯一投递管线的去向（工具返回、轮次、收件箱）、投递裁决（用户永不排队）、隐式完结与质检追问、台账的推进、观察者的隔离与死信、放弃。
- `@xsb/hub`，端到端（真实 Hub、真实 socket、真实 MCP 桥，后端用脚本化的 mock ACP v2 agent，分立即插入与扣住两种）：派发与结果回传（`wake` 与默认的 `lazy`）、隐式完结、汇合（订阅）及等待期间的用户对话、`after` 依赖、用户的话进入扣住的与立即插入的两种后端；用户插话按三种后端（claude 式、codex 带 `_session/steering`、codex 不带）分别验证：赶上这段工作的进入任务结果的完整经过且不开任务，没赶上的任务结果里没有它、它自成用户的一轮；停止时没进对话的用户插话被保留、下一轮先送、Agent 之间只排队不插话与显式改派（`onBusy: "replace"`）、每个 Agent 只有一条对话（不同话题的同伴工作排队，用户的话插进正在做的那一轮）及上下文过长时在同一条会话里换新的后端会话并交接、话题对口提示与记忆、权限转给人、无系统提示词能力的后端、重启后状态重建 / 历史回放 / 未完成任务重跑；五种后端错误码（含只说 v1 的后端）；取消任务；经 `@xsb/adapter` 封装的三方 agent（对话、工作中来的话被扣住后在同一轮送进、不用工具也能完成任务、被撤销时它的工作被停下并在确认后落账）；能力授予（没有授予时看不到协作工具、用户点名后才有）；角色（说明、MCP server、skill 目录与 `load_skill`）；后台任务（成功、失败、取消、重启后不重跑）；资产库（版本、文件复制、`inputs` 注入、`produces` 的 skill 注入与未交付提示）；任务里等待自己的后台任务（结果回来那一轮结束）；交出（`report_result` 核对交付物、拒绝已结束的任务；没有任务时不可用）；工作中来的任务排在当前工作之后；角色的读写、删除保护、MCP 检查、系统说明预览、重启后新配置生效、删除 Agent 的通知、角色变更的通知、后端清单、资产新版本的通知；语言（项目取第一个声明的语言且之后不变、系统说明里的语言一节、预设团队按语言读取且各语言结构一致、报错带原因与事实并能按语言措辞）；声明了 `dev.xsb/origin` 的客户端在自己的输入成为一轮时收到回显（开始一轮的、插话的），未声明的不收到；用户在智能体工作时说的话插进这一轮、台账里从不排队；带放弃标记的启动不重跑任何东西、没结束的任务记为已中断、派发者在下一轮被告知；任务生命周期（等后台任务时回合结束不算完结、契约不满足时追问两次后失败、用户越过派发者说话时不抄送派发者、一轮失败写入会话记录、同样的订阅只开一个门）；用户停止即停掉该会话的任务、后端扣着的消息以 -32800 丢弃、已插入未处理的记为待处理；上下文边界与交接；`sync` 在调用里拿到结果与超时转为唤醒、`ask`、`inbox`、`broadcast`、用户撤任务、`message_status`、审计记录与否决。
- `@xsb/cli`：真实的后台 Hub，经 ACP v2。按需启动、经桥调用工具（含能力授予）、开关参数解析、退出码、同一项目拒绝第二个 Hub、停止后状态保留。

真实后端（claude-agent-acp 0.107.0，经 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` 环境变量接入）手工跑过一遍：四个 Agent，派发两个任务并汇合等待、等待期间与派发者对话、结果合并送达、Hub 重启后 `session/resume` 恢复上下文、同话题的后续工作仍派给原来的同事、原生插话、`remember` 覆盖写笔记。这些只各跑了一次，没有自动化，而且是在 ACP v1 时代：改为 ACP v2、隐式完结、能力授予之后，没有再用真实后端跑过。本机的 claude-agent-acp 0.107、codex-acp 2.6 只核对了 `initialize` 协商到 v2。

未验证：

- 真实的 claude、codex 后端在 ACP v2 下的完整流程（插入回执、扣住、-32800、`tools/list_changed` 后是否重新拉取工具列表）没有跑过；codex 是否响应工具列表变化尤其未知（调用时仍会校验，越权调用会被拒绝）。
- 话题与另一位同事不符时的提示：真实模型一直选对了人，提示只在 mock 测试里触发过。
- 角色、后台任务、资产库只用 mock 后端和 mock 生成服务验证过。真实模型是否会按说明使用 `start_job`、`inputs`、`produces`，是否会在该用时调用 `load_skill`，是否会照系统说明里 "The team" 一节派发，没有验证。
- 没有接过真实的生成服务（图像、视频）。
- 电影团队改过流程（选角、分镜画面、动态分镜、试拍、三轮审剪辑、五处用户确认），新流程只核对了契约能被读取、各语言一致，没有用真实模型从头跑过一部片子。
- 工作语言只验证了写进系统说明；真实模型是否始终用它写交付物，没有验证。
- `@xsb/adapter` 只用测试里的玩具 agent 验证过，没有接过真实的三方 agent；它目前不支持权限请求。

## 9. 已知取舍

- Hub 对后端不提供 `fs/*` 和 `terminal/*`，Agent 用自己的文件和命令工具。
- 项目的工作语言定下后不随客户端变化；换语言要手改 `.xsb2/config.json`，并重启 Agent 才对已有会话生效。用户直接写的角色和说明不翻译，写的是什么语言就是什么语言。
- CLI 的语言取自终端的环境变量，可能与系统语言不同（不少终端固定为 `en_US.UTF-8`）。
- Agent 默认都在项目目录（`.xsb2/` 的父目录）里工作，能直接用用户放在项目里的材料，也互相看得见对方的改动；同一目录里还有谁，写在各自的系统说明里。草稿和中间文件放在自己的 `agents/<id>/scratch/`，记忆、会话记录和资产由 Hub 经工具写进 `.xsb2/`，与工作目录无关。对外 `session/new` 的 `cwd` 不改变 Agent 的工作目录。
- Hub 面向本机单用户：能连上 socket 的客户端可以操作任何会话。
- 后端扣住的消息（codex）要等它当前的工作结束才进入；用户的话也一样，只是排在扣着的其余消息之前。
- 工具隔离只到 xsb 这一层：角色决定给哪些 MCP server，但后端自带的 shell / 文件工具和用户级配置（如 `~/.claude` 里登记的 MCP）对同后端的所有 Agent 都生效。要真正隔离，生成能力必须只能经角色的 MCP server 到达。
- Agent 之间只传文本。图像、视频以资产路径传递，能不能"看"取决于后端模型和它自己的读文件工具。
- 资产库没有删除和垃圾回收，每个版本都保留；视频会占空间。
- 角色的 `description`、`backend` 在新建 Agent 时复制，之后改 `role.json` 不影响已有 Agent；其余内容随改随生效。
- `mailbox.jsonl`、`tasks.jsonl` 不压缩：话题账本靠重放全部邮件重建，所以日志只增不减。笔记日志会在加载时压缩。
- 删除 Agent 不删除它的目录和会话记录；同名重建会接上原来的主会话。
- `role.json` 里 MCP server 的 `env`（含密钥）是明文，`roles/get` 也原样返回；掩码显示是客户端的事。
