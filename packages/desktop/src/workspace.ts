/**
 * One project's workspace: an ACP connection to the project's hub, turned into
 * what the renderer shows (bridge.ts).
 *
 * The hub speaks in sessions and `session/update`s; the renderer shows one
 * transcript of entries per agent. This file maintains that view and coordinates workspace operations. It
 * keeps no state the hub does not have, apart from the user's
 * messages the hub has not yet made part of a turn, and the permission
 * requests the user has not yet answered.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hubSocket, initProject } from "@xsb/hub";
import type { Paths } from "@xsb/hub";
import { Agents, Assets, Backends, Boundaries, Connection, SpendExt, TurnFailure, LanguageExt, OriginExt, PROTOCOL_VERSION, Roles, RpcError, Steering, Tasks, Teams, failure, isTerminal } from "@xsb/protocol";
import type { AgentInfo, Asset, BackendInfo, Boundary, Spend, Language, McpServerCheck, OriginMeta, PermissionRequest, PermissionResponse, RoleDetail, SessionUpdate, Task, TeamInfo } from "@xsb/protocol";
import type { Activity, AgentDetail, AgentInput, Artifact, BackendView, Entry, Event, Pack, Progress, RoleView, Snapshot } from "./bridge.ts";
import { append } from "./content.ts";
import type { Content } from "./content.ts";
import { roleInput, roleView } from "./roles.ts";

export const ARTIFACT_SCHEME = "xsb-artifact";

type Emit = (event: Event) => void;

/**
 * What the user is told of even when they are not looking (main.ts makes it a notification of the system):
 * the work they set going is over, or went wrong, or waits for them. `detail` is in the words it came in.
 */
export type Notice = { agentId: string; name: string; kind: "done" | "failed" | "confirm" | "permission"; detail: string };
type Notify = (notice: Notice) => void;
type Tool = Extract<Entry, { kind: "tool" }>;

const KINDS: Record<string, Artifact["kind"]> = { ".md": "markdown", ".html": "html", ".htm": "html", ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".svg": "image", ".mp4": "video", ".webm": "video", ".mov": "video", ".m4v": "video" };
const TOOL_STATUS: Record<string, Tool["status"]> = { completed: "done", failed: "failed" };

export class Workspace {
  readonly paths: Paths;
  /** Absolute path -> artifact. Only these files are served to the renderer. */
  readonly artifacts = new Map<string, Artifact>();

  private conn: Connection;
  private say: (e: unknown) => string;
  private emit: Emit;
  /** False while `load` gathers the snapshot: what arrives then is part of it, not an event. */
  private live = false;
  /** This side closed the connection (`close`): its end is then no news. */
  private left = false;
  /** No window shows this workspace (`setShown`). */
  private hidden = false;
  private agents = new Map<string, AgentInfo>();
  private tasks = new Map<string, Task>();
  /** The roles as last heard of, by name: what a window is shown when it loads. */
  private roles = new Map<string, RoleView>();
  private transcripts = new Map<string, Entry[]>();
  /** Agent id -> its main session, attached to. Where its transcript comes from and its input goes. */
  private mains = new Map<string, Promise<string>>();
  private sessionAgent = new Map<string, string>();
  /** Agent id -> the output entry that is still growing. */
  private growing = new Map<string, Extract<Entry, { kind: "output" }>>();
  /** Work sessions this client is attached to (their history is replayed into the agent's transcript). */
  private works = new Set<string>();
  /** Agent id -> the session its transcript last showed something of: a change of session gets a heading. */
  private shown = new Map<string, string>();
  /** The user's messages that were sent but are not yet part of a turn, by id: shown, to be replaced by the hub's echo. */
  private pending = new Map<string, Content>();
  /** Agent id -> what it is doing, while it has a turn running, and the tool calls of it that have not ended. */
  private activities = new Map<string, Activity>();
  private tools = new Map<string, Set<string>>();
  /** Entry id -> how to answer the permission request it shows. */
  private asking = new Map<string, { agentId: string; entry: Extract<Entry, { kind: "permission" }>; request: PermissionRequest; answer: (r: PermissionResponse) => void }>();
  private seq = 0;
  private notify: (notice: Omit<Notice, "name">) => void;
  /**
   * Whether some agent was at work when last looked, and what happened since the workspace last went quiet: an
   * agent asked the user something, or the user stopped one. Either way its going quiet is no news of its own.
   */
  private busy = false;
  private asked = false;
  private stopped = false;

