import type { ContentBlock, AssetRef, NodeDef, WorkflowGraph, WorkflowHistory, WorkflowView } from "@xsb/protocol";
import { canonical, entrance, fingerprint, indexGraph, parseGraph, word } from "./workflow-graph.ts";
import type { Signal } from "./workflow-graph.ts";
import { newId, now } from "./util.ts";

export type Output = { summary: string; assets: AssetRef[]; result?: unknown };
type Delivery = Output & { id: string; basis: string; valid: boolean; choice?: { id: string; cases: string[] } };
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
  selected: Record<string, string>;
  reads?: AssetRef[];
  grants: AssetRef[];
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
  paused: boolean;
  /** The node waits for the main agent's decision: its agent escalated with pauseSelf, for this reason. */
  replan?: string;
  invitation?: string;
  interruptions: Interruption[];
};
/** `attempts`: how many times it was posted and discarded unseen (the model never got it); retried a few times on its own. */
type Notice = { id: string; text: string; invitation?: string; delivery?: string; posted?: string; attempts?: number };
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
  const graph = graphOf(f);
  return !!graph && !f.candidate && graph.nodes.some((n) => n.kind === "end" && f.instances[n.node]?.last?.valid) &&
    Object.values(f.instances).every((i) => !i.work && !i.extras.length && !i.invitation);
}
/** What a main conversation's model was last told of its workflow, in its current context (`LiveSession.given`). */
export type WorkflowTold = { epoch?: number; definitions: Map<string, NodeDef>; candidate?: string; state: string; turns: number };
export function instance(f: Flow, name: string): Instance {
  if (!Object.hasOwn(f.instances, name)) throw Error(`Unknown active node: ${name}`);
  return f.instances[name];
}
export function nodeOf(f: Flow, name: string): NodeDef {
  const n = graphOf(f)?.nodes.find((n) => n.node === name);
  if (n?.kind !== "task") throw Error(`Unknown task: ${name}`);
  return n;
}
const definition = ({ kind, prompt, input, schema, model }: NodeDef) => ({ kind, prompt, input, schema, model });
/**
 * Plan saves `graphJsonl` as the candidate; execute adopts `graphJsonl`, `replaceNode`, or with neither the candidate.
 * Versions are named here, in order, and a graph already named keeps its name: a model never names or quotes one.
 */
export function adopt(f: Flow, args: Record<string, any>, limit: number, plan: boolean) {
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
      limit,
    );
  } else if (args.graphJsonl !== undefined) graph = parseGraph(args.graphJsonl, limit);
  else {
    if (!f.candidate) throw Error("No candidate to adopt");
    if (f.candidate.base !== f.active) throw Error("Candidate is stale: plan it again on the active workflow");
    graph = f.versions[f.candidate.version];
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
        canonical(oldEdges.outgoing.get(n.node)?.filter((e) => e.case)) !==
          canonical(edges.outgoing.get(n.node)?.filter((e) => e.case)))
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

type Gate = {
  signal: Signal;
  basis?: string;
  ancestors: Set<string>;
  direct: Set<string>;
  blocked: boolean;
  hard: boolean;
  skipHard: boolean;
  skipBlocked: boolean;
};
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
        for (const ancestor of src.ancestors) ancestors.add(ancestor);
        ancestors.add(edge.from);
        direct.add(edge.from);
      }
    }
    gates.set(n.node, { signal, basis, ancestors, direct, hard, blocked, skipHard, skipBlocked });
  }
  return gates;
}

