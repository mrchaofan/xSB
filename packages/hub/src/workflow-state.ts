import type { ContentBlock, Edge, NodeDef, WorkflowGraph, WorkflowHistory, WorkflowView } from "@xsb/protocol";
import { canonical, entrance, fingerprint, indexGraph, parseGraph, resolveInputs, word } from "./workflow-graph.ts";
import type { Signal } from "./workflow-graph.ts";
import { newId, now } from "./util.ts";

type Output = { summary: string; result?: unknown };
export type Completion = { id: string; version: string; end: string; result?: unknown; deliveries: (Output & { node: string })[] };
type Delivery = Output & { id: string; basis: string; valid: boolean; choice?: { id: string; cases: string[] } };
type InputResolution = { basis: string; values: ReturnType<typeof resolveInputs> } | { basis: string; error: string; notified?: boolean };
export type Work = {
  id: string;
  kind: "graph" | "extra";
  basis?: string;
  assignment: Record<string, unknown>;
  state: "dispatch" | "running" | "suspended" | "ended";
  attempt?: string;
  staged?: Output;
  inserted?: boolean;
  /** The context epoch of the node's conversation when the assignment got into it: a renewed conversation may not have it. */
  epoch?: number;
  suspendedBy?: "pause" | "failure";
};
type Interruption = { id: string; target: string; prompt: ContentBlock[]; retry?: boolean };
type Instance = {
  id: string;
  sessionId?: string;
  agentId?: string;
  goals: string[];
  extras: Record<string, unknown>[];
  work?: Work;
  /** Assignments the node's agent had in its conversation that were withdrawn since: it is told so with its next one. */
  revoked?: string[];
  last?: Delivery;
  /** Frozen values and delivery IDs for this definition and incoming choices. */
  resolved?: InputResolution;
  /** Additional deliveries are retained in the workflow ledger, never prompted back to the caller. */
  additionalResults?: Delivery[];
  paused: boolean;
  /** The node waits for the main agent's decision: its agent escalated with pauseSelf, for this reason. */
  replan?: string;
  invitation?: string;
  interruptions: Interruption[];
};
/** `attempts`: how many times it was posted and discarded unseen (the model never got it); retried a few times on its own. */
type Notice = { id: string; text: string; invitation?: string; delivery?: string; inputFailure?: { node: string; basis: string }; posted?: string; attempts?: number };
export type Flow = {
  owner: string;
  active?: string;
  candidate?: { version: string; base?: string };
  versions: Record<string, WorkflowGraph>;
  instances: Record<string, Instance>;
  /** Versions that were active, the latest first, with their nodes as they stood when replaced. */
  history?: WorkflowHistory[];
  paused: boolean;
  error?: string;
  interruptions: Interruption[];
  receipts: Record<string, unknown>;
  outbox: Notice[];
  /**
   * What a user stop took away before the main agent heard of it (queued additional work, undelivered notices): it is
   * told so with its next workflow context, once that is in its conversation.
   */
  cancelled?: string[];
};
/** How many replaced versions a workflow keeps. */
const HISTORY_LIMIT = 50;

export function empty(owner: string): Flow {
  return {
    owner,
    versions: {},
    instances: {},
    paused: false,
    interruptions: [],
    receipts: {},
    outbox: [],
  };
}
const fresh = (): Instance => ({ id: newId("instance"), goals: [], extras: [], paused: false, interruptions: [] });
export const graphOf = (f: Flow) => (f.active ? f.versions[f.active] : undefined);
/**
 * Nothing of the workflow is left to happen: an end was reached (as `view` counts it), no node has work, more work
 * queued or a choice open, and no candidate waits to be adopted. The main conversation then talks of other things.
 */
export function settled(f: Flow): boolean {
  return executionCompleted(f) && !f.candidate;
}

/** Completion of the current graph, independent of a proposed next version. */
export function completed(f: Flow): boolean {
  return executionCompleted(f) && !f.outbox.length;
}
function executionCompleted(f: Flow): boolean {
  const graph = graphOf(f);
  return !!graph && graph.nodes.some((n) => n.kind === "end" && f.instances[n.node]?.last?.valid) &&
    !f.interruptions.length && Object.values(f.instances).every((i) => !i.work && !i.extras.length && !i.invitation && !i.interruptions.length);
}
/** Workflow information received in the current model context. A task only tracks its legacy tool guidance. */
export type WorkflowTold =
  | { epoch?: number; definitions: Map<string, NodeDef>; candidate?: string; state: string; turns: number }
  | { epoch: number; taskFileGuidance: true };
