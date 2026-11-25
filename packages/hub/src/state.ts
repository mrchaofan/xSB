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

export type SessionRec = {
  id: string;
  agentId: string;
  /** The backend's own session id, once one exists. */
  backendSessionId?: string;
  /**
   * The backend session has been given nothing yet: it was opened only to read or change its settings. A backend may
   * keep no such session (codex writes one at its first prompt), so failing to resume it loses nothing to hand over.
   */
  backendFresh?: boolean;
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
  renew?: boolean | "stopped" | "isolated";
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

  constructor(store: Store) {
    this.store = store;
  }

  load(): void {
    this.store.recover();
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
  }

  /**
   * Forget agents for good (a deleted conversation, cleaned up): their agents, sessions, the workflows those sessions
   * own, notes, and assets only they made. Each file they appear in is rewritten without them, so the space comes back.
   * Returns the assets dropped, whose files the caller removes. Tasks, mail and ledger entries are small and stay.
   */
  forget(agentIds: Set<string>): Asset[] {
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
    this.store.rewrite(F.agents, [...this.agents.values()].map((agent) => ({ op: "put", agent })));
    this.store.rewrite(F.sessions, [...this.sessions.values()].map((session) => ({ op: "put", session })));
    this.store.rewrite(F.workflows, [...this.workflows.values()].map((flow) => ({ flow })));
    this.store.rewrite(F.assets, [...this.assets].flatMap(([id, versions]) => [
      ...versions.map((asset) => ({ op: "put", asset })),
      { op: "pointer", id, version: this.assetPointers.get(id) ?? null },
    ]));
    return dropped;
  }

  commit(list: Op[]): void {
    this.store.tx(list);
    for (const op of list) this.apply(op.file, op.rec);
  }

  private apply(file: string, rec: Record_): void {
    switch (file) {
      case F.workflows:
        this.workflows.set(rec.flow.owner, rec.flow);
        return;
      case F.agents:
        if (rec.op === "put") this.agents.set(rec.agent.id, rec.agent);
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
          this.recordTopic(rec.item);
        } else this.mail.delete(rec.id);
        return;
      case F.ledger:
        this.ledger.set(rec.entry.messageId, rec.entry);
        return;
      case F.assets: {
        if (rec.op === "pointer") {
          this.assetPointers.set(rec.id,rec.version);
          return;
        }
        this.assetPointers.set(rec.asset.id,"v"+rec.asset.version);
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
