/**
 * Hub state: a fold over the event logs.
 *
 * `apply` is the only code that changes state. Loading replays every record
 * through it; a live change is `commit(ops)`, which writes the records (under
 * the WAL when there are several) and then applies the same records. What is
 * in memory is therefore always what a restart would rebuild.
 */
import type { Flow } from "./workflow-state.ts";
import type { Addr, AgentSpec, Asset, ContentBlock, McpServer, DeliveryPref, LedgerEntry, Origin, Task } from "@xsb/protocol";
import type { Op, Record_, Store } from "@xsb/store";
import { Paths } from "./paths.ts";
import { addEdges } from "./task-graph.ts";
import type { Graph } from "./task-graph.ts";
import path from "node:path";

export type SessionRec = {
  id: string;
  agentId: string;
  /** Exact standing prefix of a task conversation, pinned before its first backend bind. */
  workflowPrompt?: string;
  /** The user renamed this conversation; backend-generated titles no longer replace it. */
  titleEdited?: boolean;
  /** The backend's own session id, once one exists. */
  backendSessionId?: string;
  /** Physical cwd of the saved backend binding; a relocation must never resume its old paths. */
  backendWorkspace?: string;
  /**
   * The backend session has been given nothing yet (a new conversation's, opened for its settings, or one just
   * renewed). A backend may keep no such session (codex writes one at its first prompt), so failing to resume it loses
   * nothing to hand over.
   */
  backendFresh?: boolean;
  /**
   * The conversation has records: something was given to its model. Until then its backend changes in place; from
   * then on switching moves it to a new conversation (`Agents.migrate`). Never unset: clearing the context keeps them.
   * New conversations start with `false`; only records written before it existed lack it.
   */
  conversed?: boolean;
  /**
   * The agent's conversation: the one session the user, its peers and xsb all talk to it in, and the one it does all
   * its work in, one turn at a time. One per agent. Other sessions are a client's own (`session/new`).
   */
  main: boolean;
  /** The backend the backend session belongs to: one of another backend cannot be restored in this one. */
  backend?: string;
  /**
   * The conversation grew past `limits.sessionTokens`: its next turn starts a new backend session, handed the
   * conversation so far (session.ts, `renewed`). The session stays the same.
   */
  renew?: boolean | "stopped" | "isolated" | "project_moved";
  /** How much of the backend's context window the conversation used at the end of its last turn, in tokens. */
  used?: number;
  /** Backend window and conservative renewal point, scoped to this conversation/backend. */
  contextSize?: number;
  contextRenewAt?: number;
  contextEpoch?: number;
  /** The question the agent asked the user and waits a reply to (questions.ts). */
  question?: string;
  /** Written before replacing a refused backend. Unacknowledged mail supplies the durable input. */
  contextRecovery?: { messageId: string; attempts: number };
  /** Successful user-selected ACP options survive a context renewal on the same backend. */
  clientMcp?: McpServer[];
  workflowModel?: {configId:string; baseline?:string};
  selectedConfig?: Record<string, string>;
  /** Immutable handoff checkpoint. New checkpoints reference prior epochs instead of reloading all history. */
  contextCheckpoint?: string;
  /** Resend the quoted handoff on resume until the new backend confirms its first input. */
  contextHandoffPending?: string;
  /**
   * The user's messages that failed to get to the model (not stopped): given in front of the user's next message until
   * one is in the conversation (session.ts, `owe`). Their content is in the agent's context folder, `owed-<id>.json`.
   */
  owed?: string[];
  /** The latest owed messages that did get to the model with a later one: a resend of them is refused. */
  redelivered?: string[];
  /**
   * This conversation continues another, moved here when the user switched backends (`Agents.migrate`): its record,
   * frozen at the move, is the context file `ref` of this agent, read with the `previous_conversation` tool.
   * `pending`: the model has not been told yet; it is, in front of the first message, until that is in.
   */
  migratedFrom?: { agentId: string; sessionId: string; title: string; backend: string; ref: string; pending?: boolean };
  /** An interrupted input with observed execution must not be blindly replayed after a hub restart. */
  contextExecution?: { messageId: string };
  title?: string;
  /** Incremented by a user stop: results of earlier work are retained without waking this session. */
  workGeneration?: number;
  createdAt: string;
  updatedAt: string;
};

