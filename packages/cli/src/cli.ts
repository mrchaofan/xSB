/** The `xsb` command. */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { Paths, describeBackends, findProject, globalConfigPath, hubSocket, initProject, readHubInfo, stopHub } from "@xsb/hub";
import { Agents, Backends, Workflow, Tasks, exitCode, explain, isTerminal, text } from "@xsb/protocol";
import type { AgentInfo, BackendInfo, Connection, PermissionRequest, PermissionResponse, Task, Language } from "@xsb/protocol";
import { connectHub } from "./client.ts";
import type { HubConnection } from "./client.ts";
import type { WorkflowView } from "@xsb/protocol";
import { Printer } from "./printer.ts";
import { language, t } from "./text.ts";
import type { Shown } from "./text.ts";

/** What went wrong, in the terminal's language. */
const why = (e: unknown): string => explain(e, language);

type Args = { _: string[]; [flag: string]: string | boolean | string[] };

/** Flags that take no value: what follows them is the next argument, not theirs. */
const SWITCHES = new Set(["new", "history", "help", "keep", "history-only", "workflow-target"]);

function parse(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) args._.push(arg);
    else if (SWITCHES.has(arg.slice(2))) args[arg.slice(2)] = true;
    else if (i + 1 >= argv.length) throw new Error(t.noValue(arg));
    else args[arg.slice(2)] = argv[++i];
  }
  return args;
}

const flag = (args: Args, name: string): string | undefined =>
  typeof args[name] === "string" ? (args[name] as string) : undefined;

function messageScope(args: Args) {
  if (args["history-only"] && args["workflow-target"]) throw Error("Choose one message target");
  return args["history-only"] ? "history" : args["workflow-target"] ? "workflow" : undefined;
}

function project(args: Args): Paths {
  const dir = flag(args, "project") ?? findProject();
  if (!dir) throw new Error(t.noProject(process.cwd()));
  return new Paths(dir);
}

export async function main(argv: string[]): Promise<void> {
  try {
    await run(parse(argv));
  } catch (e) {
    process.stderr.write(`xsb: ${why(e)}\n`);
    process.exit(exitCode(e));
  }
}

async function run(args: Args): Promise<void> {
  const [command, ...rest] = args._;
  if (args.help) { process.stdout.write(t.help); return; }
  switch (command) {
    case "init":
      return init(args);
    case "session":
      if (rest[0] === "new") {
        const conn = await connectHub(project(args),false);
        try { console.log(await openSession(conn,undefined,flag(args,"backend"),false,rest.slice(1).join(" "))); }
        finally { conn.close(); }
        return;
      }
      if (rest[0] === "list" || rest.length === 0) return report(args,"sessions");
      throw Error("xsb session new [title] [--backend NAME] | list");
    case "workflow": {
      const [action,id,...nodes] = rest;
      if (!id || !["show","pause","resume"].includes(action)) throw Error("xsb workflow show|pause|resume SESSION [NODE ...]");
      const conn = await connectHub(project(args),false);
      try {
        const graph = await conn.request<WorkflowView>(action === "show" ? Workflow.get : action === "pause" ? Workflow.pause : Workflow.resume,{sessionId:id,...(nodes.length ? {nodes} : {})});
        console.log(JSON.stringify(graph,null,2));
      } finally { conn.close(); }
      return;
    }
    case "backends":
      return listBackends(args);
    case "chat":
      return chat(args, rest[0]);
    case "send":
      return send(args, rest[0], rest.slice(1).join(" "));
    case "watch":
      return watch(args);
    case "tasks":
      if (rest[0] === "cancel") return cancelTask(args, rest[1]);
      return report(args, command);
    case "status":
    case "sessions":
      return report(args, command);
    case "hub":
      return hub(args, rest[0]);
    case "acp":
      return acpStdio(args);
    default:
      if (command && command !== "help") throw Error(`Unknown command: ${command}`);
      process.stdout.write(t.help);
  }
}

// ---- setup ------------------------------------------------------------------

function init(args: Args): void {
  const paths = new Paths(flag(args, "project") ?? process.cwd());
  if (initProject(paths)) console.log(t.created(globalConfigPath()));
  console.log(t.initialized(paths.dir));
}

/**
 * The backends of this machine. Whether one is installed is the word of the project's running hub, for the hub is
 * what starts it, on a PATH that may not be this terminal's (the desktop app's, say). With no hub running, the next
 * one would be started from here and find what this terminal finds.
 */
async function listBackends(args: Args): Promise<void> {
  const dir = flag(args, "project") ?? findProject();
  let list = describeBackends();
  if (dir && readHubInfo(new Paths(dir))) {
    const conn = await connectHub(new Paths(dir), false);
    list = (await conn.request<{ backends: BackendInfo[] }>(Backends.list)).backends;
    conn.close();
  }
  for (const b of list) {
    console.log(`${b.name.padEnd(10)} ${t.installed(b.installed)} ${[b.command, ...b.args].join(" ")}${!b.installed && b.installHint ? `    ${b.installHint}` : ""}`);
  }
  console.log(t.backendsDefined(globalConfigPath()));
}