  /**
   * Open the project's workspace, making the folder a project first if it is none.
   * `language` is the one the user reads, and `say` words an error in it.
   */
  static async open(paths: Paths, language: Language, say: (e: unknown) => string, emit: Emit, notify: Notify): Promise<Workspace> {
    if (!fs.existsSync(paths.dir)) initProject(paths);
    const socket = await hubSocket(paths);
    const conn = new Connection(socket, socket, "hub");
    await conn.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      // An observer of all agents, and a transcript: sent its own input too, when it becomes part of a turn.
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: { [Agents.capability]: {}, [OriginExt.capability]: {}, [LanguageExt.key]: language },
      },
      clientInfo: { name: "xsb-desktop", version: "0.1.0" },
    });
    return new Workspace(paths, conn, say, emit, notify);
  }

  private constructor(paths: Paths, conn: Connection, say: (e: unknown) => string, emit: Emit, notify: Notify) {
    this.paths = paths;
    this.conn = conn;
    this.say = say;
    this.notify = (notice) => {
      if (this.live) notify({ ...notice, name: this.agents.get(notice.agentId)?.name ?? notice.agentId });
    };
    this.emit = (event) => {
      if (this.live) emit(event);
    };
    // The hub stopped, or died: the window says so, whatever it is in the middle of. Not when it was this side that left.
    void conn.closed.then(() => this.left || this.onHubGone(emit));
    conn.onNotification("session/update", (p) => this.onUpdate(p.sessionId, p.update));
    conn.onNotification(Agents.update, (p) => this.onAgent(p.agent));
    conn.onNotification(Agents.removed, (p) => this.onAgentRemoved(p.id));
    conn.onNotification(Assets.update, (p) => this.asset(p.asset));
    conn.onNotification(Roles.update, (p) => {
      const role = roleView(p.role);
      this.roles.set(role.name, role);
      this.emit({ role });
    });
    conn.onNotification(Roles.removed, (p) => {
      this.roles.delete(p.name);
      this.emit({ removedRole: p.name });
    });
    conn.onNotification(Tasks.update, (p) => this.onTask(p.task));
    conn.onNotification(SpendExt.update, (p) => this.emit({ spend: p.spend }));
    conn.onNotification(Agents.asks, (p) => {
      this.asked = true;
      this.notify({ agentId: p.agentId, kind: "confirm", detail: p.question });
    });
    conn.onRequest("session/request_permission", (p) => this.onPermission(p));
  }

  get connected(): boolean {
    return !this.conn.isClosed;
  }

  close(): void {
    this.left = true;
    this.conn.close();
  }

  /**
   * Whether a window shows this workspace. When none does, the hub runs on and the connection stays, to know when
   * the app quits whether agents are at work here; but nobody is here to be asked anything.
   */
  setShown(shown: boolean): void {
    this.hidden = !shown;
    if (!shown) for (const entryId of [...this.asking.keys()]) this.answer(entryId, "cancelled");
  }

  /** An error in the user's words. One that is only the connection ending says what ended: the hub. */
  private why(e: unknown): string {
    return this.say(this.conn.isClosed ? failure("hub_gone") : e);
  }

  /** With the hub gone nothing runs: no agent is at work any more, and no question of theirs waits for an answer. */
  private onHubGone(emit: Emit): void {
    this.stopped = true;
    for (const entryId of [...this.asking.keys()]) this.answer(entryId, "cancelled");
    for (const agent of [...this.agents.values()]) this.onAgent({ ...agent, state: "idle" });
    emit({ hub: "down" });
  }

  /** Agents doing a turn or holding unfinished tasks, including jobs awaited between turns. */
  working(): string[] {
    if (this.conn.isClosed) return [];
    return [...this.atWork()].map((id) => this.agents.get(id)?.name ?? id);
  }

  private atWork(): Set<string> {
    const busy = new Set([...this.agents.values()].filter((agent) => agent.state !== "idle").map((agent) => agent.id));
    for (const task of this.tasks.values()) {
      if (!isTerminal(task.status)) busy.add(task.tool ? task.from.agentId : task.to.agentId);
    }
    return busy;
  }

  /**
   * Whether the workspace went quiet: nobody at work and no task open. That is when what the user set going is
   * done, however many agents it went through; `agentId` was the last to stop.
   */
  private watch(agentId: string): void {
    const busy = this.atWork().size > 0;
    if (busy && !this.busy) this.asked = this.stopped = false;
    if (!busy && this.busy && !this.asked && !this.stopped) this.notify({ agentId, kind: "done", detail: "" });
    this.busy = busy;
  }

  /** Whether this directory is where one of the workspace's agents works, or is inside the project. */
  worksIn(dir: string): boolean {
    // The same directory can be named in two ways (on macOS, /tmp is /private/tmp).
    const real = (name: string): string => (fs.existsSync(name) ? fs.realpathSync.native(name) : path.resolve(name));
    const inside = (parent: string): boolean => !path.relative(real(parent), real(dir)).startsWith("..");
    return [...this.agents.values()].some((agent) => real(agent.workspace) === real(dir)) || inside(this.paths.project);
  }

  /** Everything of the workspace that the window shows at first. What changes afterwards arrives as events. */
  async load(): Promise<Omit<Snapshot, "pages" | "backends">> {
    this.live = false;
    // Roles and tasks are kept as they are answered. The hub answers in order on one connection, so what changes
    // while the rest still loads arrives after the answer, as an event, and is the newer word.
    const [, { teams }, { agents }, , { assets }, { spend }] = await Promise.all([
      this.conn.request<{ roles: RoleDetail[] }>(Roles.list).then(({ roles }) => (this.roles = new Map(roles.map((r) => [r.name, roleView(r)])))),
      this.conn.request<{ teams: TeamInfo[] }>(Teams.list),
      this.conn.request<{ agents: AgentInfo[] }>(Agents.list),
      this.conn.request<{ tasks: Task[] }>(Tasks.list, {}).then(({ tasks }) => tasks.forEach((task) => this.tasks.set(task.id, task))),
      this.conn.request<{ assets: Asset[] }>(Assets.list, {}),
      this.conn.request<{ spend: Spend }>(SpendExt.get),
    ]);
    agents.forEach((agent) => this.onAgent(agent));
    assets.forEach((asset) => this.asset(asset));
    // Attaching to a session replays its history; the snapshot is complete once every replay is.
    await Promise.allSettled(this.mains.values());
    for (const agentId of this.growing.keys()) this.settle(agentId);
    // What the replayed history ended on is what an agent that is still at work is doing.
    for (const agent of this.agents.values()) if (agent.state === "idle") this.does(agent.id, null);
    this.busy = this.atWork().size > 0;
    this.live = true;
    return {
      workspace: { name: path.basename(this.paths.project), path: this.paths.project },
      roles: [...this.roles.values()],
      agents: [...this.agents.values()],
      tasks: [...this.tasks.values()],
      artifacts: [...this.artifacts.values()],
      assetNames: Object.assign({}, ...teams.map((team) => team.assets)),
      transcripts: Object.fromEntries(this.transcripts),
      activities: Object.fromEntries(this.activities),
      spend,
    };
  }

  /** The backends of this machine, as the hub that starts them sees them now. */
  async backends(): Promise<BackendView[]> {
    const { backends } = await this.conn.request<{ backends: BackendInfo[] }>(Backends.list);
    return backends.map((b) => ({ name: b.name, command: [b.command, ...b.args].join(" "), installed: b.installed }));
  }

  // ---- agents and their transcripts -------------------------------------------

  private onAgent(agent: AgentInfo): void {
    this.agents.set(agent.id, agent);
    if (!this.transcripts.has(agent.id)) this.transcripts.set(agent.id, []);
    // A history that cannot be read is said so, where it would have been shown.
    const failed = (e: unknown): void => this.put(agent.id, { id: this.newId(), kind: "error", text: this.why(e) });
    if (agent.mainSessionId && !this.mains.has(agent.id)) this.session(agent).catch(failed);
    // The agent does its peers' work in work sessions of their own: what happens there shows in its transcript too,
    // under a heading of the topic. They are attached after the main session, so a history reads main first.
    for (const work of agent.workSessions ?? []) {
      if (this.works.has(work.sessionId)) continue;
      this.works.add(work.sessionId);
      this.sessionAgent.set(work.sessionId, agent.id);
      const load = Promise.resolve(this.mains.get(agent.id)).catch(() => undefined).then(() => this.conn.request("session/load", { cwd: agent.workspace, mcpServers: [], sessionId: work.sessionId }));
      load.catch(failed);
    }
    if (agent.state === "idle") {
      this.settle(agent.id);
      this.does(agent.id, null);
    } else if (!this.activities.has(agent.id)) {
      this.does(agent.id, "waiting"); // a turn began: nothing has come back yet
    }
    this.emit({ agent });
    this.watch(agent.id);
  }

  private onTask(task: Task): void {
    const agentId = task.tool ? task.from.agentId : task.to.agentId;
    if (task.status === "failed" && this.tasks.get(task.id)?.status !== "failed") this.notify({ agentId, kind: "failed", detail: task.title });
    this.tasks.set(task.id, task);
    this.emit({ task });
    this.watch(agentId);
  }

  private onAgentRemoved(id: string): void {
    for (const [sessionId, agentId] of this.sessionAgent) if (agentId === id) this.sessionAgent.delete(sessionId);
    for (const perAgent of [this.agents, this.transcripts, this.mains, this.growing, this.activities, this.tools, this.shown]) perAgent.delete(id);
    this.emit({ removedAgent: id });
  }

  /** The agent's main session with this client attached, created if the agent has none. */
  private session(agent: AgentInfo): Promise<string> {
    let session = this.mains.get(agent.id);
    if (!session) {
      const setup = { cwd: agent.workspace, mcpServers: [] };
      if (agent.mainSessionId) {
        // Loading replays the session's history as updates, before it answers.
        this.sessionAgent.set(agent.mainSessionId, agent.id);
        session = this.conn.request("session/load", { ...setup, sessionId: agent.mainSessionId }).then(() => agent.mainSessionId!);
      } else {
        session = this.conn.request("session/new", { ...setup, _meta: { [Agents.sessionKey]: agent.id } }).then((created) => {
          this.sessionAgent.set(created.sessionId, agent.id);
          return created.sessionId;
        });
      }
      this.mains.set(agent.id, session);
      session.catch(() => this.mains.delete(agent.id));
    }
    return session;
  }

  /** Show an entry of an agent's transcript, in place of the one with its id if there is one. Nothing, once the agent is gone. */
  private put(agentId: string, entry: Entry): void {
    const entries = this.transcripts.get(agentId);
    if (!entries) return;
    const index = entries.findIndex((e) => e.id === entry.id);
    if (index < 0) entries.push(entry);
    else entries[index] = entry;
    this.emit({ agentId, entry });
  }

  private drop(agentId: string, entryId: string): void {
    const index = this.transcripts.get(agentId)?.findIndex((e) => e.id === entryId) ?? -1;
    if (index < 0) return;
    this.transcripts.get(agentId)!.splice(index, 1);
    this.emit({ agentId, removedEntry: entryId });
  }

  private newId(): string {
    return `e${++this.seq}`;
  }

  /** When the transcript goes on with another session of the agent than before, say which: a work session's topic, or the main one. */
  private heading(agentId: string, sessionId: string): void {
    const agent = this.agents.get(agentId);
    const prior = this.shown.get(agentId);
    this.shown.set(agentId, sessionId);
    if (!agent?.workSessions?.length || prior === sessionId) return;
    // An agent's history begins in its main session without a heading; a heading marks every change after that.
    if (prior === undefined && sessionId === agent.mainSessionId) return;
    this.settle(agentId);
    const topic = agent.workSessions.find((w) => w.sessionId === sessionId)?.topic;
    this.put(agentId, { id: this.newId(), kind: "thread", ...(topic ? { topic } : {}) });
  }

  /** The agent's output so far is complete: whatever comes next starts a new entry. */
  private settle(agentId: string): void {
    const entry = this.growing.get(agentId);
    if (!entry) return;
    this.growing.delete(agentId);
    this.put(agentId, { ...entry, streaming: false });
  }

  /** Note what an agent is doing, when that is news. `null`: its turn is over. */
  private does(agentId: string, kind: Activity["kind"] | null, detail?: string): void {
    const prior = this.activities.get(agentId);
    if (kind === null) {
      this.tools.delete(agentId);
      if (this.activities.delete(agentId)) this.emit({ agentId, activity: null });
    } else if (prior?.kind !== kind || prior.detail !== detail) {
      const activity = { kind, detail, since: new Date().toISOString() };
      this.activities.set(agentId, activity);
      this.emit({ agentId, activity });
    }
  }

  private onUpdate(sessionId: string, update: SessionUpdate): void {
    const agentId = this.sessionAgent.get(sessionId);
    if (!agentId) return;
    this.heading(agentId, sessionId);
    if (update.sessionUpdate === "agent_thought_chunk") return this.does(agentId, "thinking");
    const boundary = update.sessionUpdate === "session_info_update" ? (update._meta?.[Boundaries.key] as Boundary | undefined) : undefined;
    if (boundary) {
      this.settle(agentId);
      return this.put(agentId, { id: this.newId(), kind: "boundary", boundary });
    }
    const failed = update.sessionUpdate === "session_info_update" ? (update._meta?.[TurnFailure.key] as { message: string; data?: unknown } | undefined) : undefined;
    if (failed) {
      // A turn that a task or a message started failed: nobody else would hear of it.
      this.settle(agentId);
      const text = this.say(new RpcError(-32603, failed.message, failed.data));
      this.put(agentId, { id: this.newId(), kind: "error", text });
      if (this.live) this.notify({ agentId, kind: "failed", detail: text });
      return;
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      this.does(agentId, "writing");
      const entry = this.growing.get(agentId) ?? { id: this.newId(), kind: "output", content: [], streaming: true };
      entry.content = append(entry.content, update.content);
      this.growing.set(agentId, entry);
      return this.put(agentId, { ...entry });
    }
    if (update.sessionUpdate === "user_message_chunk") {
      // A message arrives block by block under one id.
      const id = `${sessionId}:${update.messageId}`;
      const prior = this.transcripts.get(agentId)!.find((e): e is Extract<Entry, { kind: "input" }> => e.id === id);
      if (prior) return this.put(agentId, { ...prior, content: append(prior.content, update.content) });
      // Input marks where a turn begins, or where a message entered the running one: what was said before is complete.
      this.settle(agentId);
      this.does(agentId, "waiting"); // the model has it now, and has not answered yet
      if (this.pending.delete(update.messageId)) this.drop(agentId, update.messageId);
      this.put(agentId, { id, kind: "input", origin: (update._meta?.[OriginExt.key] as OriginMeta | undefined) ?? { kind: "user" }, content: [update.content] });
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.settle(agentId);
      const id = `${sessionId}:${update.toolCallId}`;
      const prior = this.transcripts.get(agentId)!.find((e): e is Tool & { id: string } => e.id === id);
      const file = update.locations?.[0]?.path;
      const title = update.title ?? prior?.title ?? update.toolCallId;
      const status = TOOL_STATUS[update.status ?? ""] ?? (update.status ? "running" : (prior?.status ?? "running"));
      this.put(agentId, { id, kind: "tool", title, status, artifactId: (file && this.artifact(file, agentId)?.id) ?? prior?.artifactId });
      // While any tool call is open the agent is running tools; once the last one ends, its model reads the results.
      const open = this.tools.get(agentId) ?? new Set<string>();
      this.tools.set(agentId, open);
      if (status === "running") open.add(id);
      else open.delete(id);
      if (status === "running") this.does(agentId, "tool", title);
      else if (!open.size) this.does(agentId, "waiting");
    }
  }

  // ---- talking to an agent ----------------------------------------------------

  /**
   * Start a turn, queue behind the running one, or (interject) go into the
   * running one. The message shows at once, as waiting if the agent is busy.
   * The hub sends it back under the same id when it has become part of a
   * turn; that entry takes the place of this one, where the turn begins.
   * A message that waits can still be sent into the running turn (`sendNow`).
   */
  async send(agentId: string, content: Content, interject: boolean): Promise<void> {
    const agent = this.agents.get(agentId)!;
    const steer = interject && agent.state !== "idle";
    const id = `m_${randomUUID()}`;
    const entry = { id, kind: "input" as const, origin: { kind: "user" as const }, content };
    this.pending.set(id, content);
    this.put(agentId, { ...entry, queued: agent.state !== "idle" && !steer });
    try {
      const params = { sessionId: await this.session(agent), prompt: content, _meta: { [OriginExt.key]: { messageId: id } } };
      await this.conn.request(steer ? Steering.method : "session/prompt", params);
    } catch (e) {
      // It never became a turn: it stays as sent, no longer waiting.
      if (this.pending.delete(id)) this.put(agentId, entry);
      const text = this.why(e);
      this.put(agentId, { id: this.newId(), kind: "error", text });
      this.notify({ agentId, kind: "failed", detail: text });
    }
  }

  /**
   * Send a message that waits for its turn into the turn that is running instead. The hub takes it for the
   * same message by its id, so it does not also run later; its echo, as ever, takes the place of the waiting entry.
   */
  async sendNow(agentId: string, entryId: string): Promise<void> {
    const content = this.pending.get(entryId);
    const sessionId = await this.mains.get(agentId);
    if (!content || !sessionId) return; // it became a turn in the meantime
    // It could not go in (the agent waits for an approval, say): it keeps its turn, and the reason is shown.
    await this.conn
      .request(Steering.method, { sessionId, prompt: content, _meta: { [OriginExt.key]: { messageId: entryId } } })
      .catch((e) => this.put(agentId, { id: this.newId(), kind: "error", text: this.why(e) }));
  }

  /** The user's cap on what generation may cost in this workspace, in yuan. */
  async setBudget(amount: number): Promise<void> {
    await this.conn.request(SpendExt.budget, { amount });
  }

  /** Clear the agent's context: its model starts anew and sees nothing of what was said. The transcript keeps it. */
  async clear(agentId: string): Promise<void> {
    const sessionId = await this.mains.get(agentId);
    if (sessionId) await this.conn.request(Boundaries.clear, { sessionId }).catch((e) => this.put(agentId, { id: this.newId(), kind: "error", text: this.why(e) }));
  }

  /** Stop the running turn. Its open permission requests are void. */
  async cancel(agentId: string): Promise<void> {
    this.stopped = true;
    for (const [entryId, asked] of this.asking) if (asked.agentId === agentId) this.answer(entryId, "cancelled");
    const sessionId = await this.mains.get(agentId);
    if (sessionId) this.conn.notify("session/cancel", { sessionId });
  }

  private onPermission(request: PermissionRequest): Promise<PermissionResponse> {
    const agentId = this.sessionAgent.get(request.sessionId);
    // A session this window does not show, or no window at all: leave the question to a client that can show it.
    if (!agentId || this.hidden) throw RpcError.notFound(`session ${request.sessionId}`);
    this.settle(agentId);
    const entry = {
      id: this.newId(),
      kind: "permission" as const,
      detail: request.toolCall.title ?? request.toolCall.name ?? request.toolCall.toolCallId,
    };
    this.put(agentId, entry);
    this.notify({ agentId, kind: "permission", detail: entry.detail });
    return new Promise((answer) => this.asking.set(entry.id, { agentId, entry, request, answer }));
  }

  /** Answer the permission request an entry shows. */
  permit(entryId: string, allow: boolean): void {
    this.answer(entryId, allow ? "allowed" : "rejected");
  }

  private answer(entryId: string, outcome: "allowed" | "rejected" | "cancelled"): void {
    const asked = this.asking.get(entryId);
    if (!asked) return;
    this.asking.delete(entryId);
    const option = outcome !== "cancelled" && asked.request.options.find((o) => o.kind.startsWith(outcome === "allowed" ? "allow" : "reject"));
    asked.answer({ outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } });
    this.put(asked.agentId, { ...asked.entry, outcome });
  }

  // ---- editing agents and roles -----------------------------------------------

  async putAgent({ instructions, ...spec }: AgentInput): Promise<AgentInfo> {
    // An empty workspace means the default one; the hub keeps or chooses it.
    const agent = { ...spec, workspace: spec.workspace || undefined };
    return (await this.conn.request<{ agent: AgentInfo }>(Agents.put, { agent, instructions })).agent;
  }

  async removeAgent(id: string): Promise<void> {
    await this.conn.request(Agents.remove, { id });
  }

  /**
   * Do the same for several agents, one after the other. What is done stays done, and doing it again does the rest:
   * so when one fails, the answer says which were done and why it stopped.
   */
  private async each<Item extends { id: string }>(agents: Item[], work: (agent: Item) => Promise<unknown>, completed: string[] = []): Promise<Progress> {
    const done = completed.filter((id) => agents.some((agent) => agent.id === id));
    for (const agent of agents) {
      if (done.includes(agent.id)) continue;
      try {
        await work(agent);
        done.push(agent.id);
      } catch (e) {
        return { done, failed: agent.id, error: this.why(e) };
      }
    }
    return { done };
  }

  private agentsOf(role: string): AgentInfo[] {
    return [...this.agents.values()].filter((agent) => agent.role === role);
  }

  /** Stop the backend processes of a role's agents, so that what was edited applies from their next turns on. */
  applyRole(role: string, completed: string[] = []): Promise<Progress> {
    return this.each(this.agentsOf(role), (agent) => this.conn.request(Agents.restart, { id: agent.id }), completed);
  }

  /** Give a role's agents the description and the backend the role now has. */
  async syncRole(role: string): Promise<Progress> {
    const { description, backend } = this.roles.get(role) ?? { description: "", backend: "" };
    return this.each(this.agentsOf(role).filter((agent) => agent.description !== description || (backend && agent.backend !== backend)), async (agent) => {
      const result = await this.conn.request<{ agent: AgentInfo }>(Agents.put, { agent: { id: agent.id, description, backend: backend || agent.backend } });
      this.agents.set(result.agent.id, result.agent);
    });
  }

  /** Use a team, and give each of its roles that has none an agent, named after the role and run by `backend`. */
  async buildTeam(id: string, backend: string): Promise<Progress> {
    await this.useTeam(id);
    const { teams } = await this.conn.request<{ teams: TeamInfo[] }>(Teams.list);
    const missing = (teams.find((team) => team.id === id)?.roles ?? []).map(({ name, role }) => ({ id: role.name, name, description: role.description, backend, role: role.name }));
    const progress = await this.each(missing.filter((agent) => !this.agents.has(agent.id)), async (agent) => {
      const result = await this.conn.request<{ agent: AgentInfo }>(Agents.put, { agent });
      this.agents.set(result.agent.id, result.agent);
    });
    return progress;
  }

  async inspectAgent(id: string): Promise<AgentDetail> {
    const { instructions, systemPrompt } = await this.conn.request(Agents.get, { id });
    return { instructions, systemPrompt };
  }

  async putRole(view: RoleView): Promise<RoleView> {
    const { role } = await this.conn.request<{ role: RoleDetail }>(Roles.put, { role: roleInput(view) });
    return roleView(role);
  }

  /**
   * Remove the workspace's own role. Like using or dropping a team, it can change several roles: what became of
   * them arrives as events, ahead of the answer.
   */
  async removeRole(name: string): Promise<void> {
    await this.conn.request(Roles.remove, { name });
  }

  // ---- preset teams -------------------------------------------------------------

  /** The teams the hub ships. `missing` says whether a program a role works with cannot be found on this machine. */
  async teams(missing: (command: string) => boolean): Promise<Pack[]> {
    const { teams } = await this.conn.request<{ teams: TeamInfo[] }>(Teams.list);
    return teams.map((team) => ({
      ...team,
      roles: team.roles.map(({ name, role, requires }) => ({ name, role: roleView(role), missing: requires.filter((program) => missing(program.command)) })),
    }));
  }

  /** Use a team's roles in this workspace, or stop. The roles that come and go arrive as events. */
  async useTeam(id: string): Promise<void> {
    await this.conn.request(Teams.use, { id });
  }

  async dropTeam(id: string): Promise<void> {
    await this.conn.request(Teams.drop, { id });
  }

  /** Where the files of one of a role's skills are: the role may be the workspace's own, or a preset team's. */
  async skillDir(role: string, skill: string): Promise<string | undefined> {
    return (await this.conn.request<{ role: RoleDetail }>(Roles.get, { name: role })).role.skills.find((s) => s.name === skill)?.dir;
  }

  /** Start one of the role's saved MCP servers and name its tools. */
  async testMcp(role: string, server: string): Promise<{ tools?: string[]; error?: string }> {
    const { servers } = await this.conn.request<{ servers: McpServerCheck[] }>(Roles.check, { name: role, server });
    return { tools: servers[0].tools?.map((t) => t.name), error: servers[0].error };
  }

  // ---- artifacts --------------------------------------------------------------

  /** A file a tool call names, made showable. Not every path a tool names is a file. */
  private artifact(file: string, agentId: string, name = path.basename(file), assetType?: string): Artifact | undefined {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) return undefined;
    const updatedAt = stat.mtime.toISOString();
    const known = this.artifacts.get(file);
    if (known?.updatedAt === updatedAt) return known;
    const artifact: Artifact = {
      id: file,
      name,
      kind: KINDS[path.extname(file).toLowerCase()] ?? "text",
      agentId,
      path: path.relative(this.paths.project, file),
      // The version in the URL makes the renderer read a changed file again.
      url: `${ARTIFACT_SCHEME}://file/${encodeURIComponent(file)}?v=${stat.mtimeMs}`,
      updatedAt,
      assetType,
    };
    this.artifacts.set(file, artifact);
    this.emit({ artifact });
    return artifact;
  }

  /** A version of an asset of the library: what agents hand to each other. */
  private asset(asset: Asset): void {
    this.artifact(asset.path, asset.by, `${asset.id}${path.extname(asset.path)}`, asset.type);
  }
}
