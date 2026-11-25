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
import { pathToFileURL } from "node:url";
import path from "node:path";
import { hubSocket, initProject } from "@xsb/hub";
import type { Paths } from "@xsb/hub";
import type { ComposerState, WorkflowView } from "@xsb/protocol";
import { SessionControls, ToolServers, Workflow, Agents, Assets, Backends, History, Boundaries, Connection, Discarded, TurnFailure, LanguageExt, OriginExt, PROTOCOL_VERSION, RpcError, Tasks, failure, isTerminal } from "@xsb/protocol";
import type { HistoryImage, HistoryPage, AgentInfo, Asset, BackendInfo, Boundary, Language, OriginMeta, PermissionRequest, PermissionResponse, SessionUpdate, Task } from "@xsb/protocol";
import type { Activity, Artifact, BackendView, Entry, Event, Snapshot } from "./bridge.ts";
import { append } from "./content.ts";
import type { Content } from "./content.ts";
import { artifactPath } from "./artifact-link.ts";

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
  private workflows = new Map<string, WorkflowView>();
  private agents = new Map<string, AgentInfo>();
  private agentVersions = new Map<string, number>();
  private tasks = new Map<string, Task>();
  private taskVersions = new Map<string, number>();
  private transcripts = new Map<string, Entry[]>();
  /** Agent id -> its main session, attached to. Where its transcript comes from and its input goes. */
  private mains = new Map<string, Promise<string>>();
  private sessionAgent = new Map<string, string>();
  /** Agent id -> the output entry that is still growing. */
  private growing = new Map<string, Extract<Entry, { kind: "output" }>>();
  /** The user's messages that were sent but are not yet part of a turn, by id: shown, to be replaced by the hub's echo. */
  private pending = new Set<string>();
  /** Agent id -> what it is doing, while it has a turn running, and the tool calls of it that have not ended. */
  private activities = new Map<string, Activity>();
  private tools = new Map<string, Set<string>>();
  /** Entry id -> how to answer the permission request it shows. */
  private asking = new Map<string, { agentId: string; entry: Extract<Entry, { kind: "permission" }>; request: PermissionRequest; answer: (r: PermissionResponse) => void }>();
  private seq = 0;
  private replaying = false;
  private historyUpdates = new Map<string, SessionUpdate[]>();
  private historyCursors = new Map<string, number | null>();
  private historyLoading = new Map<string, Promise<{ entries: Entry[]; cursor: number | null }>>();
  private historyImages = new Set<string>();
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
    // The app's own hub: started for this process and stopped with it (a hub an earlier app left is replaced).
    const socket = await hubSocket(paths, true);
    const conn = new Connection(socket, socket, "hub");
    await conn.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      info: { name: "xsb-desktop", version: "0.1.0" },
      // An observer of all agents, and a transcript: sent its own input too, when it gets into the conversation.
      capabilities: { _meta: { [Agents.capability]: {}, [History.capability]: {}, [SessionControls.capability]: {}, [OriginExt.capability]: {}, [LanguageExt.key]: language } },
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
      if (this.live && !this.replaying) emit(event);
    };
    // The hub stopped, or died: the window says so, whatever it is in the middle of. Not when it was this side that left.
    void conn.closed.then(() => this.left || this.onHubGone(emit));
    conn.onNotification("session/update", (p) => this.onUpdate(p.sessionId, p.update));
    conn.onNotification(SessionControls.update, ({agentId, controls}) => this.emit({agentId, controls}));
    conn.onNotification(Agents.update, (p) => this.onAgent(p.agent));
    conn.onNotification(Agents.removed, (p) => this.onAgentRemoved(p.id));
    conn.onNotification(Assets.update, (p) => this.asset(p.asset));
    conn.onNotification(Workflow.update, ({ workflow }: { workflow: WorkflowView }) => {
      this.workflows.set(workflow.sessionId,workflow);
      this.emit({workflow});
    });
    conn.onNotification(Tasks.update, (p) => this.onTask(p.task));
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
      if (!isTerminal(task.status) && this.agents.has(task.to.agentId)) busy.add(task.to.agentId);
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

  sessionOwner(agentId: string): string | undefined {
    const agent = this.agents.get(agentId);
    return agent?.workflowOwner ?? agent?.mainSessionId;
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
    // Keep updates received while these requests are pending. Notifications run synchronously;
    // a response's promise may run later even when the response came first in the same chunk.
    const agentVersions = new Map(this.agentVersions);
    const taskVersions = new Map(this.taskVersions);
    const unchanged = (versions: Map<string, number>, before: Map<string, number>, id: string): boolean =>
      (versions.get(id) ?? 0) === (before.get(id) ?? 0);
    const priorFlows = new Map(this.workflows);
    const [, , , { assets }] = await Promise.all([
      this.conn.request<{ workflows: WorkflowView[] }>(Workflow.list).then(({workflows}) => {
        for (const flow of workflows) if (priorFlows.get(flow.sessionId) === this.workflows.get(flow.sessionId)) this.workflows.set(flow.sessionId,flow);
      }),
      this.conn.request<{ agents: AgentInfo[] }>(Agents.list).then(({ agents }) => {
        const ids = new Set(agents.map(agent => agent.id));
        for (const id of this.agents.keys()) if (!ids.has(id) && unchanged(this.agentVersions, agentVersions, id)) this.onAgentRemoved(id);
        for (const agent of agents) if (unchanged(this.agentVersions, agentVersions, agent.id)) this.onAgent(agent);
      }),
      this.conn.request<{ tasks: Task[] }>(Tasks.list, {}).then(({ tasks }) => {
        const next = new Map(tasks.map(task => [task.id, task]));
        for (const [id, task] of this.tasks) if (!unchanged(this.taskVersions, taskVersions, id)) next.set(id, task);
        this.tasks = next;
      }),
      this.conn.request<{ assets: Asset[] }>(Assets.list, { history:true }),
    ]);
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
      agents: [...this.agents.values()],
      tasks: [...this.tasks.values()],
      artifacts: [...this.artifacts.values()],
      assetNames: {}, workflows:Object.fromEntries(this.workflows),
      transcripts: Object.fromEntries(this.transcripts),
      activities: Object.fromEntries(this.activities),
      history: Object.fromEntries(this.historyCursors),
    };
  }

  /** The backends of this machine, as the hub that starts them sees them now. */
  async backends(): Promise<BackendView[]> {
    const { backends } = await this.conn.request<{ backends: BackendInfo[] }>(Backends.list);
    return backends.map((b) => ({ name: b.name, command: [b.command, ...b.args].join(" "), installed: b.installed }));
  }

  // ---- agents and their transcripts -------------------------------------------

  private onAgent(agent: AgentInfo): void {
    this.agentVersions.set(agent.id, (this.agentVersions.get(agent.id) ?? 0) + 1);
    this.agents.set(agent.id, agent);
    if (!this.transcripts.has(agent.id)) this.transcripts.set(agent.id, []);
    // A history that cannot be read is said so, where it would have been shown.
    const failed = (e: unknown): void => this.put(agent.id, { id: this.newId(), kind: "error", text: this.why(e) });
    if (agent.mainSessionId && !this.mains.has(agent.id)) this.session(agent).catch(failed);
    if (agent.state === "idle") {
      this.settle(agent.id);
      this.does(agent.id, null);
      this.finishTools(agent.id);
    } else if (!this.activities.has(agent.id)) {
      this.does(agent.id, "waiting"); // a turn began: nothing has come back yet
    }
    this.emit({ agent });
    this.watch(agent.id);
  }

  private onTask(task: Task): void {
    this.taskVersions.set(task.id, (this.taskVersions.get(task.id) ?? 0) + 1);
    const agentId = task.to.agentId;
    if (task.status === "failed" && this.tasks.get(task.id)?.status !== "failed") this.notify({ agentId, kind: "failed", detail: task.title });
    this.tasks.set(task.id, task);
    this.emit({ task });
    this.watch(agentId);
  }

  private onAgentRemoved(id: string): void {
    // Invalidate a pending history page too: it must not restore a removed agent.
    this.agentVersions.set(id, (this.agentVersions.get(id) ?? 0) + 1);
    for (const [sessionId, agentId] of this.sessionAgent) if (agentId === id) this.sessionAgent.delete(sessionId);
    for (const perAgent of [this.agents, this.transcripts, this.mains, this.growing, this.activities, this.tools, this.historyUpdates, this.historyCursors]) perAgent.delete(id);
    this.emit({ removedAgent: id });
    this.busy = this.atWork().size > 0;
  }

  /** The agent's main session with this client attached, created if the agent has none. */
  private session(agent: AgentInfo): Promise<string> {
    let session = this.mains.get(agent.id);
    if (!session) {
      const setup = { cwd: agent.workspace, mcpServers: [] };
      if (agent.mainSessionId) {
        // The first page attaches atomically; subsequent live updates may arrive before its promise resolves.
        this.sessionAgent.set(agent.mainSessionId, agent.id);
        this.historyUpdates.set(agent.id, []);
        const version = this.agentVersions.get(agent.id);
        session = Promise.resolve().then(() => this.conn.request<HistoryPage>(History.page, { sessionId: agent.mainSessionId })).then((page) => {
          this.historyUpdates.set(agent.id, [...page.updates, ...(this.historyUpdates.get(agent.id) ?? [])]);
          this.historyCursors.set(agent.id, page.cursor);
          this.rebuildHistory(agent.id);
          if (this.agentVersions.get(agent.id) === version) this.onAgent(page.agent);
          return agent.mainSessionId!;
        });
      } else {
        throw Error("This agent has no started session");
      }
      this.mains.set(agent.id, session);
      session.catch(() => this.mains.delete(agent.id));
    }
    return session;
  }

  /** Show an entry of an agent's transcript, in place of the one with its id if there is one. Nothing, once the agent is gone. */
  private imageReferences(update: SessionUpdate): SessionUpdate {
    const content = (block: any) => {
      const ref = block?._meta?.[History.imageKey] as HistoryImage | undefined;
      if (!ref) return block;
      const key = JSON.stringify(ref);
      this.historyImages.add(key);
      return { ...block, url: `${ARTIFACT_SCHEME}://history/image?workspace=${encodeURIComponent(this.paths.project)}&ref=${encodeURIComponent(key)}` };
    };
    const discarded = update._meta?.[Discarded.key] as Discarded | undefined;
    if (discarded) return { ...update, _meta: { ...update._meta, [Discarded.key]: { ...discarded, content: discarded.content.map(content) } } };
    return update.content ? { ...update, content: content(update.content) } : update;
  }

  async historyImage(key: string): Promise<{ data: string; mimeType: string }> {
    if (!this.historyImages.has(key)) throw new Error("unknown history image");
    return this.conn.request(History.image, JSON.parse(key));
  }

  private rebuildHistory(agentId: string): void {
    this.transcripts.set(agentId, []);
    this.growing.delete(agentId);
    this.replaying = true;
    try {
      const sessionId = this.agents.get(agentId)?.mainSessionId;
      if (sessionId) for (const update of this.historyUpdates.get(agentId) ?? []) this.onUpdate(sessionId, update);
      if (this.agents.get(agentId)?.state === "idle") {
        this.settle(agentId);
        this.finishTools(agentId);
      }
    } finally { this.replaying = false; }
  }

  /** Prepend one older page; concurrent clicks share the same request. */
  history(agentId: string): Promise<{ entries: Entry[]; cursor: number | null }> {
    const prior = this.historyLoading.get(agentId);
    if (prior) return prior;
    const cursor = this.historyCursors.get(agentId) ?? null;
    const sessionId = this.agents.get(agentId)?.mainSessionId;
    if (cursor === null || !sessionId) return Promise.resolve({ entries: this.transcripts.get(agentId) ?? [], cursor: null });
    const loading = this.conn.request<HistoryPage>(History.page, { sessionId, before: cursor }).then((page) => {
      this.historyUpdates.set(agentId, [...page.updates, ...(this.historyUpdates.get(agentId) ?? [])]);
      this.historyCursors.set(agentId, page.cursor);
      const pending = (this.transcripts.get(agentId) ?? []).filter((entry) => this.pending.has(entry.id) || entry.kind === "permission");
      this.rebuildHistory(agentId);
      pending.forEach((entry) => this.put(agentId, entry));
      return { entries: this.transcripts.get(agentId) ?? [], cursor: page.cursor };
    }).finally(() => this.historyLoading.delete(agentId));
    this.historyLoading.set(agentId, loading);
    return loading;
  }

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

  /** The agent's output so far is complete: whatever comes next starts a new entry. */
  private settle(agentId: string): void {
    const entry = this.growing.get(agentId);
    if (!entry) return;
    this.growing.delete(agentId);
    this.put(agentId, { ...entry, streaming: false });
  }

  private finishTools(agentId: string): void {
    for (const entry of this.transcripts.get(agentId) ?? []) {
      if (entry.kind === "tool" && entry.status === "running") this.put(agentId, { ...entry, status: "failed" });
    }
  }

  /** Note what an agent is doing, when that is news. `null`: its turn is over. */
  private does(agentId: string, kind: Activity["kind"] | null, detail?: string): void {
    if (this.replaying) return;
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
    if (!this.replaying) this.historyUpdates.get(agentId)?.push(update);
    if (update.sessionUpdate === "state_update") {
      if (this.replaying) return;
      const agent = this.agents.get(agentId);
      if (update.state === "idle") {
        this.settle(agentId);
        this.does(agentId, null);
        this.finishTools(agentId);
        for (const [entryId, asked] of this.asking) if (asked.agentId === agentId) this.answer(entryId, "cancelled");
      }
      if (agent && ["idle", "running", "requires_action"].includes(update.state)) this.onAgent({ ...agent, state: update.state });
      return;
    }
    update = this.imageReferences(update);
    if (update.sessionUpdate === "agent_thought_chunk") return this.does(agentId, "thinking");
    const boundary = update.sessionUpdate === "session_info_update" ? (update._meta?.[Boundaries.key] as Boundary | undefined) : undefined;
    if (boundary) {
      this.settle(agentId);
      return this.put(agentId, { id: this.newId(), kind: "boundary", boundary });
    }
    const discarded = update.sessionUpdate === "session_info_update" ? (update._meta?.[Discarded.key] as Discarded | undefined) : undefined;
    if (discarded) {
      // The turn it was for was stopped before the model saw it: shown where it was, or, if it waited for its turn, where the stop was.
      const id = `${sessionId}:${discarded.messageId}`;
      const prior = this.transcripts.get(agentId)!.find((e): e is Extract<Entry, { kind: "input" }> => e.id === id);
      if (this.pending.delete(discarded.messageId)) this.drop(agentId, discarded.messageId);
      return this.put(agentId, { id, kind: "input", origin: prior?.origin ?? discarded.origin, content: prior?.content ?? discarded.content, discarded: true });
    }
    const failed = update.sessionUpdate === "session_info_update" ? (update._meta?.[TurnFailure.key] as { message: string; data?: unknown } | undefined) : undefined;
    if (failed) {
      this.does(agentId, null);
      // A turn that a task or a message started failed: nobody else would hear of it.
      this.settle(agentId);
      const text = this.say(new RpcError(-32603, failed.message, failed.data));
      this.put(agentId, { id: this.newId(), kind: "error", text });
      if (this.live && !this.replaying) this.notify({ agentId, kind: "failed", detail: text });
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
    } else if (update.sessionUpdate === "tool_call_update") {
      this.settle(agentId);
      const id = `${sessionId}:${update.toolCallId}`;
      const prior = this.transcripts.get(agentId)!.find((e): e is Tool & { id: string } => e.id === id);
      const directory = this.agents.get(agentId)?.workspace ?? this.paths.project;
      const files = (update.locations ?? []).flatMap((location: { path?: string }) => location.path ? [this.artifact(path.resolve(directory, location.path), agentId)] : []);
      const title = update.title ?? prior?.title ?? update.toolCallId;
      const status = TOOL_STATUS[update.status ?? ""] ?? (update.status ? "running" : (prior?.status ?? "running"));
      this.put(agentId, { id, kind: "tool", title, status, artifactId: files.find((a: Artifact | undefined) => a)?.id ?? prior?.artifactId });
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
   * Say something to the agent. The user's word never waits: the hub starts a
   * turn with it, or puts it into the one that is running. The message shows
   * at once; the hub sends it back under the same id when it has become part
   * of a turn, and that entry takes the place of this one.
   */
  async send(agentId: string, content: Content, target?: string): Promise<void> {
    const agent = this.agents.get(agentId)!;
    const id = `m_${randomUUID()}`;
    const entry = { id, kind: "input" as const, origin: { kind: "user" as const }, content, pending: true };
    this.pending.add(id);
    this.put(agentId, entry);
    let sessionId: string;
    try {
      sessionId = await this.session(agent);
    } catch (e) {
      this.pending.delete(id);
      const text = this.why(e);
      this.put(agentId, { id: this.newId(), kind: "error", text });
      this.notify({ agentId, kind: "failed", detail: text });
      this.drop(agentId, id);
      throw e;
    }
    // Answered once it is in the conversation. If it never gets there, the transcript says why: it records the
    // message as discarded, and a turn that failed as failed (`TurnFailure`).
    await this.conn.request("session/prompt", { sessionId, prompt: content, _meta: { [OriginExt.key]: { messageId: id }, [Workflow.target]:target } }).catch(e => {
      if (this.pending.delete(id)) {
        this.drop(agentId,id);
        this.put(agentId,{ id:this.newId(),kind:"error",text:this.why(e) });
        throw e;
      }
    });
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
      detail: request.title || request.subject?.toolCall?.title || request.subject?.toolCall?.toolCallId || "",
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

  async newSession(backend?: string, title?: string): Promise<AgentInfo> {
    const result = await this.conn.request("session/new",{title,_meta:{[Workflow.backend]:backend}});
    return this.agents.get(result._meta[Agents.sessionKey])!;
  }

  /** The user's tool servers changed: conversations take them by resuming their backend session in a new process. */
  applyTools(): Promise<{ waiting: number }> {
    return this.conn.request(ToolServers.apply, {});
  }

  /** The icon the user chose for a conversation; "" is the default. */
  async setAvatar(agentId: string, avatar: string): Promise<AgentInfo> {
    const { agent } = await this.conn.request<{ agent: AgentInfo }>(Agents.set, { agentId, avatar });
    this.onAgent(agent);
    return agent;
  }

  /** Move a conversation to another backend; its next turn is handed the conversation (`backend_changed`). */
  async setBackend(agentId: string, backend: string): Promise<AgentInfo> {
    const { agent } = await this.conn.request<{ agent: AgentInfo }>(Agents.set, { agentId, backend });
    this.onAgent(agent);
    return agent;
  }

  async composerState(agentId: string, discover = false): Promise<ComposerState> {
    const sessionId = await this.session(this.agents.get(agentId)!);
    return this.conn.request(SessionControls.get, { sessionId, discover });
  }

  async setComposerOption(agentId: string, configId: string, value: string) {
    const sessionId = await this.session(this.agents.get(agentId)!);
    await this.conn.request("session/set_config_option", { sessionId, configId, type: "id", value });
    return this.conn.request<ComposerState>(SessionControls.get, { sessionId });
  }

  workflowControl(id: string, pause: boolean, nodes?: string[]) {
    return this.conn.request(pause ? Workflow.pause : Workflow.resume,{sessionId:id,nodes});
  }

  // ---- artifacts --------------------------------------------------------------

  /** A file explicitly clicked in the transcript or another document. */
  openArtifact(href: string, agentId?: string, baseFile?: string): Artifact {
    if (baseFile && !this.artifacts.has(baseFile)) throw new Error("unknown source document");
    const agent = agentId ? this.agents.get(agentId) : undefined;
    const directory = baseFile ? path.dirname(baseFile) : agent?.workspace || this.paths.project;
    let file = artifactPath(href, directory);
    // Project-relative links also occur when the agent has its own working directory.
    if (!baseFile && !fs.existsSync(file)) file = artifactPath(href, this.paths.project);
    const artifact = this.artifact(file, agentId ?? "");
    if (!artifact) throw new Error(`file not found: ${href}`);
    return artifact;
  }

  /** A file a tool call names, made showable. Not every path a tool names is a file. */
  private artifact(file: string, agentId: string, name = path.basename(file), assetType?: string, asset?: Asset): Artifact | undefined {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) return undefined;
    const updatedAt = stat.mtime.toISOString();
    const known = this.artifacts.get(file);
    const owner = asset?.sessionId ?? this.sessionOwner(agentId);
    const sessionIds = new Set(known?.sessionIds);
    if (owner) sessionIds.add(owner);
    if (known?.updatedAt === updatedAt && (!asset || known.assetId === asset.id) && sessionIds.size === known.sessionIds?.length) return known;
    const artifact: Artifact = {
      id: file,
      name: asset ? name : known?.name ?? name,
      sessionIds: [...sessionIds],
      fileUri: pathToFileURL(file).href,
      kind: KINDS[path.extname(file).toLowerCase()] ?? "text",
      agentId: asset ? agentId : known?.agentId ?? agentId,
      path: path.relative(this.paths.project, file),
      // The version in the URL makes the renderer read a changed file again.
      url: `${ARTIFACT_SCHEME}://file/${encodeURIComponent(file)}?v=${stat.mtimeMs}`,
      updatedAt,
      assetType: assetType ?? known?.assetType,
      ...(known?.assetId ? { assetId: known.assetId, assetVersion: known.assetVersion, registeredName: known.registeredName, description: known.description } : {}),
      ...(asset ? { assetId: asset.id, assetVersion: asset.version, registeredName: asset.name, description: asset.description } : {}),
    };
    this.artifacts.set(file, artifact);
    this.emit({ artifact });
    return artifact;
  }

  /** A version of an asset of the library: what agents hand to each other. */
  private asset(asset: Asset): void {
    this.artifact(asset.path, asset.by, `${asset.name}${path.extname(asset.path)}`, asset.type, asset);
  }
}