function snapshot(f: Flow, graph: WorkflowGraph, gate: Gate) {
  const direct = gate.direct;
  return graph.nodes
    .filter((n) => gate.ancestors.has(n.node))
    .map((n) => {
      const { id, summary, assets, result } = f.instances[n.node].last!;
      return { node: n.node, id, summary, assets, ...(direct.has(n.node) && { result }) };
    });
}
export function refs(value: unknown): AssetRef[] {
  if (typeof value === "string")
    return [...value.matchAll(/<asset>(.*?)<\/asset>/gs)].flatMap((m) => {
      const ref = JSON.parse(m[1]);
      if (!ref || typeof ref.name !== "string" || typeof ref.version !== "string")
        throw Error("Invalid asset reference");
      return [{ name: ref.name, version: ref.version }];
    });
  if (Array.isArray(value)) return value.flatMap(refs);
  if (!value || typeof value !== "object") return [];
  const v = value as Record<string, unknown>;
  if (typeof v.name === "string" && typeof v.version === "string") return [{ name: v.name, version: v.version }];
  return Object.values(v).flatMap(refs);
}
export function additional(f: Flow, name: string, text: string) {
  const n = nodeOf(f, name),
    graph = graphOf(f)!;
  instance(f, name).extras.push({
    target: n.prompt,
    model: n.model,
    input: n.input,
    text: word(text, "prompt"),
    previous: previous(f, name),
    predecessors: snapshot(f, graph, evaluate(f, graph).get(name)!),
  });
}
function previous(f: Flow, name: string) {
  const last = f.instances[name].last;
  return last && { summary: last.summary, assets: last.assets };
}
export function notice(f: Flow, text: string, invitation?: string, delivery?: string) {
  f.outbox.push({ id: newId("notice"), text, invitation, delivery });
}
export function suspend(w: Work, why: "pause" | "failure" = "pause") {
  w.suspendedBy = why;
  w.state = "suspended";
  delete w.attempt;
  delete w.staged;
}
export function normalize(f: Flow) {
  const graph = graphOf(f);
  if (!graph) return;
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
          assets: predecessors.flatMap((p) => p.assets),
        };
        notice(
          f,
          JSON.stringify({ completed: end.node, version: f.active, predecessors }),
          undefined,
          f.instances[end.node].last!.id,
        );
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
      const delivery = { ...w.staged, id: newId("delivery"), valid: true, basis: w.basis! };
      if (w.kind === "graph") i.last = delivery;
      else notice(f, JSON.stringify({ additionalResult: n.node, ...w.staged, id: delivery.id }));
      delete i.work;
      changed = true;
      break;
    }
    if (changed) continue;
    for (const n of graph.nodes) {
      const gate = gates.get(n.node)!,
        i = f.instances[n.node];
      if (finished && i.work?.kind === "graph") delete i.work;
      if (finished || !i.last?.valid || i.last.choice || gate.blocked) delete i.invitation;
      if (!finished && !gate.blocked && i.last?.valid && !i.last.choice && !i.invitation) {
        const options = [...new Set(graph.edges.filter((e) => e.from === n.node && e.case).map((e) => e.case!))];
        if (options.length) {
          i.invitation = newId("choose");
          notice(f, JSON.stringify({ choose: n.node, options, multi: n.multi, delivery: i.last }), i.invitation);
        }
      }
    }
    return;
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
          input: n.input,
          schema: n.schema,
          previous: previous(f, name),
          predecessors: snapshot(f, graph, gate),
          reason: i.last ? "Definition or predecessor delivery changed" : "Initial assignment",
        }
      : i.extras.shift()!;
    i.work = {
      id: newId("work"),
      kind: onGraph ? "graph" : "extra",
      basis: onGraph ? gate.basis : undefined,
      state: "dispatch",
      assignment,
      selected: {},
      grants: [
        ...refs(assignment.input),
        ...refs(assignment.target),
        ...refs("text" in assignment ? assignment.text : undefined),
        ...refs((assignment.previous as Output | undefined)?.assets),
        ...(assignment.predecessors as Output[]).flatMap((p) => p.assets),
      ],
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
export function view(f: Flow): WorkflowView {
  const graph = graphOf(f),
    gates = graph && evaluate(f, graph);
  const finished = graph?.nodes.some((n) => n.kind === "end" && f.instances[n.node].last?.valid);
  return {
    sessionId: f.owner,
    history: f.history ?? [],
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
        const status =
          i.work?.state ??
          (i.last?.valid
            ? i.invitation
              ? "choosing"
              : "completed"
            : finished
              ? "skipped"
              : gate.blocked
                ? "paused"
                : gate.signal.state);
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
        };
      }) ?? [],
  };
}
