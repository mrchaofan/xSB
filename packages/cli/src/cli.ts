/** The `xsb` command. */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { Paths, backends, findCommand, findProject, globalConfigPath, hubSocket, initProject, readHubInfo, stopHub } from "@xsb/hub";
import { Agents, Assets, Roles, Steering, Tasks, Teams, exitCode, explain, isTerminal, text } from "@xsb/protocol";
import type { AgentInfo, Asset, McpServerCheck, RoleDetail, RoleInfo, Connection, PermissionRequest, PermissionResponse, SteeringOutcome, Task, TeamInfo } from "@xsb/protocol";
import { connectHub } from "./client.ts";
import { Printer } from "./printer.ts";
import { language, t } from "./text.ts";

/** What went wrong, in the terminal's language. */
const why = (e: unknown): string => explain(e, language);

type Args = { _: string[]; [flag: string]: string | boolean | string[] };

/** Flags that take no value: what follows them is the next argument, not theirs. */
const SWITCHES = new Set(["new", "history", "interject", "help"]);

function parse(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) args._.push(arg);
    else if (SWITCHES.has(arg.slice(2)) || i + 1 >= argv.length) args[arg.slice(2)] = true;
    else args[arg.slice(2)] = argv[++i];
  }
  return args;
}

const flag = (args: Args, name: string): string | undefined =>
  typeof args[name] === "string" ? (args[name] as string) : undefined;

/** A flag whose value is text, or `@file` for the content of a file. */
function textFlag(args: Args, name: string): string | undefined {
  const value = flag(args, name);
  return value?.startsWith("@") ? fs.readFileSync(value.slice(1), "utf8") : value;
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
  switch (command) {
    case "init":
      return init(args);
    case "agent":
      return agent(args, rest);
    case "role":
      return role(args, rest);
    case "team":
      return team(args, rest);
    case "backends":
      return listBackends();
    case "chat":
      return chat(args, rest[0]);
    case "send":
      return send(args, rest[0], rest.slice(1).join(" "));
    case "watch":
      return watch(args);
    case "status":
    case "tasks":
    case "sessions":
    case "assets":
      return report(args, command);
    case "hub":
      return hub(args, rest[0]);
    case "acp":
      return acpStdio(args);
    default:
      process.stdout.write(t.help);
  }
}

// ---- setup ------------------------------------------------------------------

function init(args: Args): void {
  const paths = new Paths(flag(args, "project") ?? process.cwd());
  if (initProject(paths)) console.log(t.created(globalConfigPath()));
  console.log(t.initialized(paths.dir));
}

function listBackends(): void {
  for (const [name, spec] of Object.entries(backends())) {
    const found = t.installed(findCommand(spec.command) !== null);
    console.log(`${name.padEnd(10)} ${found} ${spec.command} ${(spec.args ?? []).join(" ")}`);
  }
  console.log(t.backendsDefined(globalConfigPath()));
}

async function agent(args: Args, [action, id]: string[]): Promise<void> {
  const paths = project(args);
  const conn = await connectHub(paths, false);
  try {
    if (action === "add") {
      if (!id) throw new Error(t.usage("xsb agent add <id> [options]"));
      const instructions = textFlag(args, "instructions");
      const workspace = flag(args, "workspace");
      const spec = {
        id,
        name: flag(args, "name"),
        description: flag(args, "desc"),
        backend: flag(args, "backend"),
        role: flag(args, "role"),
        workspace: workspace ? path.resolve(workspace) : undefined,
      };
      const { agent: saved } = await conn.request<{ agent: AgentInfo }>(Agents.put, { agent: spec, instructions });
      console.log(t.agentSaved(saved.id, saved.role, saved.backend, saved.workspace));
      console.log(t.instructionsAt(paths.instructions(saved.id)));
    } else if (action === "remove") {
      await conn.request(Agents.remove, { id });
      console.log(t.removed(id));
    } else if (action === "show") {
      console.log((await conn.request<{ systemPrompt: string }>(Agents.get, { id })).systemPrompt);
    } else if (action === "restart") {
      await conn.request(Agents.restart, { id });
      console.log(t.restarted(id));
    } else {
      printAgents((await conn.request<{ agents: AgentInfo[] }>(Agents.list)).agents);
    }
  } finally {
    conn.close();
  }
}

