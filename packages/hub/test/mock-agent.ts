/**
 * A scriptable ACP v2 agent for tests. It has no model: the prompt is its program.
 *
 *   !say <text>           emit text (one agent message, until the next tool call)
 *   !sleep <ms>           wait (a cancel ends the work here)
 *   !busy <ms>            wait, and finish waiting even if cancelled (a tool call that has to run out)
 *   !call <tool> <json>   call a tool of the "team" MCP server and emit its result;
 *                         "$last" in the JSON is the id of the task or job started last,
 *                         "$task" the id of the <xsb-task> it stands in, or else of the one
 *                         the session was given last (left as it is without one: it may be
 *                         meant for the instructions of a task this session dispatches)
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
 * has no step left, it is the next work (as claude-agent-acp does). With --steer-ext the agent also takes
 * `_session/steering` (as codex-acp does): into running work, it answers "injected" and inserts the input before the
 * next step, showing it with a message id of its own; input the work ends without is dropped, silently; with no work
 * running, it answers "promptRequired". A cancel answers what is held with -32800 and drops what was steered.
 * Flags: --steering (and reads images), --steer-ext, --no-system-prompt, --no-resume (cannot restore a session),
 * --auth-required, --protocol <n>.
 */
import { spawn } from "node:child_process";
import { Connection, RpcError } from "@xsb/protocol";

type Held = { prompt: any[]; resolve: (r: { messageId: string }) => void; reject: (e: unknown) => void };

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
  /** The prompt of the running work, as text. */
  prompt: string;
  /** Names of the MCP servers the session was opened with. */
  servers: string[];
  /** Prompts held while it works. */
  held: Held[];
  /** Input given with `_session/steering`, to insert before the next step. */
  steered: any[][];
  images: string[];
  /** The agent message being written, until a tool call. */
  message?: string;
};

const conn = new Connection(process.stdin, process.stdout, "mock");
const sessions = new Map<string, Session>();
const flags = process.argv.slice(2);
const steering = flags.includes("--steering");
const steerExt = flags.includes("--steer-ext");
let counter = 0;

async function open(id: string, mcpServers: any[]): Promise<Session> {
  const session: Session = { id, running: false, cancelled: false, lines: [], taskIds: [], prompt: "", servers: mcpServers.map((s) => s.name), held: [], steered: [], images: [] };
  const server = mcpServers.find((s) => s.name === "team");
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

const update = (session: Session, u: unknown): void => conn.notify("session/update", { sessionId: session.id, update: u });

const say = (session: Session, text: string): void => {
  session.message ??= `msg_${++counter}`;
  update(session, { sessionUpdate: "agent_message_chunk", messageId: session.message, content: { type: "text", text } });
};

async function tool(session: Session, name: string, args: unknown): Promise<string> {
  const toolCallId = `call_${++counter}`;
  session.message = undefined;
  update(session, { sessionUpdate: "tool_call_update", toolCallId, title: name, name: `mcp__team__${name}`, status: "in_progress" });
  const result = await session.mcp!.request("tools/call", { name, arguments: args });
  update(session, { sessionUpdate: "tool_call_update", toolCallId, status: result.isError ? "failed" : "completed" });
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
      const out = await tool(session, "report_result", { task_id: task, result: rest });
      return say(session, `result(report_result): ${out}\n`);
    }
    case "echo":
      return say(session, `echo: ${session.prompt.replaceAll("\n", " | ")}\n`);
    case "usage":
      return update(session, { sessionUpdate: "usage_update", used: Number(rest), size: 1_000_000 });
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
async function work(session: Session): Promise<void> {
  session.running = true;
  session.cancelled = false;
  session.taskIds = [];
  update(session, { sessionUpdate: "state_update", state: "running" });
  while (session.lines.length && !session.cancelled) {
    await step(session, session.lines.shift()!);
    // Between two steps, what came meanwhile goes in, and runs next.
    if (!session.lines.length || session.cancelled) break;
    for (const prompt of session.steered.splice(0)) insert(session, prompt);
    if (steering) for (const held of session.held.splice(0)) insert(session, held.prompt, held.resolve);
  }
  session.lines = [];
  // What was steered and did not get in before the work ended is dropped.
  session.steered = [];
  session.running = false;
  session.message = undefined;
  update(session, { sessionUpdate: "state_update", state: "idle", stopReason: session.cancelled ? "cancelled" : "end_turn" });
  const next = session.held.shift();
  if (next) {
    insert(session, next.prompt, next.resolve);
    void work(session);
  }
}

conn.onRequest("initialize", (p) => ({
  protocolVersion: flags.includes("--protocol") ? Number(flags[flags.indexOf("--protocol") + 1]) : Math.min(2, p.protocolVersion),
  info: { name: "mock", version: "0" },
  authMethods: [{ methodId: "login", name: "Log in with the mock CLI", type: "agent" }],
  capabilities: {
    session: {
      prompt: steering ? { image: {} } : {},
      ...(flags.includes("--no-system-prompt") ? {} : { systemPrompt: {} }),
    },
  },
  ...(steerExt ? { _meta: { steering: { supported: true } } } : {}),
}));
conn.onRequest("_session/steering", (p) => {
  const session = sessions.get(p.sessionId);
  if (!steerExt || !session) throw new RpcError(-32601, "Method not found");
  if (!session.running) return { outcome: "promptRequired", reason: "noRunningTurn" };
  session.steered.push(p.prompt);
  return { outcome: "injected" };
});
conn.onRequest("session/new", async (p) => ({ sessionId: (await open(`mock_${process.pid}_${++counter}`, p.mcpServers)).id }));
conn.onRequest("session/resume", async (p) => {
  if (flags.includes("--no-resume")) throw new RpcError(-32002, "no such session");
  await open(p.sessionId, p.mcpServers);
  update(sessions.get(p.sessionId)!, { sessionUpdate: "state_update", state: "idle" });
  return {};
});
conn.onRequest("session/prompt", (p) => {
  const session = sessions.get(p.sessionId);
  if (!session) throw new RpcError(-32002, "no such session");
  if (flags.includes("--auth-required")) throw new RpcError(-32000, "Authentication required");
  return new Promise((resolve, reject) => {
    if (!session.running) {
      insert(session, p.prompt, resolve);
      void work(session);
    } else {
      // Held: like claude (--steering), until the work's next step; like codex, until the work is done.
      session.held.push({ prompt: p.prompt, resolve, reject });
    }
  });
});
conn.onNotification("session/cancel", (p) => {
  const session = sessions.get(p.sessionId);
  if (!session) return;
  for (const held of session.held.splice(0)) held.reject(RpcError.cancelled());
  session.steered = [];
  if (!session.running) return;
  session.cancelled = true;
  session.wake?.();
});
