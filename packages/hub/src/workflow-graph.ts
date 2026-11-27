import { createHash } from "node:crypto";
import type { Edge, NodeDef, WorkflowGraph } from "@xsb/protocol";
import { nodeAgent } from "./workflow-agent.ts";
import { bindings, checkBindingTypes, checkRouteInputs, schemaCheck } from "./workflow-bindings.ts";
export { resolveInputs, validateResult } from "./workflow-bindings.ts";

export const object = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export function word(v: unknown, label: string): string {
  if (typeof v !== "string" || !v.trim()) throw Error(`Expected nonempty ${label}`);
  return v;
}
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_key, value) =>
    object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, value[k]]),
        )
      : value,
  );
}
export const fingerprint = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

export function nodeDefinition(value: unknown, markdown = object(value) && Object.hasOwn(value, "requirements")): NodeDef {
  if (!object(value)) throw Error("Expected a node definition");
  const { node, kind = "task", input = {}, inputSchema, prompt, requirements, model, schema, multi = false, agent } = value;
  word(node, "node name");
  if (node in Object.prototype || node === "*" || !["task", "end"].includes(kind))
    throw Error("Invalid node definition");
  if (agent !== undefined && kind !== "task") throw Error("Only task nodes can configure an agent");
  if (model !== undefined) word(model, "model");
  const allowed = markdown
    ? kind === "end" ? ["node", "kind"] : ["node", "kind", "requirements", "input", "model", "agent"]
    : ["node", "kind", "input", "inputSchema", "prompt", "model", "schema", "multi", "agent"];
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) throw Error(`Unknown node field "${unknown}" on "${node}"`);

  if (markdown) {
    if (kind === "task") word(requirements, `requirements for "${node}"`);
    if (Object.hasOwn(value, "input") && typeof value.input !== "string")
      throw Error(`Node "${node}" expects Markdown text for input`);
    return {
      node, kind, input: {}, multi: false,
      ...(kind === "task" && { requirements }),
      ...(value.input !== undefined && { entryInput: value.input }),
      ...(model !== undefined && { model }),
      ...(agent !== undefined && { agent: nodeAgent(agent) }),
    };
  }
  if (!object(input) || typeof multi !== "boolean") throw Error("Invalid node definition");
  if (kind === "task") word(prompt, "task prompt");
  for (const [field, contract] of [["schema", schema], ["inputSchema", inputSchema]] as const) {
    if (contract === undefined) continue;
    if (!object(contract)) throw Error(`Node "${node}" expects a JSON Schema object for ${field}`);
    if (field === "inputSchema" && contract.type !== "object") throw Error(`Node "${node}" inputSchema must declare type "object"`);
    try { schemaCheck(contract); }
    catch (error) { throw Error(`Node "${node}" ${field}: ${(error as Error).message}`); }
  }
  return {
    node,
    kind,
    input,
    ...(inputSchema !== undefined && { inputSchema }),
    multi,
    ...(prompt !== undefined && { prompt }),
    ...(model !== undefined && { model }),
    ...(schema !== undefined && { schema }),
    ...(agent !== undefined && { agent: nodeAgent(agent) }),
  };
}

export type Signal = { state: "waiting" | "ready" | "skipped"; ref?: string };
type IncomingSignal = { edge: Edge; signal: Signal };
/** Inactive bindings do not contribute data. Fingerprint the same route and deliveries even if those bindings change. */
function signalFingerprint(signals: IncomingSignal[]) {
  if (!signals.some(({ edge, signal }) => signal.state === "skipped" && edge.bind !== undefined)) return fingerprint(signals);
  const dependencies = new Map<string, IncomingSignal>();
  for (const { edge, signal } of signals) {
    const { bind, ...route } = edge;
    const activeEdge = signal.state === "skipped" ? route : edge;
    dependencies.set(canonical(activeEdge), { edge: activeEdge, signal });
  }
  return fingerprint([...dependencies.keys()].sort().map(key => dependencies.get(key)));
}
export function entrance(signals: IncomingSignal[]): Signal {
  if (signals.length) {
    for (const group of [signals.filter((s) => s.edge.case !== undefined), signals]) {
      if (group.length && group.every((s) => s.signal.state === "skipped"))
        return { state: "skipped", ref: signalFingerprint(group) };
    }
    if (signals.some((s) => s.signal.state === "waiting")) return { state: "waiting" };
  }
  return { state: "ready", ref: signalFingerprint(signals) };
}