export function instance(f: Flow, name: string): Instance {
  if (!Object.hasOwn(f.instances, name)) throw Error(`Unknown active node: ${name}`);
  return f.instances[name];
}
export function nodeOf(f: Flow, name: string): NodeDef {
  const n = graphOf(f)?.nodes.find((n) => n.node === name);
  if (n?.kind !== "task") throw Error(`Unknown task: ${name}`);
  return n;
}
const definition = ({ kind, prompt, input, inputSchema, schema, model }: NodeDef) => ({ kind, prompt, input, inputSchema, schema, model });
/**
 * Plan saves `graphJsonl` as the candidate; execute adopts `graphJsonl`, `replaceNode`, or with neither the candidate.
 * Versions are named here, in order, and a graph already named keeps its name: a model never names or quotes one.
 */
export function adopt(f: Flow, args: Record<string, any>, plan: boolean) {
  const given = ["graphJsonl", "replaceNode"].filter((k) => args[k] !== undefined);
  if (plan ? given.length !== 1 || given[0] !== "graphJsonl" : given.length > 1)
    throw Error("Specify a single adoption method");
  let graph: WorkflowGraph;
  const old = graphOf(f);
  if (args.replaceNode !== undefined) {
    if (!old) throw Error("No active workflow");
    nodeOf(f, args.replaceNode?.node);
    if (args.replaceNode.kind && args.replaceNode.kind !== "task") throw Error("Replacement must be a task");
    graph = parseGraph(
      [...old.nodes.map((n) => (n.node === args.replaceNode.node ? args.replaceNode : n)), ...old.edges]
        .map((v) => JSON.stringify(v))
        .join("\n"),
    );
  } else if (args.graphJsonl !== undefined) graph = parseGraph(args.graphJsonl);
  else {
    if (!f.candidate) throw Error("No candidate to adopt");
    if (f.candidate.base !== f.active) throw Error("Candidate is stale: plan it again on the active workflow");
    graph = f.versions[f.candidate.version];
  }
  // Validate before touching versions, candidates, instances or running work.
  // Omitted immutable fields inherit; an explicit different value is rejected.
  graph = structuredClone(graph);
  const priorNodes = new Map(old?.nodes.map(n => [n.node, n]));
  for (const n of graph.nodes) {
    const prior = priorNodes.get(n.node);
    if (!prior || prior.kind !== n.kind || n.kind !== "task") continue;
    const agent = { ...prior.agent, ...n.agent };
    if (canonical({ systemPrompt: agent.systemPrompt ?? "", skills: agent.skills ?? [] }) !==
        canonical({ systemPrompt: prior.agent?.systemPrompt ?? "", skills: prior.agent?.skills ?? [] }))
      throw Error(`Agent systemPrompt and skills are immutable for reused node "${n.node}"; use a new node name for a different agent`);
    if (Object.keys(agent).length) n.agent = agent;
    else delete n.agent;
  }
  const key = canonical(graph);
  let version = Object.keys(f.versions).find((v) => canonical(f.versions[v]) === key);
  if (!version) {
    let n = Object.keys(f.versions).length + 1;
    while (Object.hasOwn(f.versions, `plan-${n}`)) n++;
    version = `plan-${n}`;
  }
  f.versions[version] = graph;
  if (plan) {
    f.candidate = { version, base: f.active };
    return version;
  }
  // The version being replaced is kept as it stands: its nodes, who did their work, and where it ended.
  if (f.active && f.active !== version) {
    const before = view(f);
    f.history = [{ version: f.active, retiredAt: now(), nodes: before.nodes, edges: before.edges }, ...(f.history ?? [])].slice(0, HISTORY_LIMIT);
  }
  const nodes: Flow["instances"] = {};
  const priorDefs = new Map(old?.nodes.map((n) => [n.node, n]));
  const oldEdges = indexGraph(old?.nodes ?? [], old?.edges ?? []);
  const edges = indexGraph(graph.nodes, graph.edges);
  for (const n of graph.nodes) {
    const prior = priorDefs.get(n.node);
    const reuse = prior?.kind === n.kind;
    const i = (nodes[n.node] = reuse ? f.instances[n.node] : fresh());
    if (n.kind === "task" && (!reuse || prior?.prompt !== n.prompt)) i.goals.push(n.prompt!);
    if (
      reuse &&
      (canonical(definition(prior!)) !== canonical(definition(n)) ||
        canonical(oldEdges.incoming.get(n.node)) !== canonical(edges.incoming.get(n.node)))
    )
      delete i.replan;
    if (
      reuse &&
      (prior!.multi !== n.multi ||
        canonical(choicesFrom(oldEdges.outgoing.get(n.node)!)) !== canonical(choicesFrom(edges.outgoing.get(n.node)!)))
    ) {
      if (i.last) delete i.last.choice;
      delete i.invitation;
    }
  }
  f.instances = nodes;
  f.active = version;
  if (f.candidate?.version === version) delete f.candidate;
  return version;
}

