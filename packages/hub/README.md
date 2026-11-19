# @xsb/hub

Hub 守护进程：一个项目唯一的常驻进程，系统的全部行为都在这里。对外它是一个标准 ACP agent，对内它是每个后端的标准 ACP client；Agent loop 由后端自己跑，Hub 不实现。设计见 [docs/DESIGN.md](../../docs/DESIGN.md)。

依赖 [@xsb/protocol](../protocol)（线上定义）和 [@xsb/store](../store)（持久化），不依赖 CLI。没有 ACP 入口的 agent 经 [@xsb/adapter](../adapter) 接入，Hub 对此无感。

## 入口

| 命令 | 用途 |
| - | - |
| `xsb-hub <项目目录>` | 在前台运行该项目的 Hub，直到收到 SIGTERM / SIGINT。通常不用手动执行：客户端按需在后台启动它 |
| `xsb-mcp-bridge` | 后端用来访问协作工具的 stdio MCP server。只由 Hub 写进后端会话的 `mcpServers`，不能手动执行 |

Hub 启动后监听两个 Unix socket（`.xsb/run/acp.sock`、`.xsb/run/mcp.sock`；项目路径太深时落在临时目录），运行期间持有 `.xsb/run/hub.lock` 上的文件锁（一个项目只有一个 Hub），进程信息在 `.xsb/run/hub.json`，日志在 `.xsb/run/hub.log`。

## 与 Hub 交互

运行中的 Hub 只有一个入口：在 `acp.sock` 上说 ACP。这个库导出的是"找到、启动、配置一个 Hub"所需的东西，不是第二条通道。

```ts
import { Paths, findProject, hubSocket } from "@xsb/hub";
import { Agents, Connection, PROTOCOL_VERSION } from "@xsb/protocol";

const paths = new Paths(findProject()!);         // 向上找到含 .xsb/ 的目录
const socket = await hubSocket(paths);           // 连到这个项目的 Hub；没有在运行就先在后台启动
const conn = new Connection(socket, socket, "hub");
await conn.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
const { sessionId } = await conn.request("session/new", {
  cwd: process.cwd(),
  mcpServers: [],
  _meta: { [Agents.sessionKey]: "director" },    // 不带则连到默认 Agent
});
```

带重试的完整版本见 `@xsb/cli` 的 [client.ts](../cli/src/client.ts)。在进程内直接运行（测试用）：

```ts
import { Hub } from "@xsb/hub";

const hub = new Hub(projectDir);
await hub.start();
// ...
await hub.shutdown();
```

## 模块

| 模块 | 拥有 |
| - | - |
| [hub.ts](src/hub.ts) | 组合根：Agent、会话、已连接客户端的登记，socket 的生命周期 |
| [acp-server.ts](src/acp-server.ts) | 对外的 ACP agent：标准的 `session/*`，加上插话、多 Agent、任务（含用户撤任务）等扩展 |
| [session.ts](src/session.ts) | 一个会话的回合引擎：一个队列、一次一轮；与后端会话的绑定和恢复。对所有后端一视同仁 |
| [backend.ts](src/backend.ts) | 一个后端进程，链路的末端，后端之间唯一有差别的地方：启动、握手、读取能力，并在这里补齐缺的能力（没有原生插话时，用户的话"取消再续接"，其余的扣住到 prompt 返回再续接），对上只提供统一的 `prompt` / `steer` / `cancel`。没有按厂商的分支 |
| [backends.ts](src/backends.ts) | 进程池：每个 Agent 至多一个进程，首次需要时启动 |
| [kernel.ts](src/kernel.ts) | 任务调度框架（Kernel），与后端无关：任务的开始与统一收口的结束、任务图上的撤销与传染、汇合、收件箱、通知、台账、内置策略（投递裁决、通知投递）。不引用 ACP、会话、客户端，可单独测试（test/kernel.test.ts） |
| [hooks.ts](src/hooks.ts) | Hook 引擎：裁决链（可改写、可否决、异常即否决）与观察者（异步扇出、失败隔离、重试、死信） |
| [task-graph.ts](src/task-graph.ts) | 任务图上的纯算法：支撑者、撤销集、放行（docs/TASK-GRAPH.md） |
| [ledger.ts](src/ledger.ts) | LedgerHook：由 ACP v2 的插入回执与工作状态推进每条消息的台账状态 |
| [audit.ts](src/audit.ts) | AuditHook：事件、否决、死信写进 `audit.jsonl` |
| [delivery.ts](src/delivery.ts) | Effector：把 Kernel 的投递决定落到会话上（新一轮、插话、工具返回、收件箱摘要），用户输入的裁决，停掉只为已撤工作而跑的一轮 |
| [jobs.ts](src/jobs.ts) | Effector：后台任务（执行者是工具的任务）的排队与调用 |
| [roles.ts](src/roles.ts) | 角色：`.xsb/roles/<角色>/` 下的说明、MCP 配置、skills。每次使用时读取 |
| [assets.ts](src/assets.ts) | 资产库：有 id 和版本的文件，团队一致性的唯一事实来源 |
| [mcp-client.ts](src/mcp-client.ts) | 调用一次 stdio MCP server 的一个工具，后台任务（job）用 |
| [permissions.ts](src/permissions.ts) | 后端的权限请求一律转给人：会话上的客户端 → 任意观察者 → 挂起等待 |
| [tools.ts](src/tools.ts) | 协作工具面向模型的一侧：参数校验和回答的措辞 |
| [mcp.ts](src/mcp.ts) / [mcp-bridge.ts](src/mcp-bridge.ts) | 工具的 MCP server / 桥接进程。身份来自每个会话的 token |
| [prompts.ts](src/prompts.ts) | Hub 对模型说的所有文字：系统说明、邮件在 prompt 里的包装 |
| [state.ts](src/state.ts) | 内存状态 = 对事件日志的折叠；`apply` 是唯一修改状态的代码 |
| [daemon.ts](src/daemon.ts) | 后台进程：独占项目（持有 `hub.lock` 的文件锁，见 lock.ts）、启动、停止 |
| [config.ts](src/config.ts) / [paths.ts](src/paths.ts) | 两个配置文件 / `.xsb/` 的布局 |

