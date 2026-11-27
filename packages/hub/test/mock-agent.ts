/**
 * A scriptable ACP v2 agent for tests. It has no model: the prompt is its program.
 *
 *   !say <text>           emit text (one agent message, until the next tool call)
 *   !sleep <ms>           wait (a cancel ends the work here)
 *   !waitForInput         wait at this step until a prompt is queued or work is cancelled
 *   !busy <ms>            wait, and finish waiting even if cancelled (a tool call that has to run out)
 *   !background <delay> <ms> schedule native background notification work after this execution
 *   !call <tool> <json>   call a tool of the "workflow" MCP server and emit its result;
 *                         "$last" in the JSON is the id of the task or job started last,
 *                         "$task" the id of the <xsb-task> it stands in, or else of the one
 *                         the session was given last (left as it is without one: it may be
 *                         meant for the instructions of a task this session dispatches)
 *   !plugin <tool> <json> call a real additional stdio MCP server selected with --plugin <name>
 *   !done <result>        report_result on that task
 *   !echo                 emit the whole prompt, as a prompt without directives is
 *   !await <json>         subscribe to every task dispatched since the last !await
 *   !perm                 ask the client for permission and emit the outcome
 *   !servers              emit the names of the MCP servers the session was given
 *   !tools                emit the names of the team's tools the session has now
 *   !usage <n>            report that the conversation uses n tokens of context
 *   !images               emit image data retained in this backend conversation
 *
 * A prompt without directives is echoed. As ACP v2 has it, a prompt is answered with its message id once it is
 * inserted; work is reported with `state_update`. Each directive is a step, as a tool call is for a model.
 *
 * A prompt that comes while the agent works is held until the work is done, and then run (as codex-acp does). With
 * --steering it is inserted before the work's next step and its directives run next, in the same work; when the work
 * has no step left, it becomes the next work. Both behaviors use standard session/prompt.
 * The official Claude/Codex wrappers prioritize ordinary input; generic v2 agents may hold it.
 * Flags: --steering (and reads images), --no-system-prompt, --no-resume (cannot restore a session),
 * --auth-required, --protocol <n>.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { Connection, RpcError, TurnIsolation } from "@xsb/protocol";

type Held = { prompt: any[]; resolve: (r: { messageId: string }) => void; reject: (e: unknown) => void };

type Session = {
  id: string;
  mcp?: Connection;
  plugin?: Connection;
  running: boolean;
  cancelled: boolean;
  lines: string[];
  wake?: () => void;
  onInput?: () => void;
  taskIds: string[];
  /** The <xsb-task> the session was given last. */
  task?: string;
  /** The prompt of the running work, as text. */
  prompt: string;
  /** Standing instructions supplied on session/new or session/resume. */
  instructions?: string;
  /** Names of the MCP servers the session was opened with. */
  servers: string[];
  /** Prompts held while it works. */
  held: Held[];
  images: string[];
  /** The agent message being written, until a tool call. */
  message?: string;
  model?: string;
  effort?: string;
};

const conn = new Connection(process.stdin, process.stdout, "mock");
const sessions = new Map<string, Session>();
const flags = process.argv.slice(2);
const steering = flags.includes("--steering");
const plugin = flags.includes("--plugin") ? flags[flags.indexOf("--plugin") + 1] : undefined;
let counter = 0;
let formElicitation = false;
let rejectedContext = false;