function choicesFrom(edges: Edge[]) {
  return [...new Set(edges.filter(e => e.case).map(e => canonical([e.to, e.case])))].sort();
}

type Gate = {
  signal: Signal;
  basis?: string;
  ancestors: Set<string>;
  direct: Set<string>;
  bindings: Edge[];
  resolved?: InputResolution;
  blocked: boolean;
  hard: boolean;
  skipHard: boolean;
  skipBlocked: boolean;
};
function boundInputs(f: Flow, n: NodeDef, edges: Edge[]) {
  return resolveInputs(n, edges.map(edge => ({ edge, delivery: f.instances[edge.from].last! })));
}
function resolveNodeInputs(f: Flow, n: NodeDef, basis: string, edges: Edge[]): InputResolution {
  try {
    return { basis, values: boundInputs(f, n, edges) };
  } catch (error) {
    return { basis, error: error instanceof Error ? error.message : String(error) };
  }
}
/** Evaluate in topological order. Every downstream signal sees upstream invalidations in this transaction. */
function evaluate(f: Flow, graph: WorkflowGraph, invalidate = false) {
  const gates = new Map<string, Gate>();
  const { incoming } = indexGraph(graph.nodes, graph.edges);
  for (const n of graph.nodes) {
    const i = f.instances[n.node];
    const signals = incoming.get(n.node)!.map((edge) => {
      const source = gates.get(edge.from)!,
        last = f.instances[edge.from].last;
      let signal: Signal = { state: "waiting" };
      if (source.signal.state === "skipped") signal = source.signal;
      else if (last?.valid) {
        if (!edge.case) signal = { state: "ready", ref: last.id };
        else if (last.choice)
          signal = { state: last.choice.cases.includes(edge.case) ? "ready" : "skipped", ref: last.choice.id };
      }
      return { edge, signal };
    });
    const signal = entrance(signals);
    const basis = signal.state === "ready" ? fingerprint([definition(n), signal.ref]) : undefined;
    if (invalidate && i.last?.valid && i.last.basis !== basis) {
      i.last.valid = false;
      delete i.invitation;
    }
    if (invalidate && i.work?.kind === "graph" && i.work.basis !== basis) {
      if (!i.work.inserted && Array.isArray(i.work.assignment.revisions))
        i.goals.unshift(...i.work.assignment.revisions);
      delete i.work;
    }
    const ancestors = new Set<string>();
    const direct = new Set<string>();
    const bindings: Edge[] = [];
    const hardHere = i.paused || !!i.replan;
    let hard = hardHere || f.paused,
      blocked = hard || !!i.interruptions.length || !!f.interruptions.length;
    // When conditional inputs prove a node skipped, its ordinary inputs do not
    // participate in that proof. Only propagate pauses on the evidence actually used.
    const conditional = signals.filter(({ edge }) => edge.case !== undefined);
    const skippedBy = new Set(
      signal.state !== "skipped"
        ? []
        : conditional.length && conditional.every((s) => s.signal.state === "skipped")
          ? conditional
          : signals,
    );
    let skipHard = false,
      skipBlocked = false;
    for (const entry of signals) {
      const { edge, signal: s } = entry;
      const src = gates.get(edge.from)!;
      // A skipped node's own pause is irrelevant. A choice from a live source remains a dependency.
      const upstreamHard = src.signal.state === "skipped" ? src.skipHard : src.hard;
      const upstreamBlocked = src.signal.state === "skipped" ? src.skipBlocked : src.blocked;
      hard ||= upstreamHard;
      blocked ||= upstreamBlocked;
      if (skippedBy.has(entry)) {
        skipHard ||= upstreamHard;
        skipBlocked ||= upstreamBlocked;
      }
      if (s.state === "ready") {
        if (edge.bind) bindings.push(edge);
        for (const ancestor of src.ancestors) ancestors.add(ancestor);
        ancestors.add(edge.from);
        direct.add(edge.from);
      }
    }
    let resolved: InputResolution | undefined;
    if (n.inputSchema && basis) {
      if (i.resolved?.basis === basis) resolved = i.resolved;
      else if (!blocked) resolved = resolveNodeInputs(f, n, basis, bindings);
    }
    if (invalidate && i.resolved !== resolved) {
      if (resolved) i.resolved = resolved;
      else delete i.resolved;
    }
    if (resolved && "error" in resolved) hard = blocked = true;
    gates.set(n.node, { signal, basis, ancestors, direct, bindings, resolved, hard, blocked, skipHard, skipBlocked });
  }
  return gates;
}