async function role(args: Args, [action, name]: string[]): Promise<void> {
  const paths = project(args);
  const conn = await connectHub(paths, false);
  try {
    if (action === "add") {
      const input = { name, description: flag(args, "desc"), backend: flag(args, "backend"), workspace: flag(args, "workspace"), instructions: textFlag(args, "instructions") };
      const { role: saved } = await conn.request<{ role: RoleInfo }>(Roles.put, { role: input });
      console.log(t.roleSaved(saved.name, paths.roleDir(saved.name)));
    } else if (action === "remove") {
      await conn.request(Roles.remove, { name });
      console.log(t.removed(name));
    } else if (action === "show") {
      const { role: r } = await conn.request<{ role: RoleDetail }>(Roles.get, { name });
      console.log(`${r.name}: ${r.description ?? ""}\n${r.preset ? `${t.roleTeam(r.preset.team, r.preset.own)}\n` : ""}${t.roleFacts(r.backend, r.workspace ?? "own", r.agents)}`);
      for (const [server, spec] of Object.entries(r.mcpServers)) console.log(t.roleServer(server, [spec.command, ...(spec.args ?? [])].join(" ")));
      for (const s of r.skills) console.log(t.roleSkill(s.name, s.produces, s.inputs, s.description));
      if (r.instructions.trim()) console.log(`\n${r.instructions.trim()}`);
    } else if (action === "check") {
      const { servers } = await conn.request<{ servers: McpServerCheck[] }>(Roles.check, { name });
      for (const s of servers) console.log(s.tools ? t.serverOk(s.server, s.tools.map((tool) => tool.name)) : t.serverFailed(s.server, s.error ?? ""));
      if (servers.some((s) => s.error)) process.exitCode = 1;
    } else {
      const { roles } = await conn.request<{ roles: RoleInfo[] }>(Roles.list);
      if (roles.length === 0) console.log(t.noRoles);
      for (const r of roles) {
        const has = `${r.preset ? `${r.preset.team}${r.preset.own ? "*" : ""}, ` : ""}${t.roleHas(Object.keys(r.mcpServers).length, r.skills.length, r.agents)}`;
        console.log(`${r.name.padEnd(18)} ${has}${r.description ? `  ${r.description}` : ""}`);
      }
    }
  } finally {
    conn.close();
  }
}

async function team(args: Args, [action, id]: string[]): Promise<void> {
  const conn = await connectHub(project(args), false);
  try {
    if (action === "use" || action === "drop") {
      await conn.request(Teams[action], { id });
      console.log(action === "use" ? t.teamUsed(id) : t.teamDropped(id));
    } else {
      const { teams } = await conn.request<{ teams: TeamInfo[] }>(Teams.list);
      for (const team of teams) console.log(`${team.id.padEnd(12)} ${t.used(team.used)}  ${team.title}: ${team.roles.map((r) => r.name).join(", ")}`);
    }
  } finally {
    conn.close();
  }
}

function printAgents(agents: AgentInfo[]): void {
  if (agents.length === 0) return console.log(t.noAgents);
  for (const a of agents) {
    const role = a.role ? ` (${a.role})` : "";
    console.log(`${a.id.padEnd(14)} ${t.state[a.state].padEnd(16)} ${a.backend.padEnd(8)} ${a.name}${role}${a.description ? `: ${a.description}` : ""}`);
  }
}

// ---- talking ----------------------------------------------------------------

/** Open the agent's main session, or a new one. */
async function openSession(conn: Connection, agentId: string, fresh: boolean, history: boolean): Promise<string> {
  const meta = { [Agents.sessionKey]: agentId };
  if (!fresh) {
    const { sessions } = await conn.request("session/list", { _meta: meta });
    const main = sessions.find((s: any) => s._meta?.[Agents.mainKey]);
    if (main) {
      await conn.request(history ? "session/load" : "session/resume", { sessionId: main.sessionId, cwd: main.cwd, mcpServers: [] });
      return main.sessionId;
    }
  }
  const created = await conn.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: meta });
  return created.sessionId;
}

