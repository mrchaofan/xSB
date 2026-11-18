/**
 * A scriptable ACP agent for tests. It has no model: the prompt is its program.
 *
 *   !say <text>           emit text
 *   !sleep <ms>           wait (a cancel ends the turn here)
 *   !busy <ms>            wait, and finish waiting even if cancelled (a tool call that has to run out)
 *   !call <tool> <json>   call a tool of the "xsb" MCP server and emit its result;
 *                         "$last" in the JSON is the id of the task or job started last,
 *                         "$task" the id of the <xsb-task> it stands in, or else of the one
 *                         the session was given last (left as it is without one: it may be
 *                         meant for the instructions of a task this session dispatches)
 *   !done <result>        complete_task on that task
 *   !echo                 emit the whole prompt, as a prompt without directives is
 *   !await <json>         await_tasks on every task dispatched since the last !await
 *   !perm                 ask the client for permission and emit the outcome
 *   !servers              emit the names of the MCP servers the session was given
 *   !usage <n>            report that the conversation uses n tokens of context
 *
 * A prompt without directives is echoed. Flags: --steering serves
 * `_session/steering` (without it the hub has to steer by interrupting) and
 * reads images, --no-system-prompt, --no-resume (cannot restore a session), --auth-required, --protocol <n>.
 */
import { spawn } from "node:child_process";
import { Connection, RpcError } from "@xsb/protocol";

type Session = {
  id: string;
  mcp?: Connection;
  running: boolean;
  cancelled: boolean;
  lines: string[];
  wake?: () => void;
  taskIds: string[];
  /** The <xsb-task> the session was given last. */
  task?: string;
  /** The prompt of the running turn, as text. */
  prompt: string;
  /** Names of the MCP servers the session was opened with. */
  servers: string[];
};

const conn = new Connection(process.stdin, process.stdout, "mock");
const sessions = new Map<string, Session>();
const flags = process.argv.slice(2);
const steering = flags.includes("--steering");
let counter = 0;