## 配置

| 文件 | 字段 | 含义 |
| - | - | - |
| `~/.xsb/config.json`（可用环境变量 `XSB_HOME` 改目录） | `backends.<名称>.command` / `.args` | 这台机器上的后端：一条在 stdio 上说 ACP 的命令。与内置的 claude / codex 按名称合并；必须说 ACP v2 |
| `<项目>/.xsb/config.json` | `defaultAgent` | 客户端不指定时连到哪个 Agent；不写则是第一个 |

两个文件都在每次使用时读取，修改后不必重启 Hub。新增一个后端：

```json
{
  "version": 1,
  "backends": {
    "my-agent": { "command": "my-agent", "args": ["--acp"] }
  }
}
```

### 角色

角色是用户写的目录，Agent 用 `xsb agent add <id> --role <角色>` 成为它的实例：

```
.xsb/roles/cinematographer/
  role.json
  instructions.md
  skills/shot/SKILL.md
```

```json
{
  "description": "把镜头表变成画面",
  "backend": "claude",
  "mcpServers": {
    "video": { "command": "node", "args": ["/abs/path/video-mcp.js"], "env": { "VIDEO_API_KEY": "..." } }
  }
}
```

- `mcpServers` 与 `.mcp.json` 同格式，经 ACP 标准字段传给后端；Agent 还能用 `start_job` 让 Hub 在后台调用其中的慢工具。
- `skills/<名称>/SKILL.md`：front matter 里写了 `produces: <资产类型>` 的 skill 会随"要产出该类型"的任务自动送达；所有 skill 都列在系统说明里，模型可以用 `load_skill` 读取。front matter 还可以带 `description:`，否则取正文第一行作为说明。
- 声明了 `produces` 的 skill 是一条产出契约，`inputs: <类型>, <类型>` 写它依据哪些资产。所有 Agent 的契约合起来就是团队：每个 Agent 的系统说明里列出"哪种资产、谁产出、依据什么"，`list_agents` 返回各自能产出的类型，`dispatch_task` 在对方没有这条契约或缺少输入时提示。
- `description`、`backend` 只是新建 Agent 时的默认值；其余内容每次使用时读取，改了不必重启 Hub。已经绑定后端的会话要等下次绑定才看到新的说明和工具，`xsb agent restart <id>` 可以立即应用。
- xsb 自带几支预设团队（[presets/](presets)，每支团队一个目录，中英版本放在团队目录内，按项目的工作语言读取）。`xsb team use <团队>` 之后它的角色就是项目的角色，首次复制到 `.xsb/templates/<团队>/`，不会自动更新；`xsb team sync <团队>` 在确认覆盖自定义改动后更新副本；`xsb role add` 改过的才是项目自己的，`xsb role remove` 删掉自己的版本就恢复成预设。
- 角色也可以经 ACP 扩展 `dev.xsb/roles` 读写（`list | get | put | remove | check`），`xsb role ...` 和图形界面走的都是它。

Hub 只启动后端：不安装、不保存凭据、不决定权限模式。后端进程继承启动 Hub 时的环境变量。

## 测试

```bash
npm test -w @xsb/hub
```

端到端：真实的 Hub、socket 和 MCP 桥。后端有两种，走同一条链路：

- [test/mock-agent.ts](test/mock-agent.ts)：自己说 ACP 的脚本化 agent（prompt 即程序：`!say`、`!call <工具> <json>`、`!await`、`!perm`、`!sleep`）。
- [test/third-party-agent.ts](test/third-party-agent.ts)：不说 ACP 的 agent，经 [@xsb/adapter](../adapter) 封装。

[test/mock-generator.ts](test/mock-generator.ts) 是一个 stdio MCP server，充当慢的生成服务。

Node 22.18 的 SQLite 文件锁会打印实验性功能警告。SQLite 只在实际获取或检查已有锁时加载，普通命令不会因导入 Hub 而打印它；保留 Node >=22.18 的兼容性，锁操作的提示不影响功能。

真实模型的跨轮检查是显式选择运行的：先构建桌面端，再执行 `XSB_LIVE_BACKEND=codex node packages/hub/test/live-smoke.ts`（也可用 `claude`）。它在临时项目里使用软件团队的开发者角色和一个只延迟、不会生成媒体的本地测试工具，核对 `start_job`、`await_tasks` 和结果到达后的收尾；会调用所选真实模型，不属于自动测试。
