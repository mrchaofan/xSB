import assert from "node:assert/strict";
import test from "node:test";
import type { Edge } from "@xsb/protocol";
import { graphJsonl, nodeDefinition, parseGraph, resolveInputs, validateResult } from "../src/workflow-graph.ts";

const closed = (properties: Record<string, unknown> = {}, required = Object.keys(properties)) =>
  ({ type: "object", properties, required, additionalProperties: false });
const integer = { type: "integer" }, string = { type: "string" };
const task = (node: string, schema: object = integer, inputSchema: object = closed()) =>
  ({ node, prompt: node, inputSchema, schema });
const end = (inputSchema: object = closed()) => ({ node: "end", kind: "end", inputSchema });
const edge = (from: string, to: string, bind?: Record<string, string>, branch?: string): Edge =>
  ({ from, to, ...(bind && { bind }), ...(branch && { case: branch }) });
const graph = (...rows: object[]) => rows.map(row => JSON.stringify(row)).join("\n");

test("typed plans declare every endpoint, round trip bindings, and keep legacy graphs working", () => {
  const rows = [task("extract", closed({ lines: { type: "array", items: string } })), task("count", integer, closed({ items: { type: "array" } })),
    end(closed({ total: integer })), edge("extract", "count", { items: "/lines" }), edge("count", "end", { total: "" })];
  const parsed = parseGraph(graph(...rows));
  assert.deepEqual(parseGraph(graphJsonl(parsed)), parsed);
  assert.throws(() => parseGraph(graph({ node: "x", prompt: "go" }, end(), edge("x", "end"))), /x.*requires an inputSchema/);
  assert.throws(() => parseGraph(graph({ node: "x", prompt: "go", inputSchema: closed() }, end(), edge("x", "end"))), /x.*result schema/);
  assert.throws(() => parseGraph(graph({ node: "x", prompt: "go" }, { node: "end", kind: "end" }, edge("x", "end", {}))), /inputSchema/);
  assert.throws(() => parseGraph(graph(end({ type: "array" }))), /inputSchema.*object/);
  assert.throws(() => parseGraph(graph({ ...end(), inputSchema: { $async: true, type: "object" } })), /synchronous/);
  assert.doesNotThrow(() => parseGraph(graph({ node: "x", prompt: "old", schema: integer }, { node: "end", kind: "end" }, edge("x", "end"))));
});

test("required named inputs have one source on each reachable route", () => {
  const join = task("join", string, closed({ value: integer }));
  const base = [task("choose"), task("left"), task("right"), join, end(), edge("choose", "left", {}, "L"),
    edge("choose", "right", {}, "R"), edge("left", "join", { value: "" }), edge("join", "end")];
  assert.doesNotThrow(() => parseGraph(graph(...base, edge("right", "join", { value: "" }))));
  assert.throws(() => parseGraph(graph(...base, edge("right", "join"))), /join.*value/);
  assert.throws(() => parseGraph(graph(task("a"), task("b"), join, end(), edge("a", "join", { value: "" }),
    edge("b", "join", { value: "" }), edge("join", "end"))), /join.*value.*multiple/);
  assert.throws(() => parseGraph(graph(task("a"), { ...join, input: { value: 1 } }, end(),
    edge("a", "join", { value: "" }), edge("join", "end"))), /join.*value.*multiple/);
});

test("plans reject incorrect fixed values and statically impossible bindings", () => {
  const source = closed({ list: { type: "array", items: integer, maxItems: 2 } });
  const build = (pointer: string, destination: object, input?: object) => graph(task("a", source),
    { ...end(destination), input }, edge("a", "end", { total: pointer }));
  assert.throws(() => parseGraph(build("list", closed({ total: integer }))), /Invalid JSON Pointer/);
  for (const pointer of ["/~2", "/list~"]) assert.throws(() => parseGraph(build(pointer, closed({ total: integer }))), /Invalid JSON Pointer/);
  for (const pointer of ["/x", "/list/length", "/list/02", "/list/2", "/list/0/field"])
    assert.throws(() => parseGraph(build(pointer, closed({ total: integer }))), /a.*end.*total.*source schema/);
  assert.throws(() => parseGraph(build("/list/1", closed({ total: string }))), /a.*end.*total.*incompatible/);
  assert.throws(() => parseGraph(build("/list/1", closed({}))), /a.*end.*total.*incompatible/);
  assert.doesNotThrow(() => parseGraph(build("/list/0", { type: "object" })));
  assert.throws(() => parseGraph(build("/list/1", closed({ total: integer, title: string }), { title: 3 })), /end.*title.*string/);
  assert.throws(() => parseGraph(graph({ ...end(closed({ title: string })), input: { title: false } })), /end.*title.*string/);
  assert.throws(() => parseGraph(graph(task("a"), { ...end(closed({ total: integer })), schema: closed({ total: string }) },
    edge("a", "end", { total: "" }))), /end result schema/);
});