function snapshot(f: Flow, graph: WorkflowGraph, gate: Gate, includeResults = true) {
  const direct = gate.direct;
  return graph.nodes
    .filter((n) => gate.ancestors.has(n.node))
    .map((n) => {
      const { id, summary, result } = f.instances[n.node].last!;
      return { node: n.node, id, summary, ...(includeResults && direct.has(n.node) && { result }) };
    });
}
function assignmentInputs(f: Flow, n: NodeDef, gate: Gate) {
  if (!n.inputSchema) return { input: n.input };
  if (gate.resolved && "error" in gate.resolved) throw Error(gate.resolved.error);
  // An independent extra can precede graph activation. Only snapshot currently available values that satisfy its input schema.
  return { inputSchema: n.inputSchema, ...(gate.resolved?.values ?? boundInputs(f, n, gate.bindings)) };
}
export function additional(f: Flow, name: string, text: string) {
  const n = nodeOf(f, name),
    graph = graphOf(f)!,
    gate = evaluate(f, graph).get(name)!;
  instance(f, name).extras.push({
    target: n.prompt,
    model: n.model,
    ...assignmentInputs(f, n, gate),
    text: word(text, "prompt"),
    previous: previous(f, name),
    predecessors: snapshot(f, graph, gate, !n.inputSchema),
  });
}
function previous(f: Flow, name: string) {
  const last = f.instances[name].last;
  return last && { summary: last.summary };
}
export function notice(f: Flow, text: string, invitation?: string) {
  f.outbox.push({ id: newId("notice"), text, invitation });
}
export function suspend(w: Work, why: "pause" | "failure" = "pause") {
  w.suspendedBy = why;
  w.state = "suspended";
  delete w.attempt;
  delete w.staged;
}
/** Freeze the accepted path. Task assignments expose direct results only; the user gets every contributing delivery in full. */
function completion(f: Flow, end: string, version: string, ancestors: Set<string>): Completion {
  const deliveries = graphOf(f)!.nodes.filter(n => ancestors.has(n.node)).map(({ node }) => {
    const { summary, result } = f.instances[node].last!;
    return { node, summary, ...(result !== undefined && { result }) };
  });
  const last = f.instances[end].last!;
  return { id: last.id, version, end, deliveries, ...(last.result !== undefined && { result: last.result }) };
}

/** Only the old Hub put an end delivery ID in the notice outbox. Its transport envelope is not a new execution. */
export function pendingCompletion(f: Flow, notice: Notice): Completion | undefined {
  const graph = graphOf(f);
  if (!graph || !notice.delivery) return;
  const end = graph.nodes.find(n => n.kind === "end" && f.instances[n.node]?.last?.valid && f.instances[n.node].last!.id === notice.delivery);
  if (!end) return;
  // A later compatible revision can share the same end delivery. Keep the version at the time of completion.
  let version = f.active!;
  try {
    const frozen = JSON.parse(notice.text);
    if (frozen?.completed === end.node && typeof frozen.version === "string" && Object.hasOwn(f.versions, frozen.version)) version = frozen.version;
  } catch { /* Old notice text is not needed to reconstruct a verified end from the workflow ledger. */ }
  return completion(f, end.node, version, evaluate(f, graph).get(end.node)!.ancestors);
}