/** Whether the conversation has records. Records written before `conversed` existed: a backend session given input. */
export const conversed = (rec: SessionRec): boolean => rec.conversed ?? (!!rec.contextEpoch && !rec.backendFresh);

/** The results of some tasks, handed over together. */
export type Results = {
  taskIds: string[];
  mode?: "all" | "any";
  /** The owner's own reminder of what to do, or what to check, once the results are in. */
  note?: string;
};

/** A join: hold the results of `taskIds` and hand them over together. */
export type Gate = {
  id: string;
  owner: Addr;
  taskIds: string[];
  mode: "all" | "any";
  note?: string;
  createdAt: string;
  workGeneration?: number;
};

export type MailItem = {
  workflowNotice?: boolean;
  workflowHeld?: boolean;
  invitation?: string;
  id: string;
  to: Addr;
  from: Origin;
  /** A chat message, a task given to its executor, or the results of tasks (a notification to their initiator). */
  kind: "message" | "task" | "results";
  topic?: string;
  /** Of a message. */
  content?: string;
  /** Of a task: which. */
  taskId?: string;
  /** Of results: whose they are. With `mode`, they answer a join; without, it is one task's own result. */
  results?: Results;
  /** What the user said, as they said it (a task of theirs, or more on it). */
  prompt?: ContentBlock[];
  /** Of xsb's word on work the recipient has open: it goes into the running turn (kernel.ts, `deliveryPolicy`). */
  steer?: boolean;
  /** An explicit append belongs only to this turn, never to a later one. */
  targetTurnId?: string;
  /** How it is to reach its recipient (kernel.ts, `deliveryPolicy`). Absent: `wake`. */
  pref?: DeliveryPref;
  /** The recipient's generation when this result was requested. */
  workGeneration?: number;
  ts: string;
};

export type Note = { topic: string; content: string; peers: string[]; updatedAt: string };

export type TopicPeer = { count: number; lastAt: string };

export const topicKey = (topic: string): string => topic.trim().toLowerCase();

export const F = {
  workflows: "conversations/workflows.jsonl",
  agents: "conversations/agents.jsonl",
  sessions: "conversations/sessions.jsonl",
  tasks: "conversations/tasks.jsonl",
  gates: "conversations/gates.jsonl",
  mailbox: "conversations/mailbox.jsonl",
  ledger: "conversations/ledger.jsonl",
  assets: "conversations/assets.jsonl",
  topics: "conversations/topics.jsonl",
} as const;

export const ops = {
  workflow: (flow: Flow): Op => ({ file: F.workflows, rec: { flow } }),
  putAgent: (agent: AgentSpec): Op => ({ file: F.agents, rec: { op: "put", agent } }),
  removeAgent: (id: string): Op => ({ file: F.agents, rec: { op: "remove", id } }),
  putSession: (session: SessionRec): Op => ({ file: F.sessions, rec: { op: "put", session } }),
  putTask: (task: Task): Op => ({ file: F.tasks, rec: { op: "put", task } }),
  openGate: (gate: Gate): Op => ({ file: F.gates, rec: { op: "open", gate } }),
  closeGate: (id: string): Op => ({ file: F.gates, rec: { op: "close", id } }),
  enqueue: (item: MailItem): Op => ({ file: F.mailbox, rec: { op: "enqueue", item } }),
  ack: (id: string): Op => ({ file: F.mailbox, rec: { op: "ack", id } }),
  mark: (entry: LedgerEntry): Op => ({ file: F.ledger, rec: { op: "mark", entry } }),
  assetPointer: (id:string,version:string|null):Op => ({file:F.assets,rec:{op:"pointer",id,version}}),
  putAsset: (asset: Asset): Op => ({ file: F.assets, rec: { op: "put", asset } }),
  putNote: (agentId: string, note: Note): Op => ({ file: Paths.memory(agentId), rec: { op: "put", note } }),
  removeNote: (agentId: string, topic: string): Op => ({ file: Paths.memory(agentId), rec: { op: "remove", topic } }),
};

