# @xsb/protocol

xsb 的线上层：两个进程之间说的每一句话都在这里定义，别处不重复。没有行为，不依赖其他库。

| 文件 | 内容 |
| - | - |
| [src/jsonrpc.ts](src/jsonrpc.ts) | 按行分隔的 JSON-RPC 2.0：`Connection`、`RpcError`。ACP（对外、对后端）和 MCP（协作工具）都跑在它上面 |
| [src/acp.ts](src/acp.ts) | 系统读写到的那部分 ACP v2 类型（插入回执、`state_update`、v2 的权限请求与 MCP server），以及 `text()` / `textOf()`。类型故意宽松：不认识的字段原样透传 |
| [src/ext.ts](src/ext.ts) | 通用 ACP 扩展：`Agents`（多 Agent）、`Tasks`（任务观察与停止）、`Ledger`（台账）、`SessionControls`（会话模型配置与实际上下文用量）、`OriginExt`（消息来源），以及跨扩展传输的数据形状 `AgentInfo`、`Task`（含发起方、结束归因、投递档位、授予）。插话是 ACP v2 本身的，不再是扩展 |
| [src/errors.ts](src/errors.ts) | 给人看的报错：`error.data.reason` 与事实、每种语言的措辞（`explain`），以及后端错误的 `error.code` 与 CLI 退出码 |

## 使用

```ts
import { Connection, RpcError, PROTOCOL_VERSION, Agents, text } from "@xsb/protocol";
import type { AgentInfo, Task } from "@xsb/protocol";

// 任何一对字节流上都能建立连接：socket、子进程的 stdio……
const conn = new Connection(socket, socket, "hub");

// 作为客户端
await conn.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
const { agents } = await conn.request<{ agents: AgentInfo[] }>(Agents.list);
conn.notify("session/cancel", { sessionId });

// 作为服务端
conn.onRequest("session/prompt", async (params, { signal }) => ({ stopReason: "end_turn" }));
conn.onNotification("session/update", ({ sessionId, update }) => {});

await conn.closed; // 对端断开时结束；未完成的请求以 CONNECTION_CLOSED 失败
```

处理函数抛出 `RpcError` 会按其 `code` / `data` 应答，抛出其他错误应答 `-32603`；没有注册的方法应答 `-32601`。通知按到达顺序同步处理，所以 `session/update` 一定先于它后面那条响应被处理。

给人看的报错带原因（线上的 `error.data.reason`）和事实，`explain(e, language)` 按语言把它说出来；判断是哪种错误也用原因，而不是数字：

```ts
import { explain, reasonOf, exitCode } from "@xsb/protocol";

try { ... } catch (e) {
  if (reasonOf(e) === "backend_not_installed") { ... }
  console.error(explain(e, "zh-CN"));
  process.exit(exitCode(e)); // 10–14，其余为 1
}
```

各扩展的线上格式写在 [src/ext.ts](src/ext.ts) 的注释里，设计理由见 [docs/DESIGN.md](../../docs/DESIGN.md) 第 3 节。

## 约定

- 新增一种跨进程的功能时，先在 `ext.ts` 加定义，Hub 的两侧和客户端都从这里引用，保证同一个扩展不会有两种含义。
- 自定义方法以 `_` 开头，自定义数据放 `_meta`，能力在 `initialize` 的 `_meta` 里通告。

[workflow.ts](src/workflow.ts) 定义工作流查询、暂停、恢复、变更通知和 DAG 视图。