async function open(id: string, mcpServers: any[]): Promise<Session> {
  const session: Session = { id, running: false, cancelled: false, lines: [], taskIds: [], prompt: "", servers: mcpServers.map((s) => s.name) };
  const server = mcpServers.find((s) => s.name === "xsb");
  if (server) {
    const env = Object.fromEntries(server.env.map((e: any) => [e.name, e.value]));
    const proc = spawn(server.command, server.args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
    session.mcp = new Connection(proc.stdout, proc.stdin, "mcp");
    await session.mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mock", version: "0" } });
    session.mcp.notify("notifications/initialized");
  }
  sessions.set(id, session);
  return session;
}

const say = (session: Session, text: string): void =>
  conn.notify("session/update", {
    sessionId: session.id,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });

async function tool(session: Session, name: string, args: unknown): Promise<string> {
  const toolCallId = `call_${++counter}`;
  conn.notify("session/update", {
    sessionId: session.id,
    update: { sessionUpdate: "tool_call", toolCallId, title: name, name: `mcp__xsb__${name}`, status: "in_progress" },
  });
  const result = await session.mcp!.request("tools/call", { name, arguments: args });
  conn.notify("session/update", {
    sessionId: session.id,
    update: { sessionUpdate: "tool_call_update", toolCallId, status: result.isError ? "failed" : "completed" },
  });
  return result.content[0].text;
}

async function step(session: Session, line: string): Promise<void> {
  const [, directive, own, rest = ""] = /^!(\w+)(?:@(t_\w+))?\s*(.*)$/.exec(line) ?? [];
  const task = own ?? session.task ?? "";
  switch (directive) {
    case "say":
      return say(session, rest + "\n");
    case "busy":
      return void (await new Promise((resolve) => setTimeout(resolve, Number(rest))));
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
    case "call": {
      const [, name, json = "{}"] = /^(\w+)\s*(.*)$/.exec(rest)!;
      const out = await tool(session, name, JSON.parse(json.replaceAll("$last", session.taskIds.at(-1) ?? "").replaceAll("$task", task || "$task")));
      const id = /"task_id": "(t_\w+)"/.exec(out)?.[1];
      if ((name === "dispatch_task" || name === "start_job") && id) session.taskIds.push(id);
      return say(session, `result(${name}): ${out}\n`);
    }
    case "done": {
      const out = await tool(session, "complete_task", { task_id: task, result: rest });
      return say(session, `result(complete_task): ${out}\n`);
    }
    case "echo":
      return say(session, `echo: ${session.prompt.replaceAll("\n", " | ")}\n`);
    case "usage":
      conn.notify("session/update", { sessionId: session.id, update: { sessionUpdate: "usage_update", used: Number(rest), size: 1_000_000 } });
      return;
    case "servers":
      return say(session, `servers: ${session.servers.join(", ")}\n`);
    case "await": {
      const out = await tool(session, "await_tasks", { ...JSON.parse(rest || "{}"), task_ids: session.taskIds.splice(0) });
      return say(session, `result(await_tasks): ${out}\n`);
    }
    case "perm": {
      const answer = await conn.request("session/request_permission", {
        sessionId: session.id,
        toolCall: { toolCallId: `call_${++counter}`, title: "Write a file" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      return say(session, `perm: ${answer.outcome.outcome} ${answer.outcome.optionId ?? ""}\n`);
    }
  }
}

const textOf = (prompt: any[]): string => prompt.map((b) => b.text ?? `<${b.type} ${b.mimeType ?? b.uri}>`).join("\n");
/** Take note of the tasks a prompt gives; the directives in a task's instructions are that task's. */
const given = (session: Session, text: string): string =>
  text.replace(/(<xsb-task [^>]*task-id="(t_\w+)"[^>]*>)([\s\S]*?)(<\/xsb-task>)/g, (_, head, id, body, tail) => {
    session.task = id;
    return head + body.replace(/^!(\w+)/gm, `!$1@${id}`) + tail;
  });
const program = (source: string): string[] => {
  const lines = source.split("\n").filter((l) => l.startsWith("!"));
  return lines.length ? lines : [`!say echo: ${source.replaceAll("\n", " | ")}`];
};

conn.onRequest("initialize", () => ({
  protocolVersion: flags.includes("--protocol") ? Number(flags[flags.indexOf("--protocol") + 1]) : 1,
  agentInfo: { name: "mock", version: "0" },
  authMethods: [{ id: "login", name: "Log in with the mock CLI" }],
  agentCapabilities: { promptCapabilities: { image: steering }, sessionCapabilities: { ...(flags.includes("--no-resume") ? {} : { resume: {} }), ...(flags.includes("--no-system-prompt") ? {} : { systemPrompt: {} }) } },
  ...(steering ? { _meta: { steering: { supported: true } } } : {}),
}));
conn.onRequest("session/new", async (p) => ({ sessionId: (await open(`mock_${process.pid}_${++counter}`, p.mcpServers)).id }));
conn.onRequest("session/resume", async (p) => {
  await open(p.sessionId, p.mcpServers);
  return {};
});
conn.onRequest("session/prompt", async (p) => {
  const session = sessions.get(p.sessionId);
  if (!session) throw new RpcError(-32002, "no such session");
  if (flags.includes("--auth-required")) throw new RpcError(-32000, "Authentication required");
  session.running = true;
  session.cancelled = false;
  session.prompt = textOf(p.prompt);
  session.lines = program(given(session, session.prompt));
  session.taskIds = [];
  while (session.lines.length && !session.cancelled) await step(session, session.lines.shift()!);
  session.running = false;
  return { stopReason: session.cancelled ? "cancelled" : "end_turn" };
});
conn.onNotification("session/cancel", (p) => {
  const session = sessions.get(p.sessionId);
  if (!session?.running) return;
  session.cancelled = true;
  session.wake?.();
});
if (steering) {
  conn.onRequest("_session/steering", (p) => {
    const session = sessions.get(p.sessionId);
    if (!session?.running) return { outcome: "promptRequired", reason: "noRunningTurn" };
    // Like a real agent: the steered message is handled next, then the turn goes on.
    session.lines.unshift(...program(given(session, textOf(p.prompt))));
    return { outcome: "injected" };
  });
}
