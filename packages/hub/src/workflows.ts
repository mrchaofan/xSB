import { accessAsset, findAsset } from "./workflow-assets.ts";
import { Agents, Assets, Workflow, text } from "@xsb/protocol";
import type { Asset, AssetRef, ContentBlock, NodeDef } from "@xsb/protocol";
import type { Op } from "@xsb/store";
import type { Hub } from "./hub.ts";
import type { LiveSession, Turn, TurnEnd } from "./session.ts";
import { ops } from "./state.ts";
import { hubLimit } from "./config.ts";
import { newId, now } from "./util.ts";
import { boundedText, contextRef, readContext } from "./context.ts";
import { canonical, fingerprint, validateResult, word } from "./workflow-graph.ts";
import {
  additional,
  adopt,
  blocked,
  claim,
  control,
  empty,
  graphOf,
  instance,
  nodeOf,
  normalize,
  notice,
  refs,
  suspend,
  view,
} from "./workflow-state.ts";
import { checkArguments } from "./workflow-tools.ts";
import type { Flow } from "./workflow-state.ts";

type Seen = { active?: string; invites: Record<string, string>; candidate?: string };
export class Workflows {
  private hub: Hub;
  private scheduled = new Set<string>();
  private known = new WeakMap<LiveSession, { epoch?: number; definitions: Map<string, NodeDef> }>();
  private redirected = new WeakSet<Turn>();
  private seen = new WeakMap<Turn, Seen>();
  constructor(hub: Hub) {
    this.hub = hub;
  }