export class State {
  readonly store: Store;
  assetPointers = new Map<string,string|null>();
  workflows = new Map<string, Flow>();
  agents = new Map<string, AgentSpec>();
  sessions = new Map<string, SessionRec>();
  tasks = new Map<string, Task>();
  gates = new Map<string, Gate>();
  /** Mail not yet acknowledged, in arrival order: the inboxes of all sessions. */
  mail = new Map<string, MailItem>();
  /** Message id -> what became of it, last word (ext.ts, `LedgerState`). */
  ledger = new Map<string, LedgerEntry>();
  /** Asset id -> its versions, oldest first. */
  assets = new Map<string, Asset[]>();
  /** agent -> topic key -> note. Maintained by the agent itself. */
  notes = new Map<string, Map<string, Note>>();
  /**
   * agent -> topic key -> peer -> how often. Maintained by the hub from the
   * mail that actually flowed, so it is right even if an agent forgets to take
   * notes. This is what keeps a topic with the peer who already handled it.
   */
  topics = new Map<string, Map<string, { topic: string; peers: Map<string, TopicPeer> }>>();
  /** The edges between tasks, reversed (task-graph.ts): task -> the tasks started for it, and those that wait for it (`after`). */
  graph: Graph = { children: new Map(), waiters: new Map() };
  private transaction?: { operations: Op[]; stored: Op[]; effects: (() => void)[] };
  private writtenBytes = 0;
  private paths?: Paths;
  private loading = false;
  onMaintenanceNeeded?: () => void;

  private tables() {
    return { agents: this.agents, sessions: this.sessions, tasks: this.tasks, gates: this.gates, mail: this.mail,
      ledger: this.ledger, assets: this.assets, assetPointers: this.assetPointers, workflows: this.workflows,
      notes: this.notes, topics: this.topics, graph: this.graph, mainIds: this.mainIds };
  }

  /** Plan against isolated tables, commit once, and run effects only after publishing the committed state. */
  atomic<T>(action: () => T): T {
    if (this.transaction) return action();
    const original = this.tables();
    Object.assign(this, structuredClone(original));
    const transaction = this.transaction = { operations: [] as Op[], stored: [] as Op[], effects: [] as (() => void)[] };
    let result: T;
    try {
      result = action();
      this.store.tx(transaction.stored);
    } catch (error) {
      Object.assign(this, original);
      this.transaction = undefined;
      throw error;
    }
    Object.assign(this, original);
    this.transaction = undefined;
    for (const op of transaction.operations) this.apply(op.file, op.rec);
    this.account(transaction.stored);
    for (const effect of transaction.effects) effect();
    return result;
  }

  afterCommit(effect: () => void): void {
    if (this.transaction) this.transaction.effects.push(effect);
    else effect();
  }

  private account(list: Op[]): void {
    this.writtenBytes += list.reduce((sum, op) => sum + Buffer.byteLength(JSON.stringify(op.rec)), 0);
    if (this.writtenBytes > 64 * 1024 * 1024) this.onMaintenanceNeeded?.();
  }

  compact(): void {
    if (this.transaction) throw new Error("Cannot compact an uncommitted state");
    const logs: Record<string, Record_[]> = {
      [F.agents]: [...this.agents.values()].map(agent => ({ op: "put", agent })),
      [F.sessions]: [...this.sessions.values()].map(session => ({ op: "put", session })),
      [F.tasks]: [...this.tasks.values()].map(task => ({ op: "put", task })),
      [F.gates]: [...this.gates.values()].map(gate => ({ op: "open", gate })),
      [F.mailbox]: [...this.mail.values()].map(item => ({ op: "enqueue", item, topicCounted: true })),
      [F.ledger]: [...this.ledger.values()].map(entry => ({ op: "mark", entry })),
      [F.workflows]: [...this.workflows.values()].map(flow => ({ flow })),
      [F.assets]: [...this.assets].flatMap(([id, versions]) => [...versions.map(asset => ({ op: "put", asset })), { op: "pointer", id, version: this.assetPointers.get(id) ?? null }]),
      [F.topics]: [{ topics: [...this.topics].map(([id, topics]) => [id, [...topics].map(([key, entry]) => [key, { ...entry, peers: [...entry.peers] }])]) }],
    };
    for (const [file, recs] of Object.entries(logs)) logs[file] = recs.map(rec => this.persisted({ file, rec }, true).rec);
    this.store.compact(logs);
    this.writtenBytes = 0;
  }

  constructor(store: Store, paths?: Paths) {
    this.store = store;
    const root = store.filePath("");
    this.paths = paths ?? (path.basename(root) === ".xsb2" ? new Paths(path.dirname(root)) : undefined);
  }

