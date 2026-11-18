# @xsb/adapter

给**没有 ACP 入口的 agent** 用的唯一一个封装：实现 `AgentAdapter`，交给 `serveAdapter`，就得到"一条在 stdio 上说 ACP 的命令"。而这正是 xsb 对后端的全部认识。

```
Hub ── Backend ──ACP v2──▶ claude-agent-acp / codex-acp …   官方 ACP agent
                └─ACP──▶ serveAdapter(你的 AgentAdapter) ──▶ 三方 agent   封装的三方 agent
```

两种后端走同一条链路：同一份代码启动、握手、调度、报错，配置里也没有区分它们的字段。差别只在最末端这一个接口的实现里。Hub 不知道、也不需要知道对面是不是封装。

依赖 [@xsb/protocol](../protocol)。

## 使用

1. 实现 `AgentAdapter`（[src/adapter.ts](src/adapter.ts)）并启动：

```ts
#!/usr/bin/env node
// my-agent-acp.ts
import { serveAdapter } from "@xsb/adapter";
import type { AgentAdapter } from "@xsb/adapter";
import { textOf } from "@xsb/protocol";

const adapter: AgentAdapter = {
  info: { name: "my-agent", version: "1.0.0" },
  capabilities: { resume: false, systemPrompt: true, steering: false },

  async newSession({ cwd, mcpServers, systemPrompt }) {
    // 在三方 agent 里开一个对话；mcpServers 里有 xsb 的协作工具，要让 agent 能调用到
    return myAgent.open({ cwd, tools: mcpServers, instructions: systemPrompt });
  },

  async prompt(sessionId, prompt, emit) {
    for await (const chunk of myAgent.run(sessionId, textOf(prompt))) {
      emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
    }
    return "end_turn"; // 被 cancel 打断时返回 "cancelled"
  },

  cancel(sessionId) {
    myAgent.abort(sessionId);
  },
};

serveAdapter(adapter); // 默认在 stdin / stdout 上提供 ACP
```

2. 在 `~/.xsb/config.json` 里登记为一个普通后端：

```json
{
  "version": 1,
  "backends": {
    "my-agent": { "command": "node", "args": ["/abs/path/my-agent-acp.ts"] }
  }
}
```

3. 像用任何后端一样用它：

```bash
npx xsb agent add helper --backend my-agent --desc "……"
```

## 接口

| 成员 | 说明 |
| - | - |
| `info` | 名称和版本，出现在 Hub 日志和错误消息里 |
| `capabilities` | `resume` / `systemPrompt` / `steering`：如实声明，不要为了"看起来完整"而声明 |
| `newSession(session)` | 开一个对话，返回它的 id |
| `prompt(sessionId, prompt, emit)` | 跑一轮。过程中的一切通过 `emit` 以 ACP `session/update` 的形式上报，promise 在这一轮结束时完成 |
| `cancel(sessionId)` | 停止正在跑的那一轮，`prompt` 随后以 `"cancelled"` 结束 |
| `resume?(sessionId, session)` | 进程重启后恢复对话。仅当声明了 `resume` |
| `steer?(sessionId, prompt)` | 把消息放进正在跑的那一轮，放进去了就返回 true。仅当声明了 `steering` |

**ACP v2 的生命周期由封装统一实现**：prompt 插入时以 `{ messageId }` 应答并回显 `user_message`；每轮报 `state_update`（`running`，结束时 `idle` 带停止原因，`prompt` 抛出时为 `error`）；工作中来的 prompt，有 `steer` 且放进去了就当即插入，否则扣住，等这一轮结束后作为下一段工作插入；取消时扣着的一律以 -32800 回应。

**缺的能力不用自己补。** 没声明的能力不会通告给 Hub：没有 `systemPrompt`，Hub 把说明文字拼在第一条 prompt 前；没有 `resume`，`session/resume` 报会话不存在，Hub 新开会话并交接对话。

## 目前不包含

- 权限请求：`prompt` 只有 `emit` 一个出口，封装的 agent 没有办法向人提问。需要时再给 `prompt` 加入口。

## 测试

封装的端到端验证在 `@xsb/hub` 的测试里（[third-party-agent.ts](../hub/test/third-party-agent.ts)）：一个不说 ACP 的 agent 经本库接入：对话、工作中来的话被扣住后送进、不用任何工具也能完成任务（隐式完结）、被撤销时工作被停下。

```bash
npm test -w @xsb/hub
```