/** Answer permission requests at the terminal, one at a time. */
function servePermissions(conn: Connection, printer: Printer, ask: ((question: string) => Promise<string>) | null): void {
  let turn: Promise<unknown> = Promise.resolve();
  conn.onRequest("session/request_permission", (request: PermissionRequest): Promise<PermissionResponse> => {
    const answer = turn.then(async (): Promise<PermissionResponse> => {
      const who = printer.labels.get(request.sessionId) ?? request.sessionId;
      const what = request.toolCall.title ?? request.toolCall.name ?? t.useTool;
      if (!ask) {
        printer.line(t.askedNoTerminal(who, what));
        return { outcome: { outcome: "cancelled" } };
      }
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
  if (!agentId) throw new Error(t.usage("xsb chat <agent>"));
  const paths = project(args);
  const conn = await connectHub(paths, true);
  const printer = new Printer();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

  conn.onNotification("session/update", (p) => printer.update(p.sessionId, p.update));
  servePermissions(conn, printer, ask);
  const sessionId = await openSession(conn, agentId, args.new === true, args.history === true);
  printer.labels.set(sessionId, agentId);
  printer.line(t.talking(agentId));

  let running = 0;
  rl.setPrompt("> ");
  rl.prompt();
  rl.on("line", (line) => {
    const input = line.trim();
    if (input === "/quit") return rl.close();
    if (input === "/cancel") conn.notify("session/cancel", { sessionId });
    else if (input.startsWith("/i ")) {
      conn
        .request(Steering.method, { sessionId, prompt: [text(input.slice(3))] })
        .then((r: SteeringOutcome) => printer.line(t.steered[r.outcome]), (e) => printer.line(t.steerFailed(why(e))));
    } else if (input) {
      // A message sent while the agent works is its next turn, not an interruption.
      if (running > 0) printer.line(t.queued);
      running++;
      conn
        .request("session/prompt", { sessionId, prompt: [text(input)] })
        .then((r) => r.stopReason !== "end_turn" && printer.line(t.stopped(r.stopReason)), (e) => printer.line(t.failed(why(e))))
        .finally(() => {
          running--;
          printer.endLine();
          rl.prompt();
        });
    }
    rl.prompt();
  });
  await new Promise((resolve) => rl.on("close", resolve));
  conn.close();
}

async function send(args: Args, agentId: string | undefined, message: string): Promise<void> {
  if (!agentId || !message) throw new Error(t.usage("xsb send <agent> <message> [--interject]"));
  const paths = project(args);
  const conn = await connectHub(paths, process.stdin.isTTY === true);
  const printer = new Printer();
  conn.onNotification("session/update", (p) => printer.update(p.sessionId, p.update));
  let rl: readline.Interface | undefined;
  const ask = process.stdin.isTTY
    ? (q: string): Promise<string> => {
        rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
        return new Promise((resolve) => rl!.question(q, resolve));
      }
    : null;
  servePermissions(conn, printer, ask);
  const sessionId = await openSession(conn, agentId, args.new === true, false);
  printer.labels.set(sessionId, agentId);
  try {
    if (args.interject === true) {
      const result = await conn.request<SteeringOutcome>(Steering.method, { sessionId, prompt: [text(message)] });
      printer.line(t.steered[result.outcome]);
      if (result.outcome === "injected") return;
      // The agent was idle, so the message became a turn of its own: follow it.
      await sleep(200);
      while ((await agentState(conn, agentId)) !== "idle") await sleep(300);
    } else {
      const result = await conn.request("session/prompt", { sessionId, prompt: [text(message)] });
      if (result.stopReason !== "end_turn") printer.line(t.stopped(result.stopReason));
    }
  } finally {
    printer.endLine();
    rl?.close();
    conn.close();
  }
}

/** Who does a task: an agent, or for a job the tool that runs. */
const doer = (task: Task): string => (task.tool ? `${task.tool.server}/${task.tool.name}` : task.to.agentId);

async function agentState(conn: Connection, agentId: string): Promise<string | undefined> {
  const { agents } = await conn.request<{ agents: AgentInfo[] }>(Agents.list);
  return agents.find((a) => a.id === agentId)?.state;
}

async function watch(args: Args): Promise<void> {
  const paths = project(args);
  const conn = await connectHub(paths, true);
  const printer = new Printer();
  printer.showLabels = true;
  const follow = async (agentInfo: AgentInfo): Promise<void> => {
    const sessionId = agentInfo.mainSessionId;
    if (!sessionId || printer.labels.has(sessionId)) return;
    printer.labels.set(sessionId, agentInfo.id);
    await conn.request("session/resume", { sessionId, cwd: agentInfo.workspace, mcpServers: [] });
  };
  conn.onNotification("session/update", (p) => printer.update(p.sessionId, p.update));
  conn.onNotification(Agents.update, (p) => void follow(p.agent).catch(() => {}));
  conn.onNotification(Agents.removed, (p) => printer.line(t.agentRemoved(p.id)));
  conn.onNotification(Tasks.update, ({ task }: { task: Task }) =>
    printer.line(t.taskLine(task.id, task.from.agentId, doer(task), task.title, task.status)),
  );
  const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  servePermissions(conn, printer, rl ? (q) => new Promise((resolve) => rl.question(q, resolve)) : null);
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
      for (const task of shown) console.log(`${task.id}  ${t.taskStatus[task.status].padEnd(10)} ${task.from.agentId} -> ${doer(task)}  [${task.topic}] ${task.title}`);
    }
    if (what === "assets") {
      const { assets } = await conn.request<{ assets: Asset[] }>(Assets.list, { type: flag(args, "type") });
      for (const a of assets) console.log(`${a.id.padEnd(28)} v${a.version}  ${a.by.padEnd(12)} ${a.description}\n${" ".repeat(28)} ${a.path}`);
    }
    if (what === "sessions") {
      const { sessions } = await conn.request("session/list", {});
      for (const s of sessions) console.log(`${s.sessionId}  ${String(s._meta[Agents.sessionKey]).padEnd(14)} ${s.updatedAt}  ${s.title}`);
    }
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

/**
 * ACP on stdio for editors and other ACP clients: a pipe to the hub. With
 * `--agent`, sessions the client creates go to that agent, which is how a
 * client that knows nothing of xsb gets one entry per agent.
 */
async function acpStdio(args: Args): Promise<void> {
  const socket = await hubSocket(project(args));
  const agentId = flag(args, "agent");
  socket.pipe(process.stdout);
  socket.on("close", () => process.exit(0));
  process.stdin.on("end", () => socket.end());
  if (!agentId) return void process.stdin.pipe(socket);
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.method === "session/new") {
        message.params = { ...message.params, _meta: { [Agents.sessionKey]: agentId, ...message.params?._meta } };
        line = JSON.stringify(message);
      }
    } catch {
      /* not ours to judge; the hub answers a parse error */
    }
    socket.write(line + "\n");
  });
}