function printAgents(agents: AgentInfo[]): void {
  if (agents.length === 0) return console.log(t.noAgents);
  for (const a of agents) {
    console.log(`${a.id.padEnd(14)} ${t.state[a.state].padEnd(16)} ${a.backend.padEnd(8)} ${a.name}${a.description ? `: ${a.description}` : ""}`);
  }
}

// ---- talking ----------------------------------------------------------------

async function openSession(
  conn: HubConnection,
  id?: string,
  backend?: string,
  history = false,
  title?: string,
): Promise<string> {
  if (id) {
    await conn.request("session/resume", { sessionId: id, ...(history && { replayFrom: { type: "start" } }) });
    return id;
  }
  return (
    await conn.request("session/new", {
      cwd: process.cwd(),
      title,
      mcpServers: [],
      _meta: { [Workflow.backend]: backend },
    })
  ).sessionId;
}

/**
 * Answer permission requests at the terminal, one at a time. A command with no terminal does not call this: the
 * hub then finds that it cannot answer, and asks whoever can (permissions.ts in @xsb/hub).
 */
function servePermissions(conn: HubConnection, printer: Printer, ask: (question: string) => Promise<string>): void {
  let turn: Promise<unknown> = Promise.resolve();
  conn.onRequest("session/request_permission", (request: PermissionRequest): Promise<PermissionResponse> => {
    const answer = turn.then(async (): Promise<PermissionResponse> => {
      const who = printer.labels.get(request.sessionId) ?? request.sessionId;
      const what = request.title || request.subject?.toolCall?.title || t.useTool;
      printer.line(t.asks(who, what));
      request.options.forEach((o, i) => printer.line(`  ${i + 1}) ${o.name}`));
      const choice = request.options[Number(await ask(t.choose)) - 1];
      return choice ? { outcome: { outcome: "selected", optionId: choice.optionId } } : { outcome: { outcome: "cancelled" } };
    });
    turn = answer.catch(() => {});
    return answer;
  });
}

async function chat(args: Args, agentId: string | undefined): Promise<void> {

  const paths = project(args);
  const conn = await connectHub(paths, true);
  const printer = new Printer();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

  conn.onUpdate((sessionId, update) => printer.update(sessionId, update));
  servePermissions(conn, printer, ask);
  const sessionId = await openSession(conn, args.new ? undefined : agentId, flag(args,"backend"), args.history === true);
  printer.labels.set(sessionId, sessionId);
  printer.line(t.talking(sessionId));

  let running = 0;
  rl.setPrompt("> ");
  rl.prompt();
  rl.on("line", (line) => {
    const input = line.trim();
    if (input === "/quit") return rl.close();
    if (input === "/cancel") conn.notify("session/cancel", { sessionId });
    else if (input) {
      // The user's word never waits: sent while the agent works, it goes into the running turn.
      if (running > 0) printer.line(t.interjecting);
      running++;
      conn
        .turn(sessionId, [text(input)],messageScope(args))
        .then((stopReason) => stopReason !== "end_turn" && printer.line(t.stopped(stopReason)), (e) => printer.line(t.failed(why(e))))
        .finally(() => {
          running--;
          printer.endLine();
          rl.prompt();
        });
    }
    rl.prompt();
  });
  void conn.closed.then(() => rl.close()); // the hub went away: there is nobody left to talk to
  await new Promise((resolve) => rl.on("close", resolve));
  conn.close();
}

async function send(args: Args, agentId: string | undefined, message: string): Promise<void> {
  if (!agentId || !message) throw new Error(t.usage("xsb send <session> <message>"));
  const paths = project(args);
  const conn = await connectHub(paths, process.stdin.isTTY === true);
  const printer = new Printer();
  conn.onUpdate((sessionId, update) => printer.update(sessionId, update));
  let rl: readline.Interface | undefined;
  if (process.stdin.isTTY) {
    servePermissions(conn, printer, (q) => {
      rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve) => rl!.question(q, resolve));
    });
  }
  const sessionId = await openSession(conn, agentId);
  printer.labels.set(sessionId, sessionId);
  try {
    // To an agent at work, it goes into the running turn, and this follows that turn to its end.
    const stopReason = await conn.turn(sessionId, [text(message)],messageScope(args));
    if (stopReason !== "end_turn") printer.line(t.stopped(stopReason));
  } finally {
    printer.endLine();
    rl?.close();
    conn.close();
  }
}

