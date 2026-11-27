import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import type { Edge, NodeDef, WorkflowGraph } from "@xsb/protocol";
import { nodeAgent } from "./workflow-agent.ts";

const validator = new Ajv({ strict: true, ownProperties: true, addUsedSchema: false });
export function validateResult(schema: object, result: unknown) {
  const check = validator.compile(schema);
  if (!check(result)) throw Error(validator.errorsText(check.errors));
}

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

export function nodeDefinition(value: unknown): NodeDef {
  if (!object(value)) throw Error("Expected a node definition");
  const { node, kind = "task", input = {}, prompt, model, schema, multi = false, agent } = value;
  word(node, "node name");
  if (
    node in Object.prototype ||
    node === "*" ||
    !["task", "end"].includes(kind) ||
    !object(input) ||
    typeof multi !== "boolean"
  )
    throw Error("Invalid node definition");
  if (Object.keys(value).some((k) => !["node", "kind", "input", "prompt", "model", "schema", "multi", "agent"].includes(k)))
    throw Error("Unknown node field");
  if (kind === "task") word(prompt, "task prompt");
  if (agent !== undefined && kind !== "task") throw Error("Only task nodes can configure an agent");
  if (model !== undefined) word(model, "model");
  if (schema !== undefined) {
    if (!object(schema)) throw Error("Expected a JSON Schema object");
    validator.compile(schema);
  }
  return {
    node,
    kind,
    input,
    multi,
    ...(prompt !== undefined && { prompt }),
    ...(model !== undefined && { model }),
    ...(schema !== undefined && { schema }),
    ...(agent !== undefined && { agent: nodeAgent(agent) }),
  };
}

export type Signal = { state: "waiting" | "ready" | "skipped"; ref?: string };
export function entrance(signals: { edge: Edge; signal: Signal }[]): Signal {
  if (signals.length) {
    for (const group of [signals.filter((s) => s.edge.case !== undefined), signals]) {
      if (group.length && group.every((s) => s.signal.state === "skipped"))
        return { state: "skipped", ref: fingerprint(group) };
    }
    if (signals.some((s) => s.signal.state === "waiting")) return { state: "waiting" };
  }
  return { state: "ready", ref: fingerprint(signals) };
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

export function parseGraph(raw: string): WorkflowGraph {
  const nodes: NodeDef[] = [],
    edges: Edge[] = [];
  const seen = new Set<string>(),
    edgeSet = new Set<string>();
  for (const line of word(raw, "graphJsonl")
    .split(/\r?\n/)
    .filter((l) => l.trim())) {
    const v = JSON.parse(line);
    if (!object(v)) throw Error("Expected one graph object per line");
    if ("node" in v) {
      const n = nodeDefinition(v);
      if (seen.has(n.node)) throw Error(`Duplicate node ${n.node}`);
      seen.add(n.node);
      nodes.push(n);
    } else {
      if (Object.keys(v).some((k) => !["from", "to", "case"].includes(k))) throw Error("Unknown edge field");
      const e: Edge = {
        from: word(v.from, "from"),
        to: word(v.to, "to"),
        ...(v.case !== undefined && { case: word(v.case, "case") }),
      };
      if (!edgeSet.has(canonical(e))) edges.push(e);
      edgeSet.add(canonical(e));
    }
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  edges.sort((a, b) => compare(canonical(a), canonical(b)));
  nodes.sort((a, b) => compare(a.node, b.node));
  const { incoming, outgoing } = indexGraph(nodes, edges);
  const byName = new Map(nodes.map((n) => [n.node, n]));
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
    const options = [...new Set(outgoing.get(n.node)!.flatMap((e) => e.case ?? []))];
    return options.length ? [{ n, options, count: n.multi ? 2 ** options.length : options.length, i: 0 }] : [];
  });
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
    const skipped = new Set<string>();
    let ends = 0;
    for (const n of order) {
      const gate = entrance(
        incoming.get(n.node)!.map((edge) => {
          const skip =
            skipped.has(edge.from) || (edge.case !== undefined && !choices.get(edge.from)!.has(edge.case));
          return { edge, signal: { state: skip ? "skipped" : "ready" } };
        }),
      );
      if (gate.state === "skipped") skipped.add(n.node);
      else if (n.kind === "end") ends++;
    }
    if (ends !== 1)
      throw Error(
        `Route reaches ${ends} ends: ${JSON.stringify(Object.fromEntries([...choices].map(([n, s]) => [n, [...s]])))}`,
      );
    let j = 0;
    while (j < branches.length && ++branches[j].i === branches[j].count) branches[j++].i = 0;
    if (j === branches.length) break;
  }
  return { nodes: order, edges };
}

/** A graph in the JSONL a model writes it in, leaving out the fields it can leave out: parsed back, it is the same graph. */
export function graphJsonl({ nodes, edges }: WorkflowGraph): string {
  const node = ({ node, kind, prompt, input, model, schema, multi, agent }: NodeDef) => ({
    node,
    ...(kind === "end" ? { kind } : { prompt }),
    ...(Object.keys(input).length > 0 && { input }),
    ...(model !== undefined && { model }),
    ...(schema !== undefined && { schema }),
    ...(agent !== undefined && { agent }),
    ...(multi && { multi }),
  });
  return [...nodes.map(node), ...edges].map((v) => JSON.stringify(v)).join("\n");
}