  load(): void {
    this.loading = true;
    try {
      this.store.recover();
      for (const rec of this.store.read(F.topics)) this.apply(F.topics, rec);
      for (const file of [F.agents, F.sessions, F.tasks, F.gates, F.mailbox, F.ledger, F.assets, F.workflows]) {
        for (const rec of this.store.read(file)) this.apply(file, rec);
      }
      for (const id of this.agents.keys()) {
        const file = Paths.memory(id);
        const recs = this.store.read(file);
        for (const rec of recs) this.apply(file, rec);
        // Notes are rewritten in place, so the log is mostly superseded lines.
        const live = [...(this.notes.get(id)?.values() ?? [])];
        if (recs.length > 4 * live.length + 64) {
          this.store.rewrite(file, live.map((note) => ({ op: "put", note })));
        }
      }
      this.writtenBytes = Object.values(F).reduce((sum, file) => sum + this.store.deltaBytes(file), 0);
    } finally { this.loading = false; }
  }

  /**
   * Forget agents for good (a deleted conversation, cleaned up): their agents, sessions, the workflows those sessions
   * own, notes, and assets only they made. Each file they appear in is rewritten without them, so the space comes back.
   * Returns the assets dropped, whose files the caller removes. Tasks, mail and ledger entries are small and stay.
   */
  forget(agentIds: Set<string>): Asset[] {
    const original = this.tables();
    Object.assign(this, structuredClone(original));
    try {
      const sessions = new Set([...this.sessions.values()].filter((s) => agentIds.has(s.agentId)).map((s) => s.id));
      for (const id of agentIds) {
        this.agents.delete(id);
        this.mainIds.delete(id);
        this.notes.delete(id);
        this.topics.delete(id);
      }
      for (const id of sessions) {
        this.sessions.delete(id);
        this.workflows.delete(id);
      }
      const dropped: Asset[] = [];
      for (const [id, versions] of this.assets) {
        if (!versions.every((v) => agentIds.has(v.by))) continue;
        dropped.push(...versions);
        this.assets.delete(id);
        this.assetPointers.delete(id);
      }
      this.compact();
      return dropped;
    } catch (error) { Object.assign(this, original); throw error; }
  }

  commit(list: Op[]): void {
    if (!this.transaction && list.filter(op => op.file === F.workflows).length > 1) return this.atomic(() => this.commit(list));
    const stored: Op[] = [];
    if (this.transaction) {
      for (const op of list) {
        this.transaction.operations.push(op);
        this.transaction.stored.push(this.persisted(op));
        this.apply(op.file, op.rec);
      }
    } else {
      // Most commits contain at most one workflow snapshot; encode against its committed predecessor.
      stored.push(...list.map(op => this.persisted(op)));
      this.store.tx(stored);
      for (const op of list) this.apply(op.file, op.rec);
    }
    if (!this.transaction) this.account(stored);
  }

  private persisted(op: Op, snapshot = false): Op {
    if (!snapshot && op.file === F.workflows && op.rec.flow) {
      const flow: Flow = op.rec.flow, previous = this.workflows.get(flow.owner);
      if (previous) {
        const set: Record<string, unknown> = {}, remove: string[] = [], maps: Record<string, { set: Record<string, unknown>; remove: string[] }> = {};
        for (const key of new Set([...Object.keys(previous), ...Object.keys(flow)])) {
          const before = (previous as any)[key], after = (flow as any)[key];
          if (["versions", "receipts", "instances"].includes(key)) {
            const changed: Record<string, unknown> = {}, deleted: string[] = [];
            for (const name of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
              if (!Object.hasOwn(after ?? {}, name)) deleted.push(name);
              else if (JSON.stringify(before?.[name]) !== JSON.stringify(after[name])) changed[name] = after[name];
            }
            if (deleted.length || Object.keys(changed).length) maps[key] = { set: changed, remove: deleted };
          } else if (!Object.hasOwn(flow, key)) remove.push(key);
          else if (JSON.stringify(before) !== JSON.stringify(after)) set[key] = after;
        }
        return { file: op.file, rec: { op: "patch", owner: flow.owner, set, remove, maps } };
      }
    }
    if (!this.paths) return op;
    if (op.file === F.agents && op.rec.agent) return { ...op, rec: { ...op.rec, agent: { ...op.rec.agent, workspace: this.paths.reference(op.rec.agent.workspace) } } };
    if (op.file === F.assets && op.rec.asset) return { ...op, rec: { ...op.rec, asset: { ...op.rec.asset, path: this.paths.reference(op.rec.asset.path) } } };
    return op;
  }