async function open(id: string, mcpServers: any[]): Promise<Session> {
  const session: Session = { id, running: false, cancelled: false, lines: [], taskIds: [], prompt: "", servers: mcpServers.map((s) => s.name), held: [], images: [] };
  for (const server of mcpServers.filter((s) => s.name === "workflow" || s.name === plugin)) {
    const env = Object.fromEntries(server.env.map((e: any) => [e.name, e.value]));
    const proc = spawn(server.command, server.args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
    const bridge = new Connection(proc.stdout, proc.stdin, "mcp");
    if (server.name === plugin) session.plugin = bridge;
    else session.mcp = bridge;
    await bridge.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mock", version: "0" } });
    bridge.notify("notifications/initialized");
  }
  sessions.set(id, session);
  return session;
}

const update = (session: Session, u: unknown): void => conn.notify("session/update", { sessionId: session.id, update: u });

const say = (session: Session, text: string): void => {
  session.message ??= `msg_${++counter}`;
  update(session, { sessionUpdate: "agent_message_chunk", messageId: session.message, content: { type: "text", text } });
};

async function tool(session: Session, name: string, args: unknown, pluginTool = false): Promise<string> {
  const toolCallId = `call_${++counter}`;
  session.message = undefined;
  update(session, { sessionUpdate: "tool_call_update", toolCallId, title: name, name: `mcp__${pluginTool ? plugin : "workflow"}__${name}`, status: "in_progress" });
  const server = pluginTool ? session.plugin : session.mcp;
  const result = await server!.request("tools/call", { name, arguments: args });
  update(session, { sessionUpdate: "tool_call_update", toolCallId, status: result.isError ? "failed" : "completed" });
  return result.content[0].text;
}

async function step(session: Session, line: string): Promise<void> {
  const [, directive, own, rest = ""] = /^!(\w+)(?:@(t_\w+))?\s*(.*)$/.exec(line) ?? [];
  const task = own ?? session.task ?? "";
  switch (directive) {
    case "say":
      return say(session, rest + "\n");
    case "title":
      return update(session, { sessionUpdate: "session_info_update", title: rest });
    case "titlelater": {
      const [delay, ...words] = rest.split(" ");
      setTimeout(() => update(session, { sessionUpdate: "session_info_update", title: words.join(" ") }), Number(delay));
      return;
    }
    case "busy":
      return void (await new Promise((resolve) => setTimeout(resolve, Number(rest))));
    case "waitForInput":
      if (!session.held.length) await new Promise<void>(resolve => { session.onInput = resolve; });
      session.onInput = undefined;
      return;
    case "background": {
      const [delay, duration] = rest.split(" ").map(Number);
      setTimeout(() => {
        session.lines = ["!say BACKGROUND START", `!sleep ${duration}`, "!say BACKGROUND END"];
        void work(session, { kind: "task-notification" });
      }, delay);
      return;
    }
    case "sleep":
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Number(rest));
        session.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      session.wake = undefined;
      return;
    case "plugin":
    case "call": {
      const [, name, json = "{}"] = /^(\w+)\s*(.*)$/.exec(rest)!;
      const out = await tool(session, name, JSON.parse(json.replaceAll("$last", session.taskIds.at(-1) ?? "").replaceAll("$task", task || "$task")), directive === "plugin");
      const id = /"task_id": "(t_\w+)"/.exec(out)?.[1];
      if ((name === "dispatch_task" || name === "start_job") && id) session.taskIds.push(id);
      return say(session, `result(${name}): ${out}\n`);
    }
    case "done": {
      const out = await tool(session, "report_result", { task_id: task, result: rest });
      return say(session, `result(report_result): ${out}\n`);
    }
    case "echo":
      return say(session, `echo: ${session.prompt.replaceAll("\n", " | ")}\n`);
    case "consultation":
      return say(session, "consultation: " + (session.instructions?.match(/Current preference: (enabled|disabled)|当前偏好：[开启关闭]+/)?.[0] ?? "No system preference"));
    case "instructions":
      return say(session, `instructions: ${session.instructions}\n`);
    case "usage":
      return update(session, { sessionUpdate: "usage_update", used: Number(rest), size: 1_000_000 });
    case "model":
      return say(session, `model: ${session.model ?? "default"}\n`);
    case "images":
      return say(session, `images: ${JSON.stringify(session.images)}\n`);
    case "servers":
      return say(session, `servers: ${session.servers.join(", ")}\n`);
    case "tools": {
      const { tools } = await session.mcp!.request("tools/list", {});
      return say(session, `tools: ${tools.map((t: any) => t.name).join(", ")}\n`);
    }
    case "await": {
      const out = await tool(session, "subscribe", { ...JSON.parse(rest || "{}"), task_ids: session.taskIds.splice(0) });
      return say(session, `result(subscribe): ${out}\n`);
    }
    case "perm": {
      const toolCallId = `call_${++counter}`;
      const answer = await conn.request("session/request_permission", {
        sessionId: session.id,
        title: "Write a file",
        subject: { type: "tool_call", toolCall: { toolCallId, title: "Write a file" } },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      return say(session, `perm: ${answer.outcome.outcome} ${answer.outcome.optionId ?? ""}\n`);
    }
    case "elicitAsync": {
      if (!formElicitation) return say(session, "native forms disabled\n");
      const form = JSON.parse(rest);
      const params = { ...form, mode: "form", sessionId: session.id, _meta: { ...form._meta, codex: { delivery: "async" } } };
      void conn.request("elicitation/create", params).then(answer => {
        if (answer.action !== "accept") return;
        const text = `native answer: ${JSON.stringify(answer)}`;
        if (session.running) say(session, text + "\n");
        else { session.lines = ["!say " + text]; void work(session); }
      }, () => {});
      return;
    }
    case "elicit": {
      if (!formElicitation) return say(session, "native forms disabled\n");
      update(session, { sessionUpdate: "state_update", state: "requires_action" });
      const answer = await conn.request("elicitation/create", { ...JSON.parse(rest), mode: "form", sessionId: session.id });
      if (!session.cancelled) update(session, { sessionUpdate: "state_update", state: "running" });
      return say(session, `native answer: ${JSON.stringify(answer)}\n`);
    }
  }
}

const textOf = (prompt: any[]): string => prompt.map((b) => b.text ?? `<${b.type} ${b.mimeType ?? b.uri}>`).join("\n");
/**
 * Take note of the tasks a prompt gives; the directives in a task's instructions are that task's. What a result
 * quotes (a peer may repeat the task it was given) is not given to this session.
 */
const given = (session: Session, text: string): string =>
  text
    .split(/(<xsb-task-results?[\s\S]*?<\/xsb-task-results?>)/)
    .map((part) =>
      part.startsWith("<xsb-task-result")
        ? part
        : part.replace(/(<xsb-task [^>]*task-id="(t_\w+)"[^>]*>)([\s\S]*?)(<\/xsb-task>)/g, (_, head, id, body, tail) => {
            session.task = id;
            return head + body.replace(/^!(\w+)/gm, `!$1@${id}`) + tail;
          }),
    )
    .join("");
const program = (source: string): string[] => {
  const lines = source.split("\n").filter((l) => l.startsWith("!"));
  return lines.length ? lines : [`!say echo: ${source.replaceAll("\n", " | ")}`];
};

/** Insert input into the conversation: it is echoed, answered (a prompt), and its program is what the work does next. */
function insert(session: Session, prompt: any[], answer?: (r: { messageId: string }) => void): void {
  session.images.push(...prompt.filter((b) => b.type === "image").map((b) => b.data));
  const messageId = `user_${++counter}`;
  update(session, { sessionUpdate: "user_message", messageId, content: prompt });
  answer?.({ messageId });
  const text = textOf(prompt);
  session.prompt = session.running ? `${session.prompt}\n${text}` : text;
  session.lines.unshift(...program(given(session, text)));
}

/** Work until there is nothing left, then take what was held: each held prompt is the next work. */
async function work(session: Session, origin?: unknown): Promise<void> {
  session.running = true;
  session.cancelled = false;
  session.taskIds = [];
  update(session, { sessionUpdate: "state_update", state: "running" });
  while (session.lines.length && !session.cancelled) {
    await step(session, session.lines.shift()!);
    // Between two steps, what came meanwhile goes in, and runs next.
    if (!session.lines.length || session.cancelled) break;
    if (steering) for (const held of session.held.splice(0)) insert(session, held.prompt, held.resolve);
  }
  session.lines = [];
  session.running = false;
  session.message = undefined;
  update(session, { sessionUpdate: "state_update", state: "idle", stopReason: session.cancelled ? "cancelled" : "end_turn", ...(origin ? { _meta: { "_claude/origin": origin } } : {}) });
  const next = session.held.shift();
  if (next) {
    insert(session, next.prompt, next.resolve);
    void work(session);
  }
}

conn.onRequest("initialize", (p) => {
  formElicitation = p.capabilities?.elicitation?.form != null;
  return ({
  protocolVersion: flags.includes("--protocol") ? Number(flags[flags.indexOf("--protocol") + 1]) : Math.min(2, p.protocolVersion),
  info: { name: "mock", version: "0" },
  authMethods: [{ methodId: "login", name: "Log in with the mock CLI", type: "agent" }],
  capabilities: {
    session: {
      prompt: steering ? { image: {} } : {},
      ...(flags.includes("--no-system-prompt") ? {} : { systemPrompt: {} }),
    },
  },
  _meta: { ...(flags.includes("--no-turn-isolation") ? {} : { [TurnIsolation.key]: { version: TurnIsolation.version, afterIdle: true } }), ...(flags.includes("--legacy-steering-advertisement") ? { steering: { supported: true } } : {}) },
});
});
function config(session: Session) {
  const values = (values: string[]) => values.map(value => ({ value, name: value }));
  const model = session.model ?? "default";
  return { configOptions: [
    { configId: "model", category: "model", type: "select", name: "Model", currentValue: model, options: values([...new Set(["default", "studio", model])]) },
    { configId: "effort", category: "thought_level", type: "select", name: "Reasoning", currentValue: session.effort ?? "medium", options: values(["low", "medium", "high"]) },
  ] };
}
conn.onRequest("session/new", async (p) => {
  const session = await open("mock_" + process.pid + "_" + ++counter, p.mcpServers);
  session.instructions = JSON.stringify(p.systemPrompt);
  return { sessionId: session.id, ...config(session) };
});
conn.onRequest("session/set_config_option", (p) => {
  const session = sessions.get(p.sessionId);
  if (!session) throw RpcError.notFound("session");
  if (p.type !== "id") throw RpcError.invalidParams("ACP v2 select requires type=id");
  if (p.configId === "model") session.model = p.value;
  else if (p.configId === "effort" && ["low", "medium", "high"].includes(p.value)) session.effort = p.value;
  else throw RpcError.invalidParams("unknown config");
  return config(session);
});
conn.onRequest("session/resume", async (p) => {
  if (flags.includes("--no-resume")) throw new RpcError(-32002, "no such session");
  const session = await open(p.sessionId, p.mcpServers);
  session.instructions = JSON.stringify(p.systemPrompt);
  update(sessions.get(p.sessionId)!, { sessionUpdate: "state_update", state: "idle" });
  return config(sessions.get(p.sessionId)!);
});
conn.onRequest("session/prompt", (p) => {
  const session = sessions.get(p.sessionId);
  if (!session) throw new RpcError(-32002, "no such session");
  if (flags.includes("--auth-required")) throw new RpcError(-32000, "Authentication required");
  const refusalMarker = flags.includes("--context-refusal-file") ? flags[flags.indexOf("--context-refusal-file") + 1] : undefined;
  if (flags.includes("--context-refusal") && !rejectedContext && (!refusalMarker || !fs.existsSync(refusalMarker))) {
    rejectedContext = true;
    if (refusalMarker) fs.writeFileSync(refusalMarker, "refused");
    throw new RpcError(-32603, "Internal error: Prompt is too long", { errorKind: "invalid_request" });
  }
  if (flags.includes("--context-refusal-always")) throw new RpcError(-32603, "Internal error: Prompt is too long");
  return new Promise((resolve, reject) => {
    if (!session.running) {
      insert(session, p.prompt, resolve);
      void work(session);
    } else {
      // Standard prompt: priority mode takes it at the next safe step; generic queued mode waits.
      session.held.push({ prompt: p.prompt, resolve, reject });
      session.onInput?.();
    }
  });
});
conn.onNotification("session/cancel", (p) => {
  const session = sessions.get(p.sessionId);
  if (!session) return;
  for (const held of session.held.splice(0)) held.reject(RpcError.cancelled());
  if (!session.running) return;
  session.cancelled = true;
  session.wake?.();
  session.onInput?.();
});
