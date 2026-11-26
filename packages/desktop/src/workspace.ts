import { TerminalViews } from "./terminal-views.ts";
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
import { Answer, Question, RunExt, SessionControls, ToolServers, Workflow, Agents, Assets, Backends, History, Boundaries, Connection, MessageDelivery, Accepted, DeliveredAs, Discarded, Ledger, Redelivered, TurnFailure, LanguageExt, OriginExt, PROTOCOL_VERSION, RpcError, Tasks, failure, isTerminal, elicitationForm, elicitationContent } from "@xsb/protocol";
import type { RunUpdate, HistoryImage, HistoryPage, AgentInfo, Asset, BackendInfo, Boundary, Language, OriginMeta, PermissionRequest, PermissionResponse, SessionUpdate, Task } from "@xsb/protocol";
import type { Activity, Artifact, BackendView, Entry, Event, Snapshot } from "./bridge.ts";
import type { ElicitationRequest, ElicitationResponse } from "@xsb/protocol";
import { append } from "./content.ts";
import type { Content } from "./content.ts";
import { artifactPath } from "./artifact-link.ts";

export const ARTIFACT_SCHEME = "xsb-artifact";

export type DesktopInteractions = {
  url?: (request: import("@xsb/protocol").UrlElicitationRequest, signal: AbortSignal) => Promise<ElicitationResponse>;
  terminal?: (request: import("./terminal-auth.ts").TerminalAuthRequest, signal: AbortSignal) => Promise<{ exitCode: number | null }>;
};
const Auth = { methods: "_dev.xsb/auth/methods", login: "_dev.xsb/auth/login", terminal: "_dev.xsb/auth/terminal" };

type Emit = (event: Event) => void;

/**
 * What the user is told of even when they are not looking (main.ts makes it a notification of the system):
 * the work they set going is over, or went wrong, or waits for them. `detail` is in the words it came in.
 */