  read(owner: string) {
    return this.hub.state.workflows.get(owner) ?? empty(owner);
  }
  owner(s: LiveSession) {
    return this.hub.agent(s.agentId).workflowOwner ?? s.id;
  }
  get(owner: string) {
    const session = this.hub.session(owner);
    if (this.owner(session) !== owner) throw Error("Expected a main session");
    return view(this.read(owner));
  }
  private save(f: Flow, extra: Op[] = [], userStops?: Set<LiveSession>) {
    normalize(f);
    const instances = Object.values(f.instances);
    f.outbox = f.outbox.filter(
      (n) =>
        (!n.invitation || instances.some((i) => i.invitation === n.invitation)) &&
        (!n.delivery || instances.some((i) => i.last?.valid && i.last.id === n.delivery)),
    );
    const prior = this.read(f.owner);
    const operations = [...extra, ops.workflow(f)];
    this.hub.state.commit(operations);
    // All old completions and tool writes are already fenced by the committed snapshot.
    for (const [name, old] of Object.entries(prior.instances)) {
      const session = old.sessionId && this.hub.live.get(old.sessionId);
      if (!session) continue;
      const current = session.current,
        next = f.instances[name];
      if (old.id !== next?.id) {
        this.hub.broadcast(Agents.removed, { id: session.agentId });
        // A removed instance cannot receive its old mailbox through a queued route.
        for (const item of [...this.hub.state.mail.values()])
          if (item.to.sessionId === session.id) this.hub.kernel.route(item);
        const retire = () => this.hub.backends.stop(session.agentId);
        if (current) void current.done.promise.then(retire);
        else retire();
      }
      if (
        current &&
        !userStops?.has(session) &&
        (next?.id !== old.id ||
          (old.work?.attempt === current.first.messageId && next?.work?.attempt !== old.work.attempt))
      )
        session.halt(current.id);
    }
    for (const session of userStops ?? []) this.hub.delivery.userStop(session);
    this.hub.broadcast(Workflow.update, { workflow: view(this.read(f.owner)) });
    this.schedule(f.owner);
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
    const initial = this.read(owner);
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
        workflowNotice: true,
        invitation: n.invitation,
        prompt: [text(n.text)],
      }));
      this.save(f, mail.map(ops.enqueue));
      for (const item of mail) this.hub.kernel.route(item);
    }
    for (const item of [...this.hub.state.mail.values()]) {
      if (
        !item.workflowHeld ||
        (this.hub.state.agents.get(item.to.agentId)?.workflowOwner ?? item.to.sessionId) !== owner
      )
        continue;
      const spec = this.hub.agent(item.to.agentId);
      const f = this.read(owner),
        i = spec.workflowNode ? f.instances[spec.workflowNode] : undefined;
      if (f.paused || i?.paused || (spec.workflowNode && i?.sessionId !== item.to.sessionId)) continue;
      const next = { ...item, workflowHeld: false };
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
          bind: (agentId, sessionId) => {
            i.agentId = agentId;
            i.sessionId = sessionId;
            return ops.workflow(f);
          },
        });
        this.hub.broadcast(Workflow.update, { workflow: view(this.read(owner)) });
      } else this.save(f);
      if (!this.acceptsAttempt(session, work.attempt!)) continue;
      session.enqueue({
        origin: { kind: "system", messageId: work.attempt },
        prompt: [
          text(
            work.inserted
              ? `Resume assignment ${work.id} from this conversation. Pinned current versions: ${JSON.stringify(work.selected)}. Versions previously read: ${JSON.stringify(work.reads ?? [])}. Continue the saved assignment:\n${work.assignment.text ?? work.assignment.target}`
              : `Workflow ${work.kind} assignment ${work.id}\n${JSON.stringify(work.assignment)}\nSelected versions: ${JSON.stringify(work.selected)}\n${work.assignment.text ?? work.assignment.target}`,
          ),
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
    this.save(f);
    // After an explicit resume, ask the agent to finish handling the saved interruption.
    session.enqueue({
      origin: { kind: "system", messageId: newId("continue") },
      interruptionId: pending.id,
      prompt: [
        text("Continue handling the interrupted user message below. Verify any effects already observed."),
        ...pending.prompt,
      ],
    });
  }
  inserted(session: LiveSession, id: string) {
    const spec = this.hub.agent(session.agentId);
    if (!spec.workflowOwner) {
      const state = this.read(session.id);
      if (state.outbox.some((n) => n.posted === id)) {
        const f = structuredClone(state);
        f.outbox = f.outbox.filter((n) => n.posted !== id);
        this.save(f, [ops.ack(id)]);
      }
      return;
    }
    const f = structuredClone(this.read(spec.workflowOwner)),
      w = f.instances[spec.workflowNode!]?.work;
    if (w?.attempt === id && !w.inserted) {
      w.inserted = true;
      this.save(f);
    }
  }
  model(session: LiveSession) {
    const spec = this.hub.agent(session.agentId);
    if (!spec.workflowOwner) return;
    const i = this.read(spec.workflowOwner).instances[spec.workflowNode!];
    if (!i?.work || i.work.attempt !== session.current?.first.messageId) return;
    return {
      requested: i.work.assignment.model as string | undefined,
      inherited: this.hub.session(spec.workflowOwner).rec.selectedConfig,
    };
  }

  restart() {
    for (const state of this.hub.state.workflows.values()) {
      const f = structuredClone(state);
      if (!f.active && !f.candidate) continue;
      f.paused = true;
      // Notices acknowledged by ACP never become a second input after a crash.
      const held = [...this.hub.state.mail.values()].filter((m) => m.workflowNotice && m.to.sessionId === f.owner);
      f.outbox = f.outbox.filter(
        (n) =>
          !n.posted ||
          !["inserted", "seen", "inserted_unprocessed"].includes(this.hub.state.ledger.get(n.posted)?.state ?? ""),
      );
      for (const n of f.outbox) delete n.posted;
      for (const i of Object.values(f.instances)) if (i.work?.state === "running") suspend(i.work);
      const heldInputs = [...this.hub.state.mail.values()].filter(
        (m) =>
          !m.workflowNotice &&
          (this.hub.state.agents.get(m.to.agentId)?.workflowOwner === f.owner || m.to.sessionId === f.owner),
      );
      this.save(f, [
        ...held.map((item) => ops.ack(item.id)),
        ...heldInputs.map((item) =>
          ["inserted", "seen", "inserted_unprocessed", "discarded_unseen"].includes(
            this.hub.state.ledger.get(item.id)?.state ?? "",
          )
            ? ops.ack(item.id)
            : ops.enqueue({ ...item, workflowHeld: true }),
        ),
      ]);
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
  acceptsNotice(s: LiveSession, id: string) {
    const f = this.read(s.id);
    return !f.paused && f.outbox.some((n) => n.posted === id);
  }
  acceptsAttempt(s: LiveSession, id: string) {
    const spec = this.hub.agent(s.agentId);
    return !spec.workflowOwner || this.read(spec.workflowOwner).instances[spec.workflowNode!]?.work?.attempt === id;
  }
  clientControl(owner: string, pause: boolean, nodes?: string[]) {
    if (!graphOf(this.read(owner))) throw Error("No active workflow");
    const f = structuredClone(this.read(owner));
    control(f, pause, nodes);
    if (!pause) this.allowInterruptionRetry(f, nodes);
    this.save(f);
    return view(f);
  }
  private allowInterruptionRetry(f: Flow, nodes?: string[]) {
    for (const n of f.outbox) if (n.posted && !this.hub.state.mail.has(n.posted)) delete n.posted;
    const groups = Object.entries(f.instances)
      .filter(([name]) => !nodes || nodes.includes(name))
      .map(([, i]) => i.interruptions);
    if (!nodes) groups.push(f.interruptions);
    for (const group of groups) for (const p of group) p.retry = true;
  }
  userStop(s: LiveSession) {
    const owner = this.owner(s),
      spec = this.hub.agent(s.agentId);
    if (!graphOf(this.read(owner))) return this.hub.delivery.userStop(s);
    const f = structuredClone(this.read(owner));
    const sessions = new Set([s]);
    if (!spec.workflowOwner) {
      f.interruptions = [];
      f.outbox = [];
    }
    control(f, true, spec.workflowOwner ? [spec.workflowNode!] : undefined);
    for (const [name, i] of Object.entries(f.instances))
      if (!spec.workflowOwner || spec.workflowNode === name) {
        if (i.sessionId) sessions.add(this.hub.session(i.sessionId));
        i.extras = [];
        i.interruptions = [];
      }
    this.save(f, [], sessions);
  }
  input(s: LiveSession, id: string, blocks: ContentBlock[], target?: string) {
    this.accessible(s);
    const f = structuredClone(this.read(this.owner(s))),
      spec = this.hub.agent(s.agentId);
    const named: AssetRef[] = [];
    for (const b of blocks)
      if (b.type === "text")
        for (const match of (b.text ?? "").matchAll(/<asset>(.*?)<\/asset>/gs)) {
          const ref = JSON.parse(match[1]);
          findAsset(this.hub, ref);
          named.push(ref);
        }
    if (spec.workflowOwner) {
      const i = instance(f, spec.workflowNode!);
      const current = (i.work?.kind === "graph" ? i.work.id : undefined) ?? (i.last?.valid ? i.last.id : undefined);
      if (target && target !== "history" && target !== current) throw Error("This workflow target has expired");
      if (target !== "history" && current && !i.interruptions.some((p) => p.id === id))
        i.interruptions.push({ id, target: current, prompt: blocks });
      if (i.work && target !== "history") i.work.grants.push(...named);
    }
    if (!spec.workflowOwner && target === "workflow" && f.active)
      f.interruptions.push({ id, target: f.active, prompt: blocks });
    s.protect();
    if (named.length || spec.workflowOwner || target === "workflow") this.save(f);
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
  context(s: LiveSession, turn: Turn) {
    const spec = this.hub.agent(s.agentId);
    if (spec.workflowOwner) {
      const i = this.read(spec.workflowOwner).instances[spec.workflowNode!];
      if (!i || i.work?.attempt === turn.first.messageId) return;
      const message = i.interruptions.find((p) => p.id === (turn.first.interruptionId ?? turn.first.messageId));
      return (
        "[xSB task conversation] " +
        JSON.stringify({
          purpose: message
            ? "User interruption concerning current graph work or delivery"
            : "Direct conversation. Answer this question without changing other work.",
          target: message?.target,
          current: i.work?.assignment.target,
          last: i.last?.valid ? i.last : undefined,
        })
      );
    }
    const f = this.read(s.id);
    this.observe(f, turn);
    if (!f.active && !f.candidate) return;
    const graph = graphOf(f),
      prior = this.known.get(s);
    const epoch = s.rec.contextEpoch;
    const definitions = new Map(graph?.nodes.map((n) => [n.node, n]));
    const changed = graph?.nodes.flatMap((n) => {
      const old = prior?.epoch === epoch ? prior?.definitions.get(n.node) : undefined;
      if (!old) return [n];
      const entries = (["kind", "prompt", "input", "schema", "multi", "model"] as const)
        .filter((key) => canonical(old[key]) !== canonical(n[key]))
        .map((key) => [key, n[key] ?? null]);
      return entries.length ? [{ node: n.node, ...Object.fromEntries(entries) }] : [];
    });
    const { candidate, ...active } = view(f);
    const details = {
      ...active,
      candidate: candidate && {
        version: candidate.version,
        definitionRef: contextRef(this.hub.paths, s.agentId, JSON.stringify(candidate.graph)).ref,
      },
      definitions: changed,
      definitionRef: graph && contextRef(this.hub.paths, s.agentId, JSON.stringify(graph)).ref,
      choices: Object.entries(f.instances)
        .filter(([, i]) => i.invitation)
        .map(([node, i]) => ({ node, delivery: i.last })),
    };
    void turn.first.inserted.promise.then(
      () => {
        if (this.known.get(s) === prior) this.known.set(s, { epoch, definitions });
      },
      () => {},
    );
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
    const f = structuredClone(this.read(this.owner(s)));
    const normal = !end.failure && !turn.cancelledBy && end.stopReason === "end_turn";
    const processed = new Set(
      turn.inputs.filter((input) => input.in).map((input) => input.interruptionId ?? input.messageId),
    );
    if (!spec.workflowOwner) {
      if (normal && f.interruptions.some((p) => processed.has(p.id))) {
        f.interruptions = f.interruptions.filter((p) => !processed.has(p.id));
        this.save(f);
      }
      this.schedule(s.id);
      return;
    }
    const i = f.instances[spec.workflowNode!];
    if (i?.sessionId !== s.id) return;
    if (normal && !this.redirected.has(turn)) i.interruptions = i.interruptions.filter((p) => !processed.has(p.id));
    if (i.work?.attempt === turn.first.messageId) {
      if (normal && i.work.staged) {
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
      f = structuredClone(this.read(this.owner(s)));
    const key = fingerprint([s.agentId, receipt]);
    if (Object.hasOwn(f.receipts, key)) return f.receipts[key];
    if (spec.workflowOwner && ["execute", "choose", "prompt", "plan", "resume", "pause"].includes(name))
      throw Error("Tool unavailable for task agent");
    checkArguments(name, a);
    if (name === "read_context") return readContext(this.hub.paths, s.agentId, a.ref, a.offset, a.bytes);
    const node = spec.workflowNode,
      i = node ? instance(f, node) : undefined;
    const work = i?.work?.attempt === turn.first.messageId ? i.work : undefined;
    const effects: Op[] = [];
    let result: unknown, registered: Asset | undefined;
    if (name.startsWith("asset_")) {
      const asset = accessAsset(this.hub, f, s, turn, name, a);
      result = asset.value;
      registered = asset.registered;
      if (asset.pointer) effects.push(ops.assetPointer(asset.pointer.id, asset.pointer.version));
      if (registered) effects.push(ops.putAsset(registered));
    } else if (!node) {
      const observed = this.seen.get(turn);
      if (["plan", "execute"].includes(name)) {
        if (observed?.active !== f.active) throw Error("Active version changed");
        const steps = hubLimit("workflowValidationSteps");
        const version = adopt(f, a, steps, name === "plan");
        for (const ref of f.versions[version].nodes.flatMap((n) => refs([n.input, n.prompt])))
          findAsset(this.hub, ref);
        result = { version };
      } else if (name === "prompt") {
        for (const ref of refs(a.text)) findAsset(this.hub, ref);
        additional(f, a.node, a.text);
        result = { queued: true, id: newId("extra") };
      } else if (name === "pause" || name === "resume") {
        control(f, name === "pause", a.nodes);
        if (name === "resume") this.allowInterruptionRetry(f, a.nodes);
        result = { ok: true };
      } else if (name === "choose") {
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
    } else if (name === "finish" && work && !work.staged) {
      word(a.summary, "summary");
      if (!Array.isArray(a.assets)) throw Error("assets must be an array");
      for (const ref of a.assets) {
        const v = findAsset(this.hub, ref);
        if (v.by !== s.agentId && !work.grants.some((r) => canonical(r) === canonical(ref)))
          throw Error("Unauthorized deliverable");
      }
      const schema = nodeOf(f, node).schema;
      if (work.kind === "graph" && schema) {
        if (!Object.hasOwn(a, "result")) throw Error("This task requires a result");
        validateResult(schema, a.result);
      }
      work.staged = { summary: a.summary, assets: a.assets, result: a.result };
      result = { staged: true };
    } else if (name === "replan" && i) {
      const userInput = turn.inputs.findLast(
        (input) => input.in && (input.interruptionId || input.origin.kind === "user"),
      );
      const latest =
        userInput && i.interruptions.find((p) => p.id === (userInput.interruptionId ?? userInput.messageId));
      const target = (i.work?.kind === "graph" ? i.work.id : undefined) ?? (i.last?.valid ? i.last.id : undefined);
      if (!target || (userInput ? latest?.target !== target : work?.kind !== "graph"))
        throw Error("Graph work or delivery expired");
      this.redirected.add(turn);
      i.replan = word(a.reason, "reason");
      i.interruptions = i.interruptions.filter((p) => p !== latest);
      if (a.invalidateSelf === true) {
        if (i.last) i.last.valid = false;
        if (i.work?.kind === "graph") delete i.work;
        delete i.invitation;
      }
      notice(f, JSON.stringify({ replan: node, reason: i.replan, invalidateSelf: a.invalidateSelf === true }));
      result = { paused: node };
    } else throw Error("Tool unavailable for this execution");
    f.receipts[key] = result;
    this.save(f, effects);
    if (registered) this.hub.broadcast(Assets.update, { asset: registered });
    if (!node && (name === "plan" || name === "execute")) {
      // Adoption updates the version this caller has seen. Choice invitations arrive with their own deliveries.
      const observed = this.seen.get(turn);
      this.seen.set(turn, { active: f.active, candidate: f.candidate?.version, invites: observed?.invites ?? {} });
    }
    return result;
  }
}