  private apply(file: string, rec: Record_): void {
    switch (file) {
      case F.topics:
        this.topics = new Map(rec.topics.map(([id, topics]: any) => [id, new Map(topics.map(([key, entry]: any) => [key, { ...entry, peers: new Map(entry.peers) }]))]));
        return;
      case F.workflows:
        if (rec.op === "patch") {
          const flow = structuredClone(this.workflows.get(rec.owner));
          if (!flow) throw new Error(`Missing workflow snapshot for ${rec.owner}`);
          Object.assign(flow, rec.set);
          for (const key of rec.remove) delete (flow as any)[key];
          for (const [key, change] of Object.entries(rec.maps) as [string, { set: Record<string, unknown>; remove: string[] }][]) {
            const map = (flow as any)[key] = { ...(flow as any)[key], ...change.set };
            for (const name of change.remove) delete map[name];
          }
          this.workflows.set(rec.owner, flow);
        } else this.workflows.set(rec.flow.owner, rec.flow);
        return;
      case F.agents:
        if (rec.op === "put") this.agents.set(rec.agent.id, this.paths && (this.loading || typeof rec.agent.workspace !== "string") ? { ...rec.agent, workspace: this.paths.resolveStored(rec.agent.workspace) } : rec.agent);
        else this.agents.delete(rec.id);
        return;
      case F.sessions:
        this.sessions.set(rec.session.id, rec.session);
        if (rec.session.main) this.mainIds.set(rec.session.agentId, rec.session.id);
        return;
      case F.tasks:
        // A task's edges are set when it is made and never change: they are indexed when it is first seen.
        if (!this.tasks.has(rec.task.id)) addEdges(this.graph, rec.task);
        // Records from before tasks named their initiator had an agent's session as `from`.
        this.tasks.set(rec.task.id, rec.task.initiator ? rec.task : { ...rec.task, initiator: { kind: "agent", agentId: rec.task.from.agentId } });
        return;
      case F.gates:
        if (rec.op === "open") this.gates.set(rec.gate.id, rec.gate);
        else this.gates.delete(rec.id);
        return;
      case F.mailbox:
        if (rec.op === "enqueue") {
          this.mail.set(rec.item.id, rec.item);
          if (!rec.topicCounted) this.recordTopic(rec.item);
        } else this.mail.delete(rec.id);
        return;
      case F.ledger:
        this.ledger.set(rec.entry.messageId, rec.entry);
        return;
      case F.assets: {
        if (rec.op === "pointer") {
          this.assetPointers.set(rec.id, rec.version);
          return;
        }
        if (this.paths && (this.loading || typeof rec.asset.path !== "string")) rec = { ...rec, asset: { ...rec.asset, path: this.paths.resolveStored(rec.asset.path) } };
        this.assetPointers.set(rec.asset.id, "v" + rec.asset.version);
        const versions = this.assets.get(rec.asset.id);
        if (versions) versions.push(rec.asset);
        else this.assets.set(rec.asset.id, [rec.asset]);
        return;
      }
    }
    const memory = /^agents\/([^/]+)\/memory\.jsonl$/.exec(file);
    if (memory) {
      let notes = this.notes.get(memory[1]);
      if (!notes) this.notes.set(memory[1], (notes = new Map()));
      if (rec.op === "put") notes.set(topicKey(rec.note.topic), rec.note);
      else notes.delete(topicKey(rec.topic));
    }
  }

  private recordTopic(item: MailItem): void {
    if (item.from.kind !== "agent" || !item.topic || (item.kind !== "message" && item.kind !== "task")) return;
    const pairs = [
      [item.from.agentId, item.to.agentId],
      [item.to.agentId, item.from.agentId],
    ];
    for (const [self, peer] of pairs) {
      let topics = this.topics.get(self);
      if (!topics) this.topics.set(self, (topics = new Map()));
      let entry = topics.get(topicKey(item.topic));
      if (!entry) topics.set(topicKey(item.topic), (entry = { topic: item.topic, peers: new Map() }));
      const seen = entry.peers.get(peer);
      entry.peers.set(peer, { count: (seen?.count ?? 0) + 1, lastAt: item.ts });
    }
  }

  private mainIds = new Map<string,string>();
  mainSession(agentId: string): SessionRec | undefined {
    const id = this.mainIds.get(agentId);
    return id ? this.sessions.get(id) : undefined;
  }
}