export function normalize(f: Flow): Completion | undefined {
  const graph = graphOf(f);
  if (!graph) return;
  let result: Completion | undefined;
  // Accept an ended work and re-evaluate before deciding which end/branch may run.
  for (;;) {
    const gates = evaluate(f, graph, true);
    const ends = graph.nodes.filter((n) => n.kind === "end");
    let finished = ends.some((n) => f.instances[n.node].last?.valid);
    if (!finished) {
      const end = ends.find((n) => gates.get(n.node)!.basis && !gates.get(n.node)!.blocked);
      if (end) {
        const gate = gates.get(end.node)!,
          predecessors = snapshot(f, graph, gate);
        const summary = predecessors.map((p) => p.node + ": " + p.summary).join("\n") || "Workflow complete";
        f.instances[end.node].last = {
          id: newId("end"),
          basis: gate.basis!,
          valid: true,
          summary,
          ...(gate.resolved && "values" in gate.resolved && { result: gate.resolved.values.input }),
        };
        result = completion(f, end.node, f.active!, gate.ancestors);
        finished = true;
      }
    }
    let changed = false;
    for (const n of graph.nodes) {
      const i = f.instances[n.node],
        w = i.work,
        gate = gates.get(n.node)!;
      if (!w) continue;
      if (finished && w.kind === "graph") {
        delete i.work;
        continue;
      }
      if (gate.hard && w.state === "running") suspend(w);
      if (w.state !== "ended" || !w.staged || gate.blocked) continue;
      const { summary, result } = w.staged;
      const delivery = { summary, result, id: newId("delivery"), valid: true, basis: w.basis! };
      if (w.kind === "graph") i.last = delivery;
      else (i.additionalResults ??= []).push(delivery);
      delete i.work;
      changed = true;
      break;
    }
    if (changed) continue;
    for (const n of graph.nodes) {
      const gate = gates.get(n.node)!,
        i = f.instances[n.node];
      if (finished && i.work?.kind === "graph") delete i.work;
      // This delivery can end the graph without that branch. A later revision can make its input actionable again.
      if (i.resolved && "error" in i.resolved) {
        if (finished) delete i.resolved;
        else if (!i.resolved.notified) {
          const inputFailure = { node: n.node, basis: i.resolved.basis };
          f.outbox.push({ id: newId("notice"), inputFailure, text: JSON.stringify({ inputError: i.resolved.error, node: n.node }) });
          i.resolved.notified = true;
        }
      }
      if (finished || !i.last?.valid || i.last.choice || gate.blocked) delete i.invitation;
      if (!finished && !gate.blocked && i.last?.valid && !i.last.choice && !i.invitation) {
        const options = [...new Set(graph.edges.filter((e) => e.from === n.node && e.case).map((e) => e.case!))];
        if (options.length) {
          i.invitation = newId("choose");
          notice(f, JSON.stringify({ choose: n.node, options, multi: n.multi, delivery: i.last }), i.invitation);
        }
      }
    }
    f.outbox = f.outbox.filter(n => !n.inputFailure || f.instances[n.inputFailure.node]?.resolved?.basis === n.inputFailure.basis);
    return result;
  }
}
export function claim(f: Flow, name: string): Work | undefined {
  const graph = graphOf(f)!,
    n = nodeOf(f, name),
    i = f.instances[name],
    gate = evaluate(f, graph).get(name)!;
  if (gate.blocked) return;
  if (!i.work) {
    const finished = graph.nodes.some((n) => n.kind === "end" && f.instances[n.node].last?.valid);
    const onGraph = !finished && !!gate.basis && !i.last?.valid;
    if (!onGraph && !i.extras.length) return;
    const assignment = onGraph
      ? {
          target: n.prompt,
          model: n.model,
          revisions: i.goals.splice(0),
          ...assignmentInputs(f, n, gate),
          schema: n.schema,
          previous: previous(f, name),
          predecessors: snapshot(f, graph, gate, !n.inputSchema),
          reason: i.last ? "Definition or predecessor delivery changed" : "Initial assignment",
        }
      : i.extras.shift()!;
    i.work = {
      id: newId("work"),
      kind: onGraph ? "graph" : "extra",
      basis: onGraph ? gate.basis : undefined,
      state: "dispatch",
      assignment,
    };
  }
  if (i.work.state !== "dispatch") return;
  i.work.state = "running";
  i.work.attempt = newId("attempt");
  return i.work;
}
export function control(f: Flow, pause: boolean, names?: string[]) {
  if (names !== undefined && (!Array.isArray(names) || !names.length))
    throw Error("Expected a nonempty list of nodes");
  for (const name of names ?? []) instance(f, name);
  if (completed(f)) return;
  const prior = !pause && names && graphOf(f) ? evaluate(f, graphOf(f)!) : undefined;
  if (!names) {
    f.paused = pause;
    if (!pause) delete f.error;
  }
  for (const [name, i] of Object.entries(f.instances)) {
    if (names && !names.includes(name)) continue;
    if (names) i.paused = pause;
    if (!pause && names) delete i.replan;
  }
  if (!pause && graphOf(f)) {
    const gates = evaluate(f, graphOf(f)!);
    for (const [name, i] of Object.entries(f.instances))
      if (
        !gates.get(name)!.hard &&
        i.work?.state === "suspended" &&
        (!names || names.includes(name) || (i.work.suspendedBy === "pause" && prior?.get(name)?.hard))
      )
        i.work.state = "dispatch";
  }
}
export function blocked(f: Flow, name: string) {
  return evaluate(f, graphOf(f)!).get(name)!.blocked;
}
export function view(f: Flow, includeContracts = true): WorkflowView {
  const graph = graphOf(f),
    gates = graph && evaluate(f, graph);
  const finished = graph?.nodes.some((n) => n.kind === "end" && f.instances[n.node].last?.valid);
  const done = completed(f);
  const held = f.paused || !!f.interruptions.length;
  const state = done ? "completed" : graph ? held ? "paused" : "running" : f.candidate ? "proposed" : "empty";
  return {
    state,
    controls: { pause: !!graph && !done && !held, resume: !!graph && !done && held },
    sessionId: f.owner,
    history: includeContracts ? f.history ?? [] : f.history?.map(h => ({
      ...h, nodes: h.nodes.map(({ contract, ...node }) => node),
    })) ?? [],
    version: f.active,
    candidate: f.candidate && { version: f.candidate.version, graph: f.versions[f.candidate.version] },
    paused: f.paused,
    interrupted: f.interruptions.length > 0,
    error: f.error,
    edges: graph?.edges ?? [],
    nodes:
      graph?.nodes.map((n) => {
        const i = f.instances[n.node],
          gate = gates!.get(n.node)!;
        const inputError = !finished && gate.resolved && "error" in gate.resolved ? gate.resolved.error : undefined;
        const status =
          i.work?.state ??
          (i.last?.valid
            ? i.invitation
              ? "choosing"
              : "completed"
            : finished
              ? "skipped"
              : inputError ? "input_error" : gate.blocked
                ? "paused"
                : gate.signal.state);
        const actionable = !finished || !!i.work || !!i.extras.length || !!i.interruptions.length;
        return {
          name: n.node,
          kind: n.kind,
          status,
          paused: i.paused || !!i.replan,
          interrupted: i.interruptions.length > 0,
          agentId: i.agentId,
          sessionId: i.sessionId,
          target: i.work?.kind === "graph" ? i.work.id : i.last?.valid ? i.last.id : undefined,
          summary: i.last?.valid ? i.last.summary : undefined,
          ...(includeContracts && n.inputSchema && { contract: {
            goal: n.prompt, inputSchema: n.inputSchema, schema: n.schema, fixedInput: n.input,
            ...(gate.resolved && "values" in gate.resolved && gate.resolved.values),
            ...(i.last?.valid && i.last.result !== undefined && { result: i.last.result }),
            ...(inputError && { error: inputError }),
          } }),
          additionalResults: i.additionalResults?.map(({ id, summary }) => ({ id, summary })),
          controls: {
            pause: n.kind === "task" && actionable && !i.paused && !f.paused,
            resume: n.kind === "task" && !f.paused && actionable &&
              (!!i.paused || !!i.replan || i.work?.state === "suspended" || !!i.interruptions.length),
          },
        };
      }) ?? [],
  };
}
