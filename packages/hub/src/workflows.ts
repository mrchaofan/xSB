import { Agents, Workflow, assistantOnly, text } from "@xsb/protocol";
import type { ContentBlock, NodeDef, OriginMeta } from "@xsb/protocol";
import type { Op } from "@xsb/store";
import type { Hub } from "./hub.ts";
import type { Input, LiveSession, Turn, TurnEnd } from "./session.ts";
import { ops } from "./state.ts";
import { newId, now } from "./util.ts";
import { boundedText, contextRef, readContext } from "./context.ts";
import { projectLanguage } from "./config.ts";
import { assignmentTitle, renderAssignment, renderCompletion } from "./workflow-assignment.ts";
import { workflowGuide, workflowInstructions } from "./workflow-guide.ts";
import { TAKEN_IN } from "./kernel.ts";
import { workflowJournal, workflowAuditRecord } from "./workflow-journal.ts";
import type { WorkflowAudit } from "./workflow-journal.ts";
import { canonical, fingerprint, graphJsonl, nodeJson, validateResult, word } from "./workflow-graph.ts";
import {
  additional,
  adopt,
  blocked,
  claim,
  chooseMarkdown,
  completed,
  control,
  empty,
  finishMarkdown,
  graphOf,
  instance,
  nodeOf,
  normalize,
  notice,
  pendingCompletion,
  rollback,
  settled,
  suspend,
  view,
} from "./workflow-state.ts";
import { checkedArguments } from "./workflow-tools.ts";
import type { Completion, Flow } from "./workflow-state.ts";
import { bridgeServer, WORKFLOW_SERVER } from "./mcp.ts";

type Seen = { active?: string; invites: Record<string, string>; candidate?: string };
/** Workflow information received in the current model context. A task only tracks its legacy tool guidance. */
type WorkflowTold =
  | { epoch?: number; definitions: Map<string, NodeDef>; candidate?: string; state: string; turns: number }
  | { epoch: number; taskFileGuidance: true };
type PendingPrompt = {
  turnId: string;
  context?: string;
  scope?: string;
  fileGuidance?: { given: LiveSession["given"]; epoch: number };
  confirmed?: () => void;
};
/** While its work is under way, a main conversation is reminded of its workflow at least this often, in turns. */
export const WORKFLOW_REFRESH_TURNS = 10;
/** How many times a workflow notice the model never got is posted again on its own (then it waits for a resume or restart). */
const NOTICE_RETRIES = 3;

type Notice = Flow["outbox"][number];

/** The same withdrawal rules apply before insertion and on a safe retry of the receiving turn. */
function noticeValid(f: Flow, notice: Notice): boolean {
  if (notice.inputFailure && f.instances[notice.inputFailure.node]?.resolved?.basis !== notice.inputFailure.basis) return false;
  if (notice.invitation && !Object.values(f.instances).some(i => i.invitation === notice.invitation)) return false;
  return !notice.delivery || Object.values(f.instances).some(i => i.last?.valid && i.last.id === notice.delivery);
}

export class Workflows {
  readonly instructions = workflowInstructions;
  private hub: Hub;
  private scheduled = new Set<string>();
  private redirected = new WeakSet<Turn>();
  private seen = new WeakMap<Turn, Seen>();
  private told = new WeakMap<LiveSession["given"], WorkflowTold>();
  private promptAudit = new WeakMap<Input, PendingPrompt>();
  private receivedNotices = new WeakMap<Turn, Map<string, Notice>>();
  constructor(hub: Hub) {
    this.hub = hub;
  }