/** Who started a task: an agent, or the user. */
const shownStatus = (task: Task): Shown => (task.ended?.reason === "superseded" ? "superseded" : task.status);
const initiatorOf = (task: Task): string => (task.initiator.kind === "agent" ? task.initiator.agentId : t.user);

/** Who does a task: an agent, or for a job the tool that runs. */
const doer = (task: Task): string => (task.tool ? `${task.tool.server}/${task.tool.name}` : task.to.agentId);

async function watch(args: Args): Promise<void> {
  const paths = project(args);
  const conn = await connectHub(paths, true);
  const printer = new Printer();
  printer.showLabels = true;
  const follow = async (agentInfo: AgentInfo): Promise<void> => {
    const sessionId = agentInfo.mainSessionId;
    if (!sessionId || printer.labels.has(sessionId)) return;
    printer.labels.set(sessionId, agentInfo.id);
    // An agent that cannot be followed is said so, and tried again when it next changes; the others are watched all the same.
    await conn.request("session/resume", { sessionId, cwd: agentInfo.workspace, mcpServers: [] }).catch((e) => {
      printer.labels.delete(sessionId);
      printer.line(t.failed(why(e)));
    });
  };
  conn.onUpdate((sessionId, update) => printer.update(sessionId, update));
  conn.onNotification(Agents.update, (p) => void follow(p.agent));
  conn.onNotification(Agents.removed, (p) => printer.line(t.agentRemoved(p.id)));
  conn.onNotification(Tasks.update, ({ task }: { task: Task }) =>
    printer.line(t.taskLine(task.id, initiatorOf(task), doer(task), task.title, shownStatus(task))),
  );
  const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  if (rl) servePermissions(conn, printer, (q) => new Promise((resolve) => rl.question(q, resolve)));
  const { agents } = await conn.request<{ agents: AgentInfo[] }>(Agents.list);
  for (const a of agents) await follow(a);
  printer.line(t.watching(agents.length));
  await conn.closed;
}

async function report(args: Args, what: string): Promise<void> {
  const paths = project(args);
  const conn = await connectHub(paths, false);
  try {
    if (what === "status") {
      console.log(t.project(paths.project, readHubInfo(paths)?.pid));
      printAgents((await conn.request<{ agents: AgentInfo[] }>(Agents.list)).agents);
    }
    if (what === "status" || what === "tasks") {
      const { tasks } = await conn.request<{ tasks: Task[] }>(Tasks.list, { agentId: flag(args, "agent") });
      const shown = what === "tasks" ? tasks : tasks.filter((task) => !isTerminal(task.status));
      if (what === "status" && shown.length) console.log(t.openTasks);
      for (const task of shown) console.log(`${task.id}  ${t.taskStatus[shownStatus(task)].padEnd(10)} ${initiatorOf(task)} -> ${doer(task)}  [${task.topic}] ${task.title}`);
    }
    if (what === "sessions") {
      const { sessions } = await conn.request("session/list", {});
      for (const s of sessions) console.log(`${s.sessionId}  ${String(s._meta[Agents.sessionKey]).padEnd(14)} ${s.updatedAt}  ${s.title}`);
    }
  } finally {
    conn.close();
  }
}

/** The user stops a task: the user may stop any. */
async function cancelTask(args: Args, taskId: string | undefined): Promise<void> {
  if (!taskId) throw new Error(t.usage("xsb tasks cancel <task-id>"));
  const conn = await connectHub(project(args), false);
  try {
    const { with: also } = await conn.request<{ task: Task; with: Task[] }>(Tasks.cancel, { taskId });
    console.log(t.taskCancelled(taskId, also.map((task) => task.id)));
  } finally {
    conn.close();
  }
}

// ---- hub process ------------------------------------------------------------

async function hub(args: Args, action: string | undefined): Promise<void> {
  const paths = project(args);
  const info = readHubInfo(paths);
  switch (action) {
    case "start":
      (await hubSocket(paths)).destroy();
      return console.log(t.hubRunning(readHubInfo(paths)?.pid));
    case "stop":
      if (!info || !stopHub(paths)) return console.log(t.hubNotRunning);
      for (let i = 0; i < 50 && readHubInfo(paths); i++) await sleep(100);
      if (readHubInfo(paths)) throw new Error(t.hubStuck(info.pid));
      return console.log(t.hubStopped);
    case "log":
      return void process.stdout.write(fs.existsSync(paths.hubLog) ? fs.readFileSync(paths.hubLog, "utf8") : "");
    default:
      console.log(info ? t.hubRunning(info.pid, info.startedAt) : t.hubNotRunning);
  }
}

/** Serve the workspace hub over ACP stdio. */
async function acpStdio(args: Args): Promise<void> {
  const socket = await hubSocket(project(args));
  socket.pipe(process.stdout);
  socket.on("close", () => process.exit(0));
  process.stdin.pipe(socket);
}