export function indexGraph(nodes: NodeDef[], edges: Edge[]) {
  const incoming = new Map(nodes.map((n) => [n.node, [] as Edge[]]));
  const outgoing = new Map(nodes.map((n) => [n.node, [] as Edge[]]));
  for (const e of edges) {
    if (!incoming.has(e.to) || !outgoing.has(e.from)) throw Error("Unknown edge endpoint");
    incoming.get(e.to)!.push(e);
    outgoing.get(e.from)!.push(e);
  }
  return { incoming, outgoing };
}

/** Markdown routing selects a target. All of its textual cases describe that same option. */
export function branchCandidates(edges: Edge[], name: string): { node: string; case: string }[] {
  const targets = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.from !== name || edge.case === undefined) continue;
    const cases = targets.get(edge.to);
    if (cases) cases.push(edge.case);
    else targets.set(edge.to, [edge.case]);
  }
  return Array.from(targets, ([node, cases]) => ({ node, case: cases.join("\n") }));
}

export function parseGraph(raw: string): WorkflowGraph {
  const nodes: NodeDef[] = [],
    edges: Edge[] = [];
  const seen = new Set<string>(),
    edgeSet = new Set<string>();
  const rows = word(raw, "graphJsonl").split(/\r?\n/).filter(line => line.trim()).map(line => {
    const v: unknown = JSON.parse(line);
    if (!object(v)) throw Error("Expected one graph object per line");
    return v;
  });
  const markdown = rows.some(v => Object.hasOwn(v, "node") && Object.hasOwn(v, "requirements"));
  for (const v of rows) {
    if ("node" in v) {
      const n = nodeDefinition(v, markdown);
      if (seen.has(n.node)) throw Error(`Duplicate node ${n.node}`);
      seen.add(n.node);
      nodes.push(n);
    } else {
      if (Object.keys(v).some((k) => !["from", "to", "case", "bind"].includes(k))) throw Error("Unknown edge field");
      if (markdown && Object.hasOwn(v, "bind")) throw Error("Markdown edges carry the source output and cannot declare bind");
      const e: Edge = {
        from: word(v.from, "from"),
        to: word(v.to, "to"),
        ...(v.case !== undefined && { case: word(v.case, "case") }),
      };
      if (v.bind !== undefined) e.bind = bindings(v.bind, e);
      if (!edgeSet.has(canonical(e))) edges.push(e);
      edgeSet.add(canonical(e));
    }
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  edges.sort((a, b) => compare(canonical(a), canonical(b)));
  nodes.sort((a, b) => compare(a.node, b.node));
  const { incoming, outgoing } = indexGraph(nodes, edges);
  const byName = new Map(nodes.map((n) => [n.node, n]));
  if (markdown) {
    for (const n of nodes) {
      const indegree = incoming.get(n.node)!.length;
      if (n.entryInput !== undefined && indegree > 0)
        throw Error(`Node "${n.node}" has predecessors: only an entry task can declare input`);
      if (n.kind === "end" && indegree === 0) throw Error(`End "${n.node}" needs a predecessor delivery`);
    }
  }
  const contracts = nodes.some(n => n.inputSchema !== undefined) || edges.some(e => e.bind !== undefined);
  if (contracts) {
    for (const n of nodes) {
      if (!n.inputSchema) throw Error(`Node "${n.node}" requires an inputSchema in a workflow with input contracts`);
      if (n.kind === "task" && !n.schema) throw Error(`Task "${n.node}" requires a result schema in a workflow with input contracts`);
    }
    for (const edge of edges) checkBindingTypes(edge, byName.get(edge.from)!, byName.get(edge.to)!);
  }
  const order = nodes.filter((n) => !incoming.get(n.node)!.length);
  const degrees = new Map(nodes.map((n) => [n.node, incoming.get(n.node)!.length]));
  for (const n of order) {
    const out = outgoing.get(n.node)!;
    if ((n.kind === "end") !== !out.length) throw Error("Every leaf must be an end and end nodes must be leaves");
    for (const e of out) {
      const degree = degrees.get(e.to)! - 1;
      degrees.set(e.to, degree);
      if (!degree) order.push(byName.get(e.to)!);
    }
  }
  if (order.length !== nodes.length) throw Error("Workflow contains a cycle");
  const branches = order.flatMap((n) => {
    const out = outgoing.get(n.node)!;
    const options = markdown ? branchCandidates(out, n.node).map(candidate => candidate.node) :
      [...new Set(out.flatMap(e => e.case ?? []))];
    return options.length ? [{ n, options, count: n.multi ? 2 ** options.length : options.length, i: 0 }] : [];
  });
  const checkedInputs = new Map<NodeDef, Edge[]>();
  for (;;) {
    const choices = new Map(
      branches.map(({ n, options, i }) => {
        return [
          n.node,
          new Set(
            n.multi
              ? options.filter((_o, j) => Math.floor(i / 2 ** j) % 2)
              : [options[i]],
          ),
        ] as const;
      }),
    );
    const route = () => JSON.stringify(Object.fromEntries([...choices].map(([n, s]) => [n, [...s]])));
    const skipped = new Set<string>();
    let ends = 0;
    for (const n of order) {
      const signals = incoming.get(n.node)!.map((edge) => {
        const skip = skipped.has(edge.from) ||
          (edge.case !== undefined && !choices.get(edge.from)!.has(markdown ? edge.to : edge.case));
        return { edge, signal: { state: skip ? "skipped" as const : "ready" as const } };
      });
      const gate = entrance(signals);
      if (gate.state === "skipped") skipped.add(n.node);
      else {
        if (contracts) {
          const active = signals.filter(s => s.signal.state === "ready" && s.edge.bind).map(s => s.edge);
          const previous = checkedInputs.get(n);
          // Independent branch choices often leave this node's actual bindings identical.
          if (!previous || active.length !== previous.length || active.some((edge, i) => edge !== previous[i])) {
            try { checkRouteInputs(n, active); }
            catch (error) {
              if (!choices.size) throw error;
              throw Error(`${(error as Error).message}. Branch choices: ${route()}`);
            }
            checkedInputs.set(n, active);
          }
        }
        if (n.kind === "end") ends++;
      }
    }
    if (ends !== 1)
      throw Error(`Route reaches ${ends} ends: ${route()}`);
    let j = 0;
    while (j < branches.length && ++branches[j].i === branches[j].count) branches[j++].i = 0;
    if (j === branches.length) break;
  }
  return { ...(markdown && { format: "markdown" }), nodes: order, edges };
}

/** JSONL shape exposed to the planner, omitting normalized defaults. */
export function nodeJson({ node, kind, prompt, requirements, entryInput, input, inputSchema, model, schema, multi, agent }: NodeDef) {
  return {
    node,
    ...(kind === "end" ? { kind } : requirements !== undefined ? { requirements } : { prompt }),
    ...(Object.keys(input).length > 0 && { input }),
    ...(entryInput !== undefined && { input: entryInput }),
    ...(inputSchema !== undefined && { inputSchema }),
    ...(model !== undefined && { model }),
    ...(schema !== undefined && { schema }),
    ...(agent !== undefined && { agent }),
    ...(multi && { multi }),
  };
}

/** The JSONL a model writes, which parses back to the same graph. */
export function graphJsonl({ nodes, edges }: WorkflowGraph): string {
  return [...nodes.map(nodeJson), ...edges].map((v) => JSON.stringify(v)).join("\n");
}