  supplementalInput(session: LiveSession, origin: OriginMeta, block?: ContentBlock, provider?: string): boolean {
    if (origin.kind === "user") return false;
    if (provider === WORKFLOW_SERVER || this.hub.state.agents.get(session.agentId)?.workflowOwner) return true;
    if (origin.kind === "agent") return !!this.hub.state.agents.get(origin.agentId)?.workflowOwner;
    // Older main-session outbox messages stored the serialized notice (sometimes a boundedText excerpt)
    // without its audience. Recognize only the older writer's system-message envelopes during display.
    if (origin.role !== "message" || block?.type !== "text" || !this.hub.state.workflows.has(session.id)) return false;
    const notice = /^\{"(?:choose|escalate|suspended|inputError|completed)":/;
    const body = block.text ?? "";
    if (notice.test(body)) return true;
    if (!body.startsWith('{"excerpt":')) return false;
    try {
      const excerpt = JSON.parse(body);
      return typeof excerpt.context_ref === "string" && typeof excerpt.excerpt === "string" && notice.test(excerpt.excerpt);
    } catch { return false; }
  }

  toolServer(session: LiveSession) {
    return bridgeServer(this.hub.paths.socket("mcp"), session.bridgeToken);
  }

  read(owner: string) {
    return this.hub.state.workflows.get(owner) ?? empty(owner);
  }
  record(s: LiveSession, turnId: string, ...events: WorkflowAudit[]) {
    const file = workflowJournal(s), ts = now();
    this.hub.state.commit(events.map(event => ({ file, rec: workflowAuditRecord(s, turnId, ts, event) })));
  }
  /** Called in the actual ACP insertion transaction. A refused or replaced preparation leaves no audit record. */
  auditInsertion(s: LiveSession, input: Input) {
    const pending = this.promptAudit.get(input);
    if (!pending || pending.turnId !== input.origin.turnId) return;
    const events: WorkflowAudit[] = [];
    if (pending.context) events.push({ kind: "context", context: pending.context });
    if (pending.scope) events.push({ kind: "scope", messageId: input.messageId, scope: pending.scope });
    this.record(s, pending.turnId, ...events);
    this.hub.state.afterCommit(() => {
      if (pending.fileGuidance) this.told.set(pending.fileGuidance.given, { epoch: pending.fileGuidance.epoch, taskFileGuidance: true });
      this.promptAudit.delete(input);
      pending.confirmed?.();
    });
  }
  owner(s: LiveSession) {
    return this.hub.agent(s.agentId).workflowOwner ?? s.id;
  }
  isMarkdownTask(s: LiveSession) {
    const spec = this.hub.agent(s.agentId);
    if (!spec.workflowOwner) return false;
    const f = this.read(spec.workflowOwner);
    return graphOf(f)?.format === "markdown" && f.instances[spec.workflowNode!]?.sessionId === s.id;
  }
  get(owner: string) {
    const session = this.hub.session(owner);
    if (this.owner(session) !== owner) throw Error("Expected a main session");
    const snapshot = view(this.read(owner));
    // A correction being handled by the main conversation is active work, not a failed interruption to resume.
    if (!snapshot.paused && snapshot.interrupted && session.busy && snapshot.state !== "completed") {
      snapshot.state = "running";
      snapshot.controls = { ...snapshot.controls, pause: true, resume: false };
    }
    for (const node of snapshot.nodes) if (node.interrupted && node.status === "running" && node.sessionId && this.hub.live.get(node.sessionId)?.busy)
      node.controls!.resume = false;
    return snapshot;
  }
  list() {
    return [...this.hub.state.workflows.values()].filter(f => f.active || f.candidate).map(f => this.get(f.owner));
  }
  /** Controls depend on live execution as well as the persisted graph. */
  runtimeChanged(sessionId: string) {
    const session = this.hub.live.get(sessionId);
    if (!session) return;
    const owner = this.owner(session), f = this.read(owner);
    if (!f.active || f.paused) return;
    const node = this.hub.agent(session.agentId).workflowNode;
    const interruptions = node ? f.instances[node]?.interruptions : f.interruptions;
    if (interruptions?.length) this.publish(owner);
  }
  private publish(owner: string) {
    this.hub.broadcast(Workflow.update, { workflow: this.get(owner) });
  }
  private save(f: Flow, extra: Op[] = [], userStops?: Set<LiveSession>, recoveredResult?: Completion) {
    const ending = new Set(Object.values(f.instances).flatMap(i => i.work?.state === "ended" ? [i.work.id] : []));
    const result = normalize(f) ?? recoveredResult;
    f.outbox = f.outbox.filter(n => noticeValid(f, n));
    const prior = this.read(f.owner);
    const oldGraph = graphOf(prior);
    const withdrawn = oldGraph?.format === "markdown" ? oldGraph.nodes.flatMap(n => {
      if (n.kind !== "end") return [];
      const end = prior.instances[n.node]?.last;
      const current = f.instances[n.node]?.last;
      return end?.valid && end.output !== undefined && (!current?.valid || current.id !== end.id) ? [end] : [];
    }) : [];
    // A node whose agent had an assignment in its conversation, now withdrawn (redefined, invalidated): it hears so next.
    for (const [name, old] of Object.entries(prior.instances)) {
      const next = f.instances[name];
      if (next && old.id === next.id && old.work?.inserted && !ending.has(old.work.id) &&
          old.work.id !== next.work?.id && !next.revoked?.includes(old.work.id))
        next.revoked = [...(next.revoked ?? []), old.work.id];
    }
    const operations = [...extra, ops.workflow(f)];
    const persist = () => {
      if (userStops) {
        if (!this.hub.delivery.userStopMany([...userStops], operations)) return false;
      } else this.hub.state.commit(operations);
      if (result || withdrawn.length) {
        const language = projectLanguage(this.hub.paths);
        const source = { kind: "plugin" as const, id: "workflow", label: language === "zh-CN" ? "工作流" : "Workflow" };
        const session = this.hub.session(f.owner);
        for (const end of withdrawn) {
          const heading = language === "zh-CN" ? "**此工作流结果已失效**" : "**This workflow result was withdrawn**";
          session.appendConversationEntry(end.id, source, heading + "\n\n" + end.output, true);
        }
        if (result) session.appendConversationEntry(result.id, source, renderCompletion(result, language));
      }
      return true;
    };
    // The accepted end and its passive conversation entry share a WAL transaction.
    if (!(result || withdrawn.length ? this.hub.state.atomic(persist) : persist())) return false;
    this.hub.state.afterCommit(() => {
      // All old completions and tool writes are already fenced by the committed snapshot.
      for (const [name, old] of Object.entries(prior.instances)) {
        const session = old.sessionId && this.hub.live.get(old.sessionId);
        if (!session) continue;
        const current = session.current,
          next = f.instances[name];
        if (old.id !== next?.id) {
          this.hub.broadcast(Agents.removed, { id: session.agentId });
          // Reject mail that still needs a recipient. Already accepted inputs settle with their own turn.
          for (const item of [...this.hub.state.mail.values()])
            if (item.to.sessionId === session.id && !current?.inputs.some(input => input.messageId === item.id))
              this.hub.kernel.route(item);
          const retire = () => this.hub.backends.stop(session.agentId);
          if (current) void current.done.promise.then(retire);
          else retire();
        }
        const attempt = old.work?.attempt;
        if (attempt && next?.work?.attempt !== attempt && !userStops?.has(session)) {
          const notice = projectLanguage(this.hub.paths) === "zh-CN"
            ? `工作流已撤回节点「${name}」的本次指派。请停止这项指派，继续处理本轮其余工作。`
            : `The workflow withdrew the assignment for node "${name}". Stop that assignment and continue the other work in this turn.`;
          session.revokeProviderInput(WORKFLOW_SERVER, attempt, notice);
        }
      }
      this.publish(f.owner);
      this.schedule(f.owner);
    });
    return true;
  }
  private schedule(owner: string) {
    if (this.scheduled.has(owner) || this.hub.stopping) return;
    this.scheduled.add(owner);
    setImmediate(() => {
      this.scheduled.delete(owner);
      if (this.hub.stopping || this.read(owner).paused) return;
      try {
        this.drain(owner);
      } catch (error) {
        // A backend configuration or filesystem operation can fail between
        // adoption and dispatch. Keep other sessions serving requests.
        const f = structuredClone(this.read(owner));
        f.error = error instanceof Error ? error.message : String(error);
        this.hub.log(`Workflow ${owner} paused during dispatch: ${f.error}`);
        control(f, true);
        this.save(f);
      }
    });
  }
  private drain(owner: string) {
    const root = this.hub.session(owner);
    let initial = this.read(owner);
    // A notice the model never got (refused, the backend failed) is posted again, a few times, without waiting for a resume.
    const unseen = initial.outbox.filter((n) => n.posted && !this.hub.state.mail.has(n.posted) &&
      this.hub.state.ledger.get(n.posted)?.state === "discarded_unseen" && (n.attempts ?? 0) < NOTICE_RETRIES);
    if (unseen.length && !initial.paused) {
      const f = structuredClone(initial);
      for (const n of f.outbox) if (unseen.some((u) => u.id === n.id)) { n.attempts = (n.attempts ?? 0) + 1; delete n.posted; }
      this.save(f);
      initial = this.read(owner);
    }
    if (initial.outbox.some((n) => !n.posted) && !initial.paused) {
      const f = structuredClone(initial),
        items = f.outbox.filter((n) => !n.posted);
      // A discarded insertion attempt has a terminal ledger receipt. Retrying
      // keeps the same logical result and creates a fresh transport message.
      for (const n of items) n.posted = this.hub.state.ledger.has(n.id) ? newId("noticeAttempt") : n.id;
      const mail = items.map((n) => ({
        id: n.posted!,
        to: { agentId: root.agentId, sessionId: owner },
        ts: now(),
        from: { kind: "system" as const },
        kind: "message" as const,
        provider: "workflow",
        invitation: n.invitation,
        prompt: [assistantOnly(text(n.text))],
      }));
      this.save(f, mail.map(ops.enqueue));
      for (const item of mail) this.hub.kernel.route(item);
    }
    for (const item of [...this.hub.state.mail.values()]) {
      if (
        item.heldBy !== "workflow" ||
        (this.hub.state.agents.get(item.to.agentId)?.workflowOwner ?? item.to.sessionId) !== owner
      )
        continue;
      const spec = this.hub.agent(item.to.agentId);
      const f = this.read(owner),
        i = spec.workflowNode ? f.instances[spec.workflowNode] : undefined;
      if (f.paused || i?.paused || (spec.workflowNode && i?.sessionId !== item.to.sessionId)) continue;
      const next = { ...item, heldBy: undefined };
      this.hub.state.commit([ops.enqueue(next)]);
      this.hub.kernel.route(next);
      if ((i?.interruptions ?? f.interruptions).some((p) => p.id === next.id && p.retry)) {
        const state = structuredClone(this.read(owner));
        const pending = (
          spec.workflowNode ? instance(state, spec.workflowNode).interruptions : state.interruptions
        ).find((p) => p.id === next.id);
        if (pending) delete pending.retry;
        this.save(state);
      }
    }
    this.retryInterruptions(root);
    for (const n of graphOf(this.read(owner))?.nodes ?? []) {
      if (n.kind !== "task") continue;
      const f = structuredClone(this.read(owner)),
        i = f.instances[n.node];
      let session = i.sessionId ? this.hub.session(i.sessionId) : undefined;
      if (session) this.retryInterruptions(session);
      if (session?.busy) continue;
      const work = claim(f, n.node);
      if (!work) continue;
      if (!session) {
        const spec = this.hub.agent(root.agentId);
        // The binding and its first claimed work are committed in the same WAL transaction.
        session = this.hub.createConversation(spec.backend, n.node, {
          owner,
          node: n.node,
          agent: n.agent,
          bind: (agentId, sessionId) => {
            i.agentId = agentId;
            i.sessionId = sessionId;
            return ops.workflow(f);
          },
        });
        this.publish(owner);
      } else this.save(f);
      if (!this.acceptsInput(session, work.attempt!)) continue;
      // The short form only where the conversation still has the assignment: not after it was renewed.
      const resume = work.inserted && work.epoch === session.rec.contextEpoch;
      const language = projectLanguage(this.hub.paths);
      const body = renderAssignment(work, language, resume, i.revoked);
      const policy = this.hub.policy(session.agentId);
      const prompt = work.assignment.format === "markdown"
        ? boundedText(this.hub.paths, session.agentId, body, Math.floor((policy.promptTokens - policy.reserveTokens) / 2))
        : body;
      session.enqueue({
        provider: "workflow",
        origin: { kind: "system", messageId: work.attempt },
        prompt: [
          { ...text(assignmentTitle(n.node, work, language)), annotations: { audience: ["user", "assistant"] } },
          assistantOnly(text(prompt)),
        ],
      });
    }
  }

  private retryInterruptions(session: LiveSession) {
    const f = structuredClone(this.read(this.owner(session)));
    const spec = this.hub.agent(session.agentId);
    const i = spec.workflowNode ? f.instances[spec.workflowNode] : undefined;
    if (f.paused || i?.paused || session.busy) return;
    const pending = (i?.interruptions ?? f.interruptions).find((p) => p.retry);
    if (!pending) return;
    delete pending.retry;
    pending.reminder = newId("continue");
    this.save(f);
    // After an explicit resume, ask the agent to finish handling the saved interruption.
    session.enqueue({
      provider: "workflow",
      origin: { kind: "system", messageId: pending.reminder },
      interruptionId: pending.id,
      prompt: [
        assistantOnly(text(`Continue handling the user's previously received message ${pending.id} from this conversation. Verify any effects already observed. If that message is no longer in context, ask the user to send it again; do not reconstruct it.`)),
      ],
    });
  }
  /**
   * The user's interruption did not get to the model (refused, failed, expired): it no longer holds the graph, and it is
   * not continued later. Only an interruption the model has counts (docs/WORKFLOWS.md).
   */
  userInputDiscarded(session: LiveSession, id: string) {
    const spec = this.hub.agent(session.agentId);
    const owner = spec.workflowOwner ?? session.id;
    if (!this.hub.state.workflows.has(owner)) return;
    const f = structuredClone(this.read(owner));
    const list = spec.workflowOwner ? f.instances[spec.workflowNode!]?.interruptions : f.interruptions;
    if (!list?.some((p) => p.id === id)) return;
    if (spec.workflowOwner) f.instances[spec.workflowNode!].interruptions = list.filter((p) => p.id !== id);
    else f.interruptions = list.filter((p) => p.id !== id);
    this.save(f);
  }
  inserted(session: LiveSession, id: string) {
    const spec = this.hub.agent(session.agentId);
    if (!spec.workflowOwner) {
      const state = this.read(session.id);
      const notice = state.outbox.find(n => n.posted === id);
      if (notice) {
        const f = structuredClone(state);
        f.outbox = f.outbox.filter((n) => n.posted !== id);
        // The outbox is acknowledged once. A replacement backend may still need this turn's input.
        const turn = session.current;
        if (turn) {
          const received = this.receivedNotices.get(turn) ?? new Map<string, Notice>();
          received.set(id, notice);
          this.receivedNotices.set(turn, received);
        }
        this.save(f, [ops.ack(id)]);
      }
      return;
    }
    const f = structuredClone(this.read(spec.workflowOwner)),
      w = f.instances[spec.workflowNode!]?.work;
    if (w?.attempt === id && (!w.inserted || w.epoch !== session.rec.contextEpoch)) {
      w.inserted = true;
      w.epoch = session.rec.contextEpoch;
      // The node's agent has its new assignment, and with it the word that the earlier ones are withdrawn.
      delete f.instances[spec.workflowNode!].revoked;
      this.save(f);
    }
  }
  model(session: LiveSession) {
    const spec = this.hub.agent(session.agentId);
    if (!spec.workflowOwner) return;
    const i = this.read(spec.workflowOwner).instances[spec.workflowNode!];
    if (!i?.work || session.current?.first.provider !== "workflow" || i.work.attempt !== session.current.first.messageId) return;
    return {
      requested: i.work.assignment.model as string | undefined,
      inherited: this.hub.session(spec.workflowOwner).rec.selectedConfig,
    };
  }

  restart() {
    for (const state of this.hub.state.workflows.values()) {
      const f = structuredClone(state);
      if (!f.active && !f.candidate) continue;
      const legacy = f.outbox.filter(n => n.delivery);
      f.outbox = f.outbox.filter(n => !n.delivery);
      f.paused = !completed(f);
      // Pre-restart transport attempts never become fresh prompts on resume.
      f.outbox = f.outbox.filter(n => !n.posted);
      for (const i of Object.values(f.instances)) if (i.work?.state === "running") suspend(i.work);
      // Held until the workflow resumes: what its nodes were sent, and the main conversation's interruptions of it. The
      // main conversation's other mail is not the workflow's. What already got into a conversation, or was discarded,
      // is the kernel's to settle on resume (a note that its outcome is unknown, its task failed): never acknowledged here.
      const interruptions = new Set(f.interruptions.map((p) => p.id));
      const heldInputs = [...this.hub.state.mail.values()].filter(
        (m) =>
          m.provider !== "workflow" &&
          (this.hub.state.agents.get(m.to.agentId)?.workflowOwner === f.owner || (m.to.sessionId === f.owner && interruptions.has(m.id))) &&
          !["inserted", "seen", "inserted_unprocessed", "discarded_unseen", "insertion_uncertain"].includes(this.hub.state.ledger.get(m.id)?.state ?? ""),
      );
      const held = heldInputs.map(item => ops.enqueue({ ...item, heldBy: "workflow" }));
      if (!legacy.length) { this.save(f, held); continue; }
      this.hub.state.atomic(() => {
        let recovered: Completion | undefined;
        for (const n of legacy) {
          const transport = n.posted && this.hub.state.ledger.get(n.posted);
          // Already acknowledged inputs keep their original history and kernel restart settlement.
          if (transport && TAKEN_IN.has(transport.state)) continue;
          recovered ??= pendingCompletion(f, n);
          if (!n.posted) continue;
          const mail = this.hub.state.mail.get(n.posted);
          if (mail?.provider === "workflow" && mail.to.sessionId === f.owner && mail.from.kind === "system") {
            if (!transport || transport.state !== "insertion_uncertain") {
              this.hub.kernel.mark(mail.id, transport && transport.offered ? "insertion_uncertain" : "discarded_unseen",
                { ...mail.to, from: mail.from }, "interrupted");
            }
            this.hub.kernel.ack([mail.id]);
          }
        }
        this.save(f, held, undefined, recovered);
      });
    }
  }
  available(s: LiveSession) {
    const spec = this.hub.agent(s.agentId);
    return !spec.workflowOwner || this.read(spec.workflowOwner).instances[spec.workflowNode!]?.sessionId === s.id;
  }
  accessible(s: LiveSession) {
    if (!this.available(s)) throw Error("This task agent is no longer active");
  }
  /** A node's agent that a later version dropped: its conversation stays readable in the version's history. */
  retired(agentId: string): boolean {
    const spec = this.hub.state.agents.get(agentId);
    if (!spec?.workflowOwner) return false;
    const f = this.read(spec.workflowOwner);
    return f.instances[spec.workflowNode!]?.agentId !== agentId && !!f.history?.some((v) => v.nodes.some((n) => n.agentId === agentId));
  }
  /** Reading a conversation: the active ones, and those of nodes kept in a workflow's history. */
  readable(s: LiveSession) {
    if (!this.available(s) && !this.retired(s.agentId)) throw Error("This task agent is no longer active");
  }
  acceptsInput(s: LiveSession, id: string): boolean {
    const spec = this.hub.agent(s.agentId);
    const f = this.read(spec.workflowOwner ?? s.id);
    if (f.paused) return false;
    if (!spec.workflowOwner) {
      if (f.outbox.some(n => n.posted === id) || f.interruptions.some(p => p.reminder === id)) return true;
      const turn = s.current;
      const received = turn?.recoveryAttempts && this.receivedNotices.get(turn)?.get(id);
      return !!received && noticeValid(f, received);
    }
    const i = f.instances[spec.workflowNode!];
    return i?.sessionId === s.id && !i.paused && (i.work?.attempt === id || i.interruptions.some(p => p.reminder === id));
  }
  control(owner: string, action: "pause" | "resume" | "rollback", nodes?: string[]) {
    const pause = action === "pause";
    if (!graphOf(this.read(owner))) throw Error("No active workflow");
    const f = structuredClone(this.read(owner));
    if (action === "rollback") {
      rollback(f, nodes);
      this.save(f);
      return this.get(owner);
    }
    if (completed(f)) { control(f, pause, nodes); return this.get(owner); }
    control(f, pause, nodes);
    if (!pause) this.allowInterruptionRetry(f, nodes);
    this.save(f);
    return this.get(owner);
  }
  private allowInterruptionRetry(f: Flow, nodes?: string[]) {
    for (const n of f.outbox) if (n.posted && !this.hub.state.mail.has(n.posted)) delete n.posted;
    const groups = Object.entries(f.instances)
      .filter(([name]) => !nodes || nodes.includes(name))
      .map(([, i]) => i.interruptions);
    if (!nodes) groups.push(f.interruptions);
    for (const group of groups) for (const p of group) {
      delete p.reminder;
      p.retry = true;
    }
  }
  /** A panel stop is confined to task sessions of the displayed plan. The main conversation stays available. */
  stop(owner: string, version: string, node?: string) {
    const snapshot = this.get(owner);
    if (!snapshot.version || snapshot.version !== version) throw Error("Active workflow version changed");
    const scope = node === undefined ? snapshot : snapshot.nodes.find(n => n.name === node && n.kind === "task");
    if (!scope) throw Error(`Unknown task: ${node}`);
    if (!scope.controls?.stop) return snapshot;
    if (!this.stopScope(owner, node, new Set())) throw Error("The workflow stop was refused");
    return this.get(owner);
  }
  userStop(s: LiveSession) {
    const owner = this.owner(s);
    if (!graphOf(this.read(owner))) return this.hub.delivery.userStop(s);
    this.stopScope(owner, this.hub.agent(s.agentId).workflowNode, new Set([s]));
  }
  private stopScope(owner: string, node: string | undefined, sessions: Set<LiveSession>) {
    const f = structuredClone(this.read(owner));
    // What the stop takes away that the main agent was told is coming: it hears that it will not.
    const cancelled: string[] = [];
    if (node === undefined) {
      f.interruptions = [];
      if (f.outbox.length) cancelled.push(`${f.outbox.length} workflow notice(s) not yet delivered to you were dropped by the user's stop`);
      f.outbox = [];
    }
    control(f, true, node === undefined ? undefined : [node]);
    for (const [name, i] of Object.entries(f.instances))
      if (node === undefined || node === name) {
        if (i.sessionId) sessions.add(this.hub.session(i.sessionId));
        if (i.extras.length) cancelled.push(`${i.extras.length} queued additional prompt(s) for node "${name}" were cancelled by the user's stop`);
        i.extras = [];
        i.interruptions = [];
      }
    if (cancelled.length) f.cancelled = [...(f.cancelled ?? []), ...cancelled];
    return this.save(f, [], sessions.size ? sessions : undefined);
  }
  input(s: LiveSession, id: string, blocks: ContentBlock[], target?: string) {
    this.accessible(s);
    const spec = this.hub.agent(s.agentId);
    const saved = this.hub.state.workflows.get(spec.workflowOwner ?? s.id);
    if (!saved || (!spec.workflowOwner && (target !== "workflow" || !saved.active || settled(saved)))) {
      s.protect();
      return;
    }
    const f = structuredClone(saved);
    if (spec.workflowOwner) {
      const i = instance(f, spec.workflowNode!);
      const current = (i.work?.kind === "graph" ? i.work.id : undefined) ?? (i.last?.valid ? i.last.id : undefined);
      if (target && target !== "history" && target !== current) throw Error("This workflow target has expired");
      // Form responses return through ACP. Only ordinary user input reaches here.
      if (target !== "history" && current && !i.interruptions.some((p) => p.id === id))
        i.interruptions.push({ id, target: current, prompt: blocks });
    } else {
      f.interruptions.push({ id, target: f.active!, prompt: blocks });
    }
    s.protect();
    this.save(f);
  }

  private observe(f: Flow, turn: Turn) {
    const observed = {
      active: f.active,
      candidate: f.candidate?.version,
      invites: Object.fromEntries(
        Object.entries(f.instances).flatMap(([n, i]) => (i.invitation ? [[n, i.invitation]] : [])),
      ),
    };
    const invitation = turn.first.item?.invitation;
    if (invitation)
      observed.invites = Object.fromEntries(Object.entries(observed.invites).filter(([, id]) => id === invitation));
    this.seen.set(turn, observed);
    return observed;
  }
  inheritSeen(previous: Turn, next: Turn) {
    const observed = this.seen.get(previous);
    if (observed) this.seen.set(next, observed);
  }
  interruptionContext(s: LiveSession, id: string) {
    const spec = this.hub.agent(s.agentId),
      f = this.read(spec.workflowOwner ?? s.id);
    if (!spec.workflowOwner)
      return f.interruptions.some((p) => p.id === id)
        ? "[xSB] The user is addressing the current workflow."
        : undefined;
    const target = f.instances[spec.workflowNode!]?.interruptions.find((p) => p.id === id)?.target;
    return target
      ? "[xSB] This interruption addresses graph work or delivery " + target
      : "[xSB] Direct conversation about context or history. Answer this message independently.";
  }
  /** The scope is a separate preface. The user's own content is passed through unchanged. */
  userScope(s: LiveSession, turn: Turn, input: Input) {
    // A task node's first message already gets its purpose in the context in front of this turn.
    const scope = input !== turn.first || !this.hub.agent(s.agentId).workflowOwner ? this.interruptionContext(s, input.messageId) : undefined;
    const pending = this.promptAudit.get(input);
    const current = pending?.turnId === turn.id ? pending : undefined;
    if (scope || current?.context) this.promptAudit.set(input, { ...current, turnId: turn.id, scope });
    else this.promptAudit.delete(input);
    return scope;
  }
  context(s: LiveSession, turn: Turn) {
    const pending: PendingPrompt = { turnId: turn.id };
    let context = this.describeContext(s, turn, pending);
    // Old nodes keep their original role and backend session. Correct the retired built-in tool
    // instructions in the next actual prompt without waking an idle node or rewriting its prefix.
    const epoch = s.rec.contextEpoch ?? 0;
    const needsFileGuidance = s.rec.workflowPrompt?.includes("and the asset tools (asset_list, asset_get") && !this.isMarkdownTask(s) &&
      this.told.get(s.given)?.epoch !== epoch;
    if (needsFileGuidance) {
      const guidance = "[xSB] Workflow file handling has changed. Use your backend's file tools. Link working files in your summary and call finish({summary,result?}). If an earlier reference has no usable path, ask for the file or clarify it with the main agent.";
      context = context ? context + "\n" + guidance : guidance;
    }
    if (context) this.promptAudit.set(turn.first, { ...pending, context, ...(needsFileGuidance && { fileGuidance: { given: s.given, epoch } }) });
    else this.promptAudit.delete(turn.first);
    return context;
  }
  private describeContext(s: LiveSession, turn: Turn, pending: PendingPrompt) {
    const spec = this.hub.agent(s.agentId);
    if (spec.workflowOwner) {
      const i = this.read(spec.workflowOwner).instances[spec.workflowNode!];
      if (!i || turn.first.provider === "workflow" && i.work?.attempt === turn.first.messageId) return;
      const message = i.interruptions.find((p) => p.id === (turn.first.interruptionId ?? turn.first.messageId));
      return (
        "[xSB task conversation] " +
        boundedText(this.hub.paths, s.agentId, JSON.stringify({
          purpose: message
            ? "User interruption concerning current graph work or delivery"
            : "The user talks to you directly here. Sort it as your instructions say: your own assignment (handle it; escalate with pauseSelf if the assignment itself must change), the overall task (escalate to the main agent), or neither (just answer).",
          target: message?.target,
          current: i.work && i.work.assignment.target,
          last: i.last?.valid ? i.last : undefined,
        }), this.hub.policy(s.agentId).outputTokens)
      );
    }
    const f = this.read(s.id);
    this.observe(f, turn);
    if (!f.active && !f.candidate) return;
    const epoch = s.rec.contextEpoch, given = s.given,
      before = this.told.get(given),
      prior = before && "definitions" in before && before.epoch === epoch ? before : undefined;
    // When the model is told of its workflow (docs/WORKFLOWS.md): whole, in a context that does not have it (its first
    // turn, after a compaction or a renewal); at once, what it cannot learn otherwise (a pause, an error, work the user's
    // stop dropped); and while work is under way, every WORKFLOW_REFRESH_TURNS turns. Choices and escalations
    // have their own actionable notices. A completion publishes display text directly to the main conversation.
    const inputErrors = Object.fromEntries(Object.entries(f.instances).flatMap(([name, i]) =>
      i.resolved && "error" in i.resolved ? [[name, i.resolved.error]] : []));
    const errors = Object.keys(inputErrors).length ? { inputErrors } : {};
    const pausedNodes = Object.keys(f.instances).filter(name => f.instances[name].paused);
    const state = canonical({ paused: f.paused, pausedNodes, error: f.error ?? null, ...errors });
    if (prior && !f.cancelled?.length && prior.state === state && (settled(f) || prior.turns + 1 < WORKFLOW_REFRESH_TURNS)) {
      prior.turns++;
      return;
    }
    const graph = graphOf(f);
    const definitions = new Map(graph?.nodes.map((n) => [n.node, n]));
    const changed = graph?.nodes.flatMap((n) => {
      const old = prior?.definitions.get(n.node);
      const next = nodeJson(n);
      if (!old) return [next];
      const previous = nodeJson(old);
      const entries = (Object.keys({...previous, ...next}) as (keyof typeof next)[])
        .filter((key) => canonical(previous[key]) !== canonical(next[key]))
        .map((key) => [key, next[key] ?? null]);
      return entries.length ? [{ node: n.node, ...Object.fromEntries(entries) }] : [];
    });
    // A context that has not had them (a first turn, a compacted or renewed one) gets the graphs whole, in the JSONL the
    // model writes them in; later turns get what changed. Versions are named for reading: execute takes none.
    const fresh = !prior;
    const { candidate, edges, ...active } = view(f, false);
    const candidateJsonl = candidate && graphJsonl(candidate.graph);
    const details = {
      ...active,
      ...errors,
      ...(fresh && graph ? { graphJsonl: graphJsonl(graph) } : { edges, definitions: changed }),
      graphRef: graph && contextRef(this.hub.paths, s.agentId, graphJsonl(graph)).ref,
      candidate: candidate && {
        version: candidate.version,
        basedOn: f.candidate!.base ?? null,
        ...((fresh || prior.candidate !== candidate.version) && { graphJsonl: candidateJsonl }),
        graphRef: contextRef(this.hub.paths, s.agentId, candidateJsonl!).ref,
      },
      choices: Object.entries(f.instances)
        .filter(([, i]) => i.invitation)
        .map(([node, i]) => ({ node, delivery: i.last })),
      ...(f.cancelled?.length ? { cancelled: f.cancelled } : {}),
    };
    const told = f.cancelled;
    pending.confirmed = () => {
      if (this.told.get(given) === before) this.told.set(given, { epoch, definitions, candidate: f.candidate?.version, state, turns: 0 });
      // Told once its actual ACP offer has an insertion receipt.
      if (told?.length) {
        const now = structuredClone(this.read(s.id));
        now.cancelled = (now.cancelled ?? []).filter(c => !told.includes(c));
        if (!now.cancelled.length) delete now.cancelled;
        this.save(now);
      }
    };
    const rendered = boundedText(
      this.hub.paths,
      s.agentId,
      JSON.stringify(details),
      this.hub.policy(s.agentId).outputTokens,
    );
    return "[xSB workflow]\n" + rendered;
  }
  ended(s: LiveSession, turn: Turn, end: TurnEnd) {
    const spec = this.hub.agent(s.agentId);
    const saved = this.hub.state.workflows.get(spec.workflowOwner ?? s.id);
    if (!saved) return;
    const normal = !end.failure && !turn.cancelledBy && end.stopReason === "end_turn";
    const processed = new Set(
      turn.inputs.filter((input) => input.in).map((input) => input.interruptionId ?? input.messageId),
    );
    if (!spec.workflowOwner) {
      if (normal && saved.interruptions.some((p) => processed.has(p.id))) {
        const f = structuredClone(saved);
        f.interruptions = f.interruptions.filter((p) => !processed.has(p.id));
        this.save(f);
      } else if (saved.active && !completed(saved)) this.schedule(s.id);
      return;
    }
    const f = structuredClone(saved);
    const i = f.instances[spec.workflowNode!];
    if (i?.sessionId !== s.id) return;
    if (normal && !this.redirected.has(turn)) i.interruptions = i.interruptions.filter((p) => !processed.has(p.id));
    if (turn.first.provider === "workflow" && i.work?.attempt === turn.first.messageId) {
      if (normal && (i.work.staged || (i.work.routing && i.last?.selected))) {
        i.work.state = "ended";
        delete i.work.attempt;
      } else {
        suspend(i.work, "failure");
        notice(
          f,
          JSON.stringify({
            suspended: spec.workflowNode,
            reason: end.failure
              ? String(end.failure)
              : i.work.routing ? "Turn ended without selecting a target. Explicit resume required."
              : "Turn ended without an accepted finish. Explicit resume required.",
          }),
        );
      }
    }
    this.save(f);
  }

  call(s: LiveSession, name: string, a: Record<string, any>, receipt: string) {
    if (!s.current?.started || !s.acceptsTools) throw Error("No active turn");
    this.accessible(s);
    const spec = this.hub.agent(s.agentId),
      turn = s.current,
      current = this.read(this.owner(s));
    const key = fingerprint([s.agentId, receipt]);
    const markdown = graphOf(current)?.format === "markdown";
    a = checkedArguments(name, a, !!spec.workflowOwner, markdown);
    if (name === "guide") return workflowGuide(projectLanguage(this.hub.paths));
    if (Object.hasOwn(current.receipts, key)) return current.receipts[key];
    if (name === "load_skill") {
      if (!spec.workflowOwner) throw Error("Tool unavailable for main agent");
      const skill = spec.workflowAgent?.skills?.find(skill => skill.name === a.name);
      if (!skill) throw Error(`Unknown assignment skill: ${a.name}`);
      return { ...skill };
    }
    if (name === "read_context") return readContext(this.hub.paths, s.agentId, a.ref, a.offset, a.bytes);
    if (name === "previous_conversation") {
      const moved = s.rec.migratedFrom;
      if (!moved) throw Error("This conversation does not continue another one.");
      return readContext(this.hub.paths, s.agentId, moved.ref, a.offset, a.bytes);
    }
    const f = structuredClone(current);
    const node = spec.workflowNode,
      i = node ? instance(f, node) : undefined;
    const work = turn.first.provider === "workflow" && i?.work?.attempt === turn.first.messageId ? i.work : undefined;
    let result: unknown;
    if (!node) {
      const observed = this.seen.get(turn);
      if (name === "rollback") {
        if (observed?.active !== f.active) throw Error("Active version changed");
        rollback(f, a.nodes);
        result = { ok: true };
      } else if (["plan", "execute"].includes(name)) {
        if (observed?.active !== f.active) throw Error("Active version changed");
        // Adopting the candidate adopts the one this turn was shown: its name is xSB's to check, not the model's to quote.
        if (name === "execute" && a.graphJsonl === undefined && a.replaceNode === undefined && f.candidate && observed?.candidate !== f.candidate.version)
          throw Error("The candidate changed since this turn saw it");
        result = { version: adopt(f, a, name === "plan") };
      } else if (name === "prompt") {
        additional(f, a.node, a.text);
        result = { queued: true, id: newId("extra") };
      } else if (name === "pause" || name === "resume") {
        control(f, name === "pause", a.nodes);
        if (name === "resume") this.allowInterruptionRetry(f, a.nodes);
        result = { ok: true };
      } else if (name === "choose") {
        if (markdown) throw Error("A Markdown branch is selected by its source task agent.");
        const src = instance(f, a.from),
          def = nodeOf(f, a.from);
        if (
          !src.invitation ||
          !src.last?.valid ||
          observed?.invites[a.from] !== src.invitation ||
          blocked(f, a.from)
        )
          throw Error("Choice expired or blocked");
        const options = graphOf(f)!
          .edges.filter((e) => e.from === a.from)
          .map((e) => e.case);
        if (
          !Array.isArray(a.cases) ||
          new Set(a.cases).size !== a.cases.length ||
          (!def.multi && a.cases.length !== 1) ||
          a.cases.some((c: unknown) => typeof c !== "string" || !options.includes(c))
        )
          throw Error("Invalid branch selection");
        src.last.choice = { id: newId("choice"), cases: a.cases };
        delete src.invitation;
        result = { ok: true };
      } else throw Error("Unavailable main agent tool");
    } else if (name === "finish" && work?.assignment.format === "markdown") {
      result = finishMarkdown(f, node, work, a.output);
    } else if (name === "choose" && work?.assignment.format === "markdown") {
      result = chooseMarkdown(f, node, work, a.node);
    } else if (name === "finish" && work && !work.staged) {
      word(a.summary, "summary");
      const schema = nodeOf(f, node).schema;
      if (work.kind === "graph" && schema) {
        if (!Object.hasOwn(a, "result")) throw Error("This task requires a result");
        validateResult(schema, a.result);
      }
      work.staged = { summary: a.summary, result: a.result };
      result = { staged: true };
    } else if (name === "escalate" && i) {
      // To the main agent, which runs the whole workflow: the user's request about the whole task, or a need of this
      // node's work. With pauseSelf the node's own assignment must change: it waits for the main agent's decision
      // (execute with replaceNode, or resume to keep the assignment), and may withdraw its delivery.
      const message = word(a.message, "message");
      const userInput = turn.inputs.findLast(
        (input) => input.in && (input.interruptionId || input.origin.kind === "user"),
      );
      const said = userInput?.content.flatMap((b) => (b.type === "text" ? [String(b.text ?? "")] : [])).join("\n").trim();
      const pause = a.pauseSelf === true;
      if (a.invalidateSelf === true && !pause) throw Error("invalidateSelf withdraws your delivery: it needs pauseSelf");
      if (pause) {
        const latest =
          userInput && i.interruptions.find((p) => p.id === (userInput.interruptionId ?? userInput.messageId));
        const target = (i.work?.kind === "graph" ? i.work.id : undefined) ?? (i.last?.valid ? i.last.id : undefined);
        if (!target || (userInput ? latest?.target !== target : work?.kind !== "graph"))
          throw Error("Graph work or delivery expired");
        this.redirected.add(turn);
        i.interruptions = i.interruptions.filter((p) => p !== latest);
        if (a.invalidateSelf === true && markdown) rollback(f, [node]);
        else if (a.invalidateSelf === true) {
          if (i.last) i.last.valid = false;
          if (i.work?.kind === "graph") delete i.work;
          delete i.invitation;
        }
        i.replan = message;
      }
      notice(f, JSON.stringify({
        escalate: node, message, ...(said ? { userSaid: said.slice(0, 4000) } : {}),
        paused: pause, ...(a.invalidateSelf === true ? { invalidateSelf: true } : {}),
      }));
      result = pause ? { forwarded: "main conversation", paused: node } : { forwarded: "main conversation" };
    } else throw Error("Tool unavailable for this execution");
    f.receipts[key] = result;
    this.save(f);
    if (!node && (name === "plan" || name === "execute")) {
      // Adoption updates the version this caller has seen. Choice invitations arrive with their own deliveries.
      const observed = this.seen.get(turn);
      this.seen.set(turn, { active: f.active, candidate: f.candidate?.version, invites: observed?.invites ?? {} });
    }
    return result;
  }
}