test("bindings preserve JSON types and escaped tokens, snapshot their values, and accept only own JSON members", () => {
  const n = nodeDefinition({ ...end({ type: "object" }), input: { fixed: { title: "test" } } });
  const fields = { flag: false, total: 0, text: "", nil: null, nested: [3] };
  const result = { "": [fields], "a/b~c": 4, "__not_proto": 5 };
  const bindings = { root: "", flag: "//0/flag", total: "//0/total", text: "//0/text", nil: "//0/nil", literal: "/a~1b~0c" };
  const resolve = (bind: Record<string, string>, value?: unknown) =>
    resolveInputs(n, [{ edge: edge("source", "end", bind), delivery: { id: "d1", result: value } }]);
  const { input, inputSources } = resolve(bindings, result);
  assert.deepEqual(input, { fixed: { title: "test" }, root: result, flag: false, total: 0, text: "", nil: null, literal: 4 });
  assert.deepEqual(inputSources.total, { node: "source", delivery: "d1", pointer: "//0/total" });
  assert.ok(!Object.hasOwn(inputSources, "fixed"));
  fields.nested[0] = 9;
  assert.equal((input.root as typeof result)[""][0].nested[0], 3);
  for (const pointer of ["/toString", "/constructor", "//length", "//01", "//0/missing", "//-"])
    assert.throws(() => resolve({ field: pointer }, result), /source.*end.*field.*missing/);
  assert.throws(() => resolve({ field: "" }), /missing/);
  assert.throws(() => resolve({ fixed: "" }, 1), /multiple/);
  const dangerous = resolve(JSON.parse('{"__proto__":"/__proto__"}'), JSON.parse('{"__proto__":{"injected":1}}')).input;
  assert.deepEqual(dangerous["__proto__"], { injected: 1 });
  assert.equal(Object.getPrototypeOf(dangerous), Object.prototype);
  assert.equal(dangerous.injected, undefined);
  const declared = closed(Object.fromEntries([["__proto__", integer]]));
  const resultWith = (v: unknown) => Object.fromEntries([["__proto__", v]]);
  const target = nodeDefinition(end(declared));
  const supply = (value: unknown) => resolveInputs(target, [{ edge: edge("a", "end", { ["__proto__"]: "" }), delivery: { id: "D", result: value } }]);
  assert.deepEqual(supply(0).input, resultWith(0));
  assert.throws(() => supply("0"), /__proto__.*integer/);
  assert.throws(() => validateResult(closed({ nested: declared }), { nested: resultWith(false) }), /nested\/__proto__.*integer/);
});

test("actual delivery validates complete inputs and end result, including constraints deferred during planning", () => {
  const n = nodeDefinition({ ...end(closed({ total: { type: "integer", minimum: 0 } })), schema: closed({ total: { type: "integer", maximum: 3 } }) });
  const supply = (result: unknown) => resolveInputs(n, [{ edge: edge("sum", "end", { total: "" }), delivery: { id: "D", result } }]);
  assert.deepEqual(supply(0).input, { total: 0 });
  assert.throws(() => supply(-1), /end.*\/total.*>= 0.*sum.*D/);
  assert.throws(() => supply(4), /End.*result.*\/total.*<= 3/);
  assert.throws(() => resolveInputs(n, []), /end.*\/total/);
  assert.throws(() => validateResult(closed({ rows: { type: "array", items: closed({ qty: integer }) } }), { rows: [{ qty: "5" }] }),
    /\/rows\/0\/qty.*integer/);
});

test("plan checks respect schema references, nullable values and conditions that depend on delivery data", () => {
  const referred = { definitions: { lines: closed({ quantity: integer }) }, $ref: "#/definitions/lines" };
  const build = (source: object, target: object, pointer: string, input: object = {}) => graph(task("a", source),
    { ...end(target), input }, edge("a", "end", { value: pointer }));
  assert.throws(() => parseGraph(build(referred, closed({ value: integer }), "/absent")), /source schema/);
  assert.doesNotThrow(() => parseGraph(build(referred, closed({ value: integer }), "/quantity")));
  const target = { type: "object", definitions: { shape: closed({ value: integer, label: string }) }, $ref: "#/definitions/shape" };
  assert.throws(() => parseGraph(build(integer, target, "")), /label.*required/);
  assert.throws(() => parseGraph(build(integer, target, "", { label: 5 })), /label.*string/);
  assert.doesNotThrow(() => parseGraph(build({ type: "integer", nullable: true }, closed({ value: { type: "null" } }), "")));
  const conditional = { ...closed({ value: { type: "boolean" }, label: string }),
    if: { properties: { value: { type: "null" } } }, then: { $ref: "#/properties/label" } };
  assert.doesNotThrow(() => parseGraph(build({ type: "boolean" }, conditional, "", { label: "ready" })));
});

test("plan validates propertyNames with the implicit string type from the full schema", () => {
  const names = { type: "object", propertyNames: { pattern: "^[a-z]+$", maxLength: 3 } };
  const plan = (source: string, fixed: string) => parseGraph(graph(task("A"), { ...end(names), input: { [fixed]: "s" } },
    edge("A", "end", { [source]: "" })));
  const accepted = plan("aa", "bb");
  const n = accepted.nodes.find(n => n.kind === "end")!;
  assert.deepEqual(resolveInputs(n, [{ edge: accepted.edges[0], delivery: { id: "D", result: 1 } }]).input, { bb: "s", aa: 1 });
  assert.throws(() => plan("aa", "b8"), /b8.*match pattern/);
  assert.throws(() => plan("abcd", "bb"), /abcd.*more than 3/);
  assert.throws(() => resolveInputs(n, [{ edge: edge("A", "end", { "Bad Name": "" }), delivery: { id: "D", result: 1 } }]),
    /\/Bad Name must match pattern.*from A result.*delivery D.*\/Bad Name property name must be valid/);
  assert.throws(() => validateResult(closed({ nested: names }), { nested: { "a/b": 1 } }),
    /\/nested\/a~1b must match pattern.*\/nested\/a~1b property name must be valid/);
});