export type Notice = { agentId: string; name: string; kind: "done" | "failed" | "confirm" | "permission" | "question"; detail: string };
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
  private markReady!: () => void;
  private ready = new Promise<void>(resolve => { this.markReady = resolve; });
  /** This side closed the connection (`close`): its end is then no news. */
  private left = false;
  /** No window shows this workspace (`setShown`). */
  private hidden = false;
  private workflows = new Map<string, WorkflowView>();
  private agents = new Map<string, AgentInfo>();

  /** The backend of the agent whose main conversation `sessionId` is. */
  backendOf(sessionId: string): string | undefined {
    return [...this.agents.values()].find((agent) => agent.mainSessionId === sessionId)?.backend;
  }
  private agentVersions = new Map<string, number>();
  private tasks = new Map<string, Task>();
  private taskVersions = new Map<string, number>();
  private transcripts = new Map<string, Entry[]>();
  /** Agent id -> its main session, attached to. Where its transcript comes from and its input goes. */
  private mains = new Map<string, Promise<string>>();
  private sessionAgent = new Map<string, string>();
  /** Agent id -> output segments indexed by run and owner (including legacy output without run metadata). */
  private growing = new Map<string, Map<string, Extract<Entry, { kind: "output" }>>>();
  /** Messages that answer or skip a question: the question's card shows them, not a message of their own. */
  private replies = new Set<string>();
  /** The user's messages that were sent but are not yet part of a turn, by id: shown, to be replaced by the hub's echo. */
  private pending = new Set<string>();
  /** Agent id -> what it is doing, while it has a turn running, and the tool calls of it that have not ended. */
  private activities = new Map<string, Activity>();
  private tools = new Map<string, Set<string>>();
  private terminalViews = new TerminalViews();
  private backgroundTools = new Map<string, Set<string>>();
  /** Entry id -> how to answer the permission request it shows. */
  private asking = new Map<string, { agentId: string; entry: Extract<Entry, { kind: "permission" }>; request: PermissionRequest; answer: (r: PermissionResponse) => void }>();
  private seq = 0;
  private nativeQuestions = new Map<string, { agentId: string; form: ReturnType<typeof elicitationForm>; answer: (r: ElicitationResponse) => void }>();
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
  static async open(paths: Paths, env: NodeJS.ProcessEnv, language: Language, say: (e: unknown) => string, emit: Emit, notify: Notify, interactions: DesktopInteractions = {}): Promise<Workspace> {
    if (!fs.existsSync(paths.dir)) initProject(paths);
    // The app's own hub: started for this process and stopped with it (a hub an earlier app left is replaced), with
    // the environment of the app's child processes (`env`, clis.ts): it finds the agents' programs on its PATH.
    const socket = await hubSocket(paths, true, env);
    const conn = new Connection(socket, socket, "hub");
    // Requests may arrive in the same stream chunk as initialize's response.
    const workspace = new Workspace(paths, conn, say, emit, notify, interactions);
    await conn.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      info: { name: "xsb-desktop", version: "0.1.0" },
      // An observer of all agents, and a transcript: sent its own input too, when it gets into the conversation.
      capabilities: { ...(interactions.terminal ? { auth: { terminal: {} } } : {}), session: { promptSuggestions: {}, commands: { skill: {} } }, elicitation: { form: {}, ...(interactions.url ? { url: {} } : {}) }, _meta: { [Agents.capability]: {}, [History.capability]: {}, [SessionControls.capability]: {}, [OriginExt.capability]: {}, [LanguageExt.key]: language } },
    }).catch(error => { workspace.close(); throw error; });
    return workspace;
  }

  private constructor(paths: Paths, conn: Connection, say: (e: unknown) => string, emit: Emit, notify: Notify, interactions: DesktopInteractions = {}) {
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
    conn.onNotification(SessionControls.update, ({agentId, controls}) => {
      if (Array.isArray(controls.background)) this.backgroundTools.set(agentId, new Set(controls.background.map((b: any) => b.toolCallId ?? b.terminalId).filter(Boolean)));
      this.emit({agentId, controls});
    });
    conn.onNotification(Agents.update, (p) => this.onAgent(p.agent));
    conn.onNotification(Agents.removed, (p) => this.onAgentRemoved(p.id));
    conn.onNotification(Assets.update, (p) => this.asset(p.asset));
    conn.onNotification(Assets.removed, ({ ids }: { ids: string[] }) => {
      const removed: string[] = [];
      for (const [id, artifact] of this.artifacts) if (artifact.assetId && ids.includes(artifact.assetId)) { this.artifacts.delete(id); removed.push(id); }
      this.emit({ artifactsRemoved: removed });
    });
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
    conn.onRequest("elicitation/create", (p: ElicitationRequest, ctx) => p.mode === "url"
      ? interactions.url?.(p, ctx.signal) ?? { action: "decline" }
      : this.onElicitation(p, ctx.signal));
    conn.onRequest(Auth.terminal, (p, ctx) => interactions.terminal?.(p, ctx.signal) ?? { exitCode: null });
  }

  get connected(): boolean {
    return !this.conn.isClosed;
  }

  close(): void {
    this.left = true;
    this.markReady();
    for (const pending of this.nativeQuestions.values()) pending.answer({ action: "cancel" });
    this.conn.close();
  }

  /**
   * Whether a window shows this workspace. When none does, the hub runs on and the connection stays, to know when
   * the app quits whether agents are at work here; but nobody is here to be asked anything.
   */
  setShown(shown: boolean): void {
    this.hidden = !shown;
    if (!shown) for (const entryId of [...this.asking.keys()]) this.answer(entryId, "cancelled");
    if (!shown) for (const pending of this.nativeQuestions.values()) pending.answer({ action: "cancel" });
  }

  /** An error in the user's words. One that is only the connection ending says what ended: the hub. */
  private why(e: unknown): string {
    return this.say(this.conn.isClosed ? failure("hub_gone") : e);
  }

  /** With the hub gone nothing runs: no agent is at work any more, and no question of theirs waits for an answer. */
  private onHubGone(emit: Emit): void {
    this.stopped = true;
    this.backgroundTools.clear();
    this.markReady();
    for (const pending of this.nativeQuestions.values()) pending.answer({ action: "cancel" });
    for (const [agentId, entries] of this.transcripts) for (const entry of entries)
      if (entry.kind === "question" && entry.source === "acp" && entry.state === "open") this.put(agentId, { ...entry, state: "cancelled" });
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
    await this.restoreOutbox();
    for (const agentId of this.growing.keys()) this.settle(agentId);
    // What the replayed history ended on is what an agent that is still at work is doing.
    for (const agent of this.agents.values()) if (agent.state === "idle") this.does(agent.id, null);
    this.busy = this.atWork().size > 0;
    this.live = true;
    this.markReady();
    return {
      workspace: { name: path.basename(this.paths.project), path: this.paths.project, id: this.paths.projectId, previousPaths: this.paths.previousRoots },
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
      // What only this window knows of (a message xsb has not recorded yet, or never got) is kept across the rebuild.
      const local = (entry: Entry): boolean => entry.kind === "input" && (entry.unsent || (!!entry.pending && this.pending.has(entry.id.slice(entry.id.indexOf(":") + 1))));
      const pending = (this.transcripts.get(agentId) ?? []).filter((entry) => local(entry) || entry.kind === "permission");
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
  private settle(agentId: string, runId?: string): void {
    const entries = this.growing.get(agentId);
    if (!entries) return;
    for (const [key, entry] of entries) {
      if (runId && entry.run?.id !== runId) continue;
      entries.delete(key);
      this.put(agentId, { ...entry, streaming: false });
    }
    if (!entries.size) this.growing.delete(agentId);
  }

  private finishTools(agentId: string): void {
    const sessionId = this.agents.get(agentId)?.mainSessionId;
    const background = [...(this.backgroundTools.get(agentId) ?? [])];
    for (const entry of this.transcripts.get(agentId) ?? []) {
      const independent = !!sessionId && background.some(id => entry.id === `${sessionId}:${id}` || this.terminalViews.refers(entry.id, sessionId, id));
      if (entry.kind === "tool" && entry.status === "running" && !independent) this.put(agentId, { ...entry, status: "failed" });
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
      if (Array.isArray(update.background)) this.backgroundTools.set(agentId, new Set(update.background.map((b: any) => b.toolCallId ?? b.terminalId).filter(Boolean)));
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
    const run = update._meta?.[RunExt.key] as RunUpdate | undefined;
    const offTurn = run?.turnId === null;
    if (update.sessionUpdate === "session_info_update" && run) {
      if (run.state === "idle") {
        this.settle(agentId, run.id);
        // Mark every segment of this execution, including output before an insertion claimed it.
        for (const entry of this.transcripts.get(agentId) ?? []) {
          if (entry.kind === "output" && entry.run?.id === run.id) this.put(agentId, { ...entry, streaming: false, stopReason: run.stopReason, runOrigin: run.origin });
        }
      } else {
        // An ownership change starts a new segment; it never changes the owner of earlier text.
        const entries = this.growing.get(agentId);
        if (entries) for (const entry of entries.values()) if (entry.run?.id === run.id && entry.run.turnId !== run.turnId) this.settle(agentId, run.id);
      }
      return;
    }
    if (update.sessionUpdate === "agent_thought_chunk") return offTurn || run?.state === "idle" ? undefined : this.does(agentId, "thinking");
    const boundary = update.sessionUpdate === "session_info_update" ? (update._meta?.[Boundaries.key] as Boundary | undefined) : undefined;
    if (boundary) {
      this.settle(agentId);
      return this.put(agentId, { id: this.newId(), kind: "boundary", boundary });
    }
    const info = update.sessionUpdate === "session_info_update" ? update._meta : undefined;
    // A question the agent asked (the `ask` tool): a card, closed by the user's reply, which the card then shows.
    const question = info?.[Question.key] as Question | undefined;
    if (question) {
      const id = `${sessionId}:question:${question.id}`;
      const prior = this.transcripts.get(agentId)?.find((e): e is Extract<Entry, { kind: "question" }> => e.id === id && e.kind === "question");
      if (question.state === "open") {
        this.settle(agentId);
        if (this.live && !this.replaying) this.notify({ agentId, kind: "question", detail: question.questions?.[0]?.question ?? "" });
        return this.put(agentId, { id, kind: "question", questionId: question.id, questions: question.questions ?? [], state: "open", ...(question.source ? { source: question.source } : {}), ...(question.delivery ? { delivery: question.delivery } : {}) });
      }
      if (question.reply && question.state !== "superseded") {
        this.replies.add(question.reply);
        const input = this.inputEntry(agentId, `${sessionId}:${question.reply}`);
        if (input) this.put(agentId, { ...input, reply: true });
      }
      if (prior) this.put(agentId, { ...prior, state: question.state, ...(question.answers ? { answers: question.answers } : {}) });
      return;
    }
    const accepted = info?.[Accepted.key] as Accepted | undefined;
    if (accepted) {
      // xsb has it, and the model not yet: it waits, also after a restart, until it is in or discarded (same id).
      const id = `${sessionId}:${accepted.messageId}`;
      this.pending.delete(accepted.messageId);
      this.unsend(accepted.messageId);
      const prior = this.inputEntry(agentId, id);
      if (prior && !prior.pending && !prior.unsent) return;
      return this.put(agentId, { id, kind: "input", origin: accepted.origin, content: accepted.content, pending: true });
    }
    const delivery = info?.[MessageDelivery.key] as MessageDelivery | undefined;
    if (delivery) {
      const prior = this.inputEntry(agentId, `${sessionId}:${delivery.messageId}`);
      if (prior && prior.pending) this.put(agentId, { ...prior, delivery: delivery.state,
        canCancel: delivery.canCancel, canSendNow: delivery.canSendNow, isQueueHead: delivery.isHead, targetTurnId: delivery.targetTurnId, sendNowBlockedBy: delivery.sendNowBlockedBy });
      return;
    }
    const discarded = info?.[Discarded.key] as Discarded | undefined;
    if (discarded) {
      // The model did not see it: it stays where it was, said so and why; never taken out of the transcript.
      const id = `${sessionId}:${discarded.messageId}`;
      const prior = this.inputEntry(agentId, id);
      this.pending.delete(discarded.messageId);
      if (discarded.resentAs) return prior && this.put(agentId, { ...prior, owed: false, resentAs: discarded.resentAs });
      return this.put(agentId, { id, kind: "input", origin: prior?.origin ?? discarded.origin, content: prior?.content?.length ? prior.content : discarded.content,
        pending: false, unsent: false, discarded: true, reason: discarded.reason ?? prior?.reason ?? "stopped", detail: discarded.detail ?? prior?.detail, owed: !!discarded.owed });
    }
    const redelivered = info?.[Redelivered.key] as Redelivered | undefined;
    if (redelivered) {
      // Owed messages went to the model in front of a later one: the model has them now.
      for (const messageId of redelivered.messageIds) {
        const prior = this.inputEntry(agentId, `${sessionId}:${messageId}`);
        if (prior) this.put(agentId, { ...prior, owed: false, redelivered: true });
      }
      return;
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
      if (!offTurn && run?.state !== "idle") this.does(agentId, "writing");
      const entries = this.growing.get(agentId) ?? new Map<string, Extract<Entry, { kind: "output" }>>();
      const key = run ? JSON.stringify([run.id, run.turnId]) : "legacy";
      const entry = entries.get(key) ?? { id: this.newId(), kind: "output" as const, content: [], streaming: run?.state !== "idle", ...(run ? { run: { id: run.id, turnId: run.turnId } } : {}) };
      entry.content = append(entry.content, update.content);
      if (run?.state === "idle") { entry.streaming = false; entry.stopReason = run.stopReason; entry.runOrigin = run.origin; }
      entries.set(key, entry);
      this.growing.set(agentId, entries);
      return this.put(agentId, { ...entry });
    }
    if (update.sessionUpdate === "user_message_chunk") {
      // A message arrives block by block under one id.
      const id = `${sessionId}:${update.messageId}`;
      const prior = this.inputEntry(agentId, id);
      const deliveredAs = update._meta?.[DeliveredAs.key] as DeliveredAs | undefined;
      // Its first block settles the waiting entry (`Accepted`) into the one the model has; the rest follow it.
      if (prior && !prior.pending && !prior.unsent && !prior.discarded) return this.put(agentId, { ...prior, content: append(prior.content, update.content) });
      if (prior) {
        this.settle(agentId);
        this.does(agentId, "waiting");
        this.pending.delete(update.messageId);
        this.unsend(update.messageId);
        return this.put(agentId, { id, kind: "input", origin: (update._meta?.[OriginExt.key] as OriginMeta | undefined) ?? prior.origin, content: [update.content], ...(deliveredAs ? { deliveredAs } : {}), ...(this.replies.has(update.messageId) ? { reply: true } : {}) });
      }
      // Input marks where a turn begins, or where a message entered the running one: what was said before is complete.
      this.settle(agentId);
      this.does(agentId, "waiting"); // the model has it now, and has not answered yet
      this.pending.delete(update.messageId);
      this.unsend(update.messageId);
      this.put(agentId, { id, kind: "input", origin: (update._meta?.[OriginExt.key] as OriginMeta | undefined) ?? { kind: "user" }, content: [update.content], ...(deliveredAs ? { deliveredAs } : {}), ...(this.replies.has(update.messageId) ? { reply: true } : {}) });
    } else if (update.sessionUpdate === "terminal_update" || update.sessionUpdate === "terminal_output_chunk") {
      for (const id of this.terminalViews.update(sessionId, update)) {
        const tool = this.transcripts.get(agentId)?.find((e): e is Tool & { id: string } => e.kind === "tool" && e.id === id);
        if (tool) this.put(agentId, { ...tool, terminalOutput: this.terminalViews.read(id) });
      }
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.settle(agentId, run?.id);
      const id = `${sessionId}:${update.toolCallId}`;
      const prior = this.transcripts.get(agentId)!.find((e): e is Tool & { id: string } => e.id === id);
      const directory = this.agents.get(agentId)?.workspace ?? this.paths.project;
      const files = (update.locations ?? []).flatMap((location: { path?: string }) => location.path ? [this.artifact(path.resolve(directory, location.path), agentId)] : []);
      const title = update.title ?? prior?.title ?? update.name ?? "";
      const status = TOOL_STATUS[update.status ?? ""] ?? (update.status ? "running" : (prior?.status ?? "running"));
      this.put(agentId, { id, kind: "tool", title, status, artifactId: files.find((a: Artifact | undefined) => a)?.id ?? prior?.artifactId,
        name: update.name ?? prior?.name,
        input: update.input ?? update.rawInput ?? prior?.input,
        output: update.output ?? update.rawOutput ?? update.content ?? prior?.output,
        terminalOutput: this.terminalViews.attach(id, sessionId, update.content) ?? prior?.terminalOutput,
      });
      if (offTurn || run?.state === "idle") return;
      // While any tool call is open the agent is running tools; once the last one ends, its model reads the results.
      const open = this.tools.get(agentId) ?? new Set<string>();
      this.tools.set(agentId, open);
      if (status === "running") open.add(id);
      else open.delete(id);
      if (status === "running") this.does(agentId, "tool", title.replace(/\s+/g, " ").slice(0, 120));
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
  /** `answer`: return a targeted answer/skip through the pending tool, without another user prompt. */
  async send(agentId: string, content: Content, target?: string, again?: { messageId?: string; resendOf?: string }, answer?: Answer): Promise<void> {
    if (answer) {
      const entry = this.transcripts.get(agentId)?.find((e) => e.kind === "question" && e.questionId === answer.questionId);
      if (entry?.kind === "question" && entry.source === "acp") {
        const pending = this.nativeQuestions.get(answer.questionId);
        if (!pending || pending.agentId !== agentId) throw RpcError.notFound("This question has expired");
        const response: ElicitationResponse = answer.skipped ? { action: "decline" }
          : { action: "accept", content: elicitationContent(pending.form, answer.answers ?? []) };
        pending.answer(response);
        return;
      }
      const sessionId = await this.session(this.agents.get(agentId)!);
      await this.conn.request(Answer.submit, { sessionId, answer });
      return;
    }
    for (const pending of this.nativeQuestions.values()) if (pending.agentId === agentId) pending.answer({ action: "cancel" });
    const agent = this.agents.get(agentId)!;
    // One id for the message, kept until xsb has it: sent again under it, it is never a second copy (the hub knows it).
    const messageId = again?.messageId ?? `m_${randomUUID()}`;
    let sessionId: string;
    try {
      sessionId = await this.session(agent);
    } catch (e) {
      const text = this.why(e);
      this.put(agentId, { id: `unsent:${messageId}`, kind: "input", origin: { kind: "user" }, content, discarded: true, unsent: true, reason: "failed", detail: text });
      this.notify({ agentId, kind: "failed", detail: text });
      return;
    }
    const id = `${sessionId}:${messageId}`;
    this.drop(agentId, `unsent:${messageId}`);
    this.pending.add(messageId);
    this.outbox(agentId, messageId, content, again?.resendOf);
    this.put(agentId, { id, kind: "input", origin: { kind: "user" }, content, pending: true });
    // Answered once it is in the conversation. Once xsb has it (`Accepted`), the transcript says what becomes of it:
    // in the conversation, or discarded and why (and whether it is owed to the model with the next message).
    await this.conn.request("session/prompt", { sessionId, prompt: content, _meta: { [OriginExt.key]: { messageId, ...(again?.resendOf ? { resendOf: again.resendOf } : {}) }, [Workflow.target]: target } }).catch((e) => {
      if (!this.pending.delete(messageId)) return;
      // xsb did not take it, or its answer was lost: shown as not delivered, to be sent again under the same id.
      const prior = this.inputEntry(agentId, id);
      this.put(agentId, { id, kind: "input", origin: prior?.origin ?? { kind: "user" }, content: prior?.content ?? content, discarded: true, unsent: true, reason: "failed", detail: this.why(e) });
    });
  }

  /**
   * Send again a message the model did not see. One xsb never had goes again under its own id; one it discarded goes
   * as a message of its own that names it (`resendOf`), so that it is no longer owed and never reaches the model twice.
   */
  async resend(agentId: string, entryId: string): Promise<void> {
    const entry = this.inputEntry(agentId, entryId);
    if (!entry?.discarded || entry.origin.kind !== "user" || entry.redelivered || entry.resentAs) throw new Error("this message cannot be sent again");
    const messageId = entryId.slice(entryId.indexOf(":") + 1);
    if (entry.unsent) {
      const replacement = randomUUID();
      this.put(agentId, { ...entry, resentAs: replacement });
      this.unsend(messageId);
      return this.send(agentId, entry.content, undefined, { messageId: replacement });
    }
    return this.send(agentId, entry.content, undefined, { resendOf: messageId });
  }

  async cancelMessage(agentId: string, entryId: string): Promise<void> {
    const entry = this.inputEntry(agentId, entryId);
    if (!entry?.pending || !entry.canCancel) throw new Error("this message is no longer queued");
    await this.conn.request(MessageDelivery.cancel, { sessionId: await this.session(this.agents.get(agentId)!), messageId: entryId.slice(entryId.indexOf(":") + 1) });
  }

  async sendMessageNow(agentId: string, entryId: string): Promise<void> {
    const entry = this.inputEntry(agentId, entryId);
    if (!entry?.pending || !entry.canSendNow || !entry.targetTurnId) throw new Error("only the queue head can be sent now");
    await this.conn.request(MessageDelivery.sendNow, { sessionId: await this.session(this.agents.get(agentId)!),
      messageId: entryId.slice(entryId.indexOf(":") + 1), targetTurnId: entry.targetTurnId });
  }

  private inputEntry(agentId: string, id: string): Extract<Entry, { kind: "input" }> | undefined {
    return this.transcripts.get(agentId)?.find((e): e is Extract<Entry, { kind: "input" }> => e.id === id && e.kind === "input");
  }

  // ---- the outbox: messages xsb may not have yet --------------------------------

  private get outboxFile(): string {
    return path.join(this.paths.dir, "desktop", "outbox.json");
  }

  private readOutbox(): Record<string, { agentId: string; content: Content; resendOf?: string }> {
    try { return JSON.parse(fs.readFileSync(this.outboxFile, "utf8")) ?? {}; } catch { return {}; }
  }

  private writeOutbox(outbox: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.outboxFile), { recursive: true });
    const temporary = `${this.outboxFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(outbox));
    fs.renameSync(temporary, this.outboxFile);
  }

  /** Kept on disk until xsb has the message: a restart in between still shows it, as not delivered. */
  private outbox(agentId: string, messageId: string, content: Content, resendOf?: string): void {
    this.writeOutbox({ ...this.readOutbox(), [messageId]: { agentId, content, ...(resendOf ? { resendOf } : {}) } });
  }

  private unsend(messageId: string): void {
    const outbox = this.readOutbox();
    if (!(messageId in outbox)) return;
    delete outbox[messageId];
    this.writeOutbox(outbox);
  }

  /** After a restart: what the hub never got is shown as not delivered; what it got, its transcript shows. */
  private async restoreOutbox(): Promise<void> {
    const outbox = this.readOutbox();
    const ids = Object.keys(outbox);
    if (!ids.length) return;
    let states: Record<string, string>;
    try { ({ states } = await this.conn.request<{ states: Record<string, string> }>(Ledger.status, { messageIds: ids })); } catch { return; }
    if (!states) return; // A hub without the query: its transcript is all there is to show.
    for (const [messageId, { agentId, content }] of Object.entries(outbox)) {
      const sessionId = this.agents.get(agentId)?.mainSessionId;
      if (states[messageId] !== "unknown" || !sessionId) { this.unsend(messageId); continue; }
      this.put(agentId, { id: `${sessionId}:${messageId}`, kind: "input", origin: { kind: "user" }, content, discarded: true, unsent: true, reason: "failed" });
    }
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

  private async onElicitation(request: import("@xsb/protocol").FormElicitationRequest, signal: AbortSignal): Promise<ElicitationResponse> {
    if (!this.live) await this.ready;
    if (signal.aborted || this.left || this.conn.isClosed) return { action: "cancel" };
    const agentId = this.sessionAgent.get(request.sessionId);
    if (!agentId || this.hidden) throw RpcError.notFound(`session ${request.sessionId}`);
    const form = elicitationForm(request);
    const questionId = (request._meta?.[Question.key] as { id?: string } | undefined)?.id;
    if (!questionId) throw RpcError.invalidParams("Missing question identity");
    return new Promise((resolve) => {
      let settled = false;
      const answer = (response: ElicitationResponse) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", cancel);
        this.nativeQuestions.delete(questionId);
        resolve(response);
      };
      const cancel = () => answer({ action: "cancel" });
      this.nativeQuestions.set(questionId, { agentId, form, answer });
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }

  authenticationMethods(agentId: string): Promise<import("@xsb/protocol").AuthMethod[]> { return this.conn.request(Auth.methods, { agentId }); }
  authenticate(agentId: string, methodId: string): Promise<unknown> { return this.conn.request(Auth.login, { agentId, methodId }); }

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

  /** The user's title for a conversation, overriding automatic backend titles. */
  async renameConversation(agentId: string, title: string): Promise<AgentInfo> {
    const { agent } = await this.conn.request<{ agent: AgentInfo }>(Agents.set, { agentId, title });
    this.onAgent(agent);
    return agent;
  }

  /** The icon the user chose for a conversation; "" is the default. */
  async setAvatar(agentId: string, avatar: string): Promise<AgentInfo> {
    const { agent } = await this.conn.request<{ agent: AgentInfo }>(Agents.set, { agentId, avatar });
    this.onAgent(agent);
    return agent;
  }

  /** Move a conversation that was never given to its agent program to another backend (the hub refuses one that was). */
  async setBackend(agentId: string, backend: string): Promise<AgentInfo> {
    const { agent } = await this.conn.request<{ agent: AgentInfo }>(Agents.set, { agentId, backend });
    this.onAgent(agent);
    return agent;
  }

  /**
   * Move a conversation its agent program has onto another backend: a new conversation, whose model reads this one
   * as history (`Agents.migrate`). Returns the new conversation.
   */
  async migrate(agentId: string, backend: string): Promise<AgentInfo> {
    const { agent } = await this.conn.request<{ agent: AgentInfo }>(Agents.migrate, { agentId, backend });
    this.onAgent(agent);
    return agent;
  }

  /** Delete a conversation (`Agents.delete`): it leaves the list when the hub says it is removed. Its files stay until `cleanUp`. */
  async deleteConversation(agentId: string): Promise<void> {
    await this.conn.request(Agents.delete, { agentId });
  }

  /** Remove for good what deleted conversations left in `.xsb2/` (`Agents.purge`). */
  cleanUp(): Promise<{ conversations: number; bytes: number }> {
    return this.conn.request(Agents.purge, {});
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
    file = this.paths.resolveStored(file);
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
