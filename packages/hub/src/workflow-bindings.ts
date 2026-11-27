import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { Edge, NodeDef } from "@xsb/protocol";

const schemaId = "urn:xsb:workflow-schema";
type Prepared = { check: ValidateFunction; schema: object; fragments?: Ajv };
const compiled = new Map<string, Prepared>();
const escapeToken = (key: string): string => key.replaceAll("~", "~0").replaceAll("/", "~1");
const fragment = (path: string[]): string => schemaId + "#/" + path.map(key => encodeURIComponent(escapeToken(key))).join("/");

/** Ajv deliberately omits __proto__ from its generated properties checks. Keep the original
 * member for fragment refs and validate it with an equivalent exact pattern on the compiler copy. */
function literalProtoProperties(root: object) {
  const copy = structuredClone(root);
  let changed = false;
  const visit = (node: any, path: string[]) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const key of ["items", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "contains", "additionalItems", "additionalProperties", "propertyNames"]) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach((part, i) => visit(part, [...path, key, String(i)]));
      else visit(child, [...path, key]);
    }
    for (const key of ["definitions", "$defs", "properties", "patternProperties", "dependencies"])
      for (const [name, child] of Object.entries(node[key] ?? {})) visit(child, [...path, key, name]);
    if (node.properties && Object.hasOwn(node.properties, "__proto__")) {
      changed = true;
      const patterns = node.patternProperties ??= {};
      let pattern = "^__proto__$";
      while (Object.hasOwn(patterns, pattern)) pattern = "(?:" + pattern + ")";
      patterns[pattern] = { $ref: fragment([...path, "properties", "__proto__"]) };
    }
  };
  visit(copy, []);
  return changed ? copy : undefined;
}

/** State snapshots clone their schemas. Share compiled checks by value across attempts and bound the cache. */
function prepared(schema: object): Prepared {
  const key = JSON.stringify(schema);
  const existing = compiled.get(key);
  if (existing) return existing;
  // IDs and refs in one node's schema must not resolve against another node's definitions.
  const normalized = key.includes('"__proto__":') ? literalProtoProperties(schema) : undefined;
  const validator = new Ajv({ strict: true, ownProperties: true, allErrors: true, allowMatchingProperties: !!normalized });
  const source = normalized ?? schema;
  validator.addSchema(source, schemaId);
  const check = validator.getSchema(schemaId)!;
  if ("$async" in check) throw Error("Workflow schemas must be synchronous");
  if (compiled.size === 128) compiled.delete(compiled.keys().next().value!);
  const entry = { check, schema: source };
  compiled.set(key, entry);
  return entry;
}

export const schemaCheck = (schema: object): ValidateFunction => prepared(schema).check;
function errorPath(error: ErrorObject): string {
  const key = error.params.missingProperty ?? error.params.additionalProperty ?? error.propertyName ?? error.params.propertyName;
  return error.instancePath + (key === undefined ? "" : "/" + escapeToken(key));
}
const explain = (error: ErrorObject): string => (errorPath(error) || "(root)") + " " + error.message;

export function validateResult(schema: object, result: unknown) {
  const check = schemaCheck(schema);
  if (!check(result)) throw Error("Result " + check.errors!.map(explain).join(", "));
}

function tokens(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/") || /~(?![01])/.test(pointer)) throw Error("Invalid JSON Pointer " + JSON.stringify(pointer));
  return pointer.slice(1).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function bindings(value: unknown, edge: Edge): Record<string, string> {
  const label = `Binding ${edge.from} → ${edge.to}`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw Error(label + " expects a map of input fields to JSON Pointers");
  return Object.fromEntries(Object.entries(value).map(([key, pointer]) => {
    if (typeof pointer !== "string") throw Error(`${label} expects a JSON Pointer string for input field "${key}"`);
    try { tokens(pointer); }
    catch (error) { throw Error(`${label} input "${key}": ${(error as Error).message}`); }
    return [key, pointer];
  }));
}

const arrayIndex = /^(?:0|[1-9]\d*)$/;
function readPointer(value: unknown, path: string[]): unknown {
  for (const key of path) {
    if (value === null || typeof value !== "object" || (Array.isArray(value) && !arrayIndex.test(key)) || !Object.hasOwn(value, key))
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

type Source = { edge: Edge; delivery: { id: string; result?: unknown } };
type Origin = { node: string; delivery: string; pointer: string };

function checkInput(schema: object, input: Record<string, unknown>, context: string, origins?: Map<string, Origin>) {
  const check = schemaCheck(schema);
  if (!check(input)) throw Error(context + ": " + check.errors!.map(error => {
    const source = origins?.get(tokens(errorPath(error))[0]);
    return explain(error) + (source ? ` (from ${source.node} result ${JSON.stringify(source.pointer)}, delivery ${source.delivery})` : "");
  }).join(", "));
}

export function resolveInputs(n: NodeDef, sources: Source[]): { input: Record<string, unknown>; inputSources: Record<string, Origin> } {
  const fields = new Map(Object.entries(n.input));
  const origins = new Map<string, Origin>();
  for (const { edge, delivery } of sources) for (const [field, pointer] of Object.entries(edge.bind ?? {})) {
    const context = `Binding ${edge.from} result ${JSON.stringify(pointer)} → ${n.node} input ${JSON.stringify(field)}`;
    if (fields.has(field)) throw Error(context + " has multiple sources; already supplied by " + (origins.get(field)?.node ?? "fixed input"));
    const value = Object.hasOwn(delivery, "result") ? readPointer(delivery.result, tokens(pointer)) : undefined;
    if (value === undefined) throw Error(context + " is missing from delivery " + delivery.id);
    fields.set(field, value);
    origins.set(field, { node: edge.from, delivery: delivery.id, pointer });
  }
  const input = structuredClone(Object.fromEntries(fields));
  if (n.inputSchema) checkInput(n.inputSchema, input, `Node "${n.node}" input`, origins);
  if (n.inputSchema && n.kind === "end" && n.schema) checkInput(n.schema, input, `End "${n.node}" result`, origins);
  return { input, inputSources: Object.fromEntries(origins) };
}

// Conservative plan-time type inference. An unrestricted subschema can yield any JSON type.
// Keeping integer and noninteger disjoint makes the intersection with type:number precise.
const jsonTypes = ["object", "array", "string", "integer", "number", "boolean", "null"];
function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

type Schema = boolean | Record<string, any> | undefined;
function localReference(ref: unknown, root: Schema): { rule: Schema; path: string[] } | undefined {
  if (typeof ref !== "string" || (ref !== "#" && !ref.startsWith("#/"))) return;
  // These are URI fragments in Ajv schema refs. Edge pointers, in contrast, are plain JSON Pointers.
  const path = ref === "#" ? [] : ref.slice(2).split("/").map(key => decodeURIComponent(key).replaceAll("~1", "/").replaceAll("~0", "~"));
  let target: unknown = root;
  for (const key of path) {
    target = readPointer(target, [key]);
    // Nested resources have their own base URI. Leave their references to Ajv.
    if (target && typeof target === "object" && Object.hasOwn(target, "$id")) return;
  }
  if (typeof target === "boolean" || (target && typeof target === "object")) return { rule: target as Schema, path };
}
/** Object keywords that constrain this named member, with their locations in the original schema. */
function propertyRules(schema: Record<string, any>, key: string): { rule: Schema; location: string[] }[] {
  const rules = [];
  if (schema.properties && Object.hasOwn(schema.properties, key)) rules.push({ rule: schema.properties[key], location: ["properties", key] });
  for (const [pattern, rule] of Object.entries(schema.patternProperties ?? {})) {
    if (new RegExp(pattern, "u").test(key)) rules.push({ rule: rule as Schema, location: ["patternProperties", pattern] });
  }
  if (!rules.length && schema.additionalProperties !== undefined) rules.push({ rule: schema.additionalProperties, location: ["additionalProperties"] });
  return rules;
}

function possibleTypes(schema: Schema, path: string[], root: Schema = schema, refs = new Set<string>()): string[] {
  if (schema === false) return [];
  if (!schema || schema === true) return jsonTypes;
  const declared: string[] = [schema.type ?? jsonTypes].flat();
  let types = declared.includes("number") ? [...new Set([...declared, "integer"])] : declared;
  if (schema.nullable) types = [...types, "null"];
  if (schema.$id) root = schema;
  if (path.length) {
    const [key, ...tail] = path;
    const children: string[] = [];
    if (types.includes("object") && schema.maxProperties !== 0) {
      const alternatives = propertyRules(schema, key).map(({ rule }) => possibleTypes(rule, tail, root, refs));
      children.push(...jsonTypes.filter(type => alternatives.every(set => set.includes(type))));
    }
    if (types.includes("array") && arrayIndex.test(key) && Number(key) < (schema.maxItems ?? Infinity)) {
      const items = Array.isArray(schema.items) ? (schema.items[Number(key)] ?? schema.additionalItems) : schema.items;
      children.push(...possibleTypes(items, tail, root, refs));
    }
    types = [...new Set(children)];
  }
  const options: unknown[] | undefined = Object.hasOwn(schema, "const") ? [schema.const] : schema.enum;
  if (options) {
    const values = options.map(value => readPointer(value, path)).filter(value => value !== undefined);
    types = types.filter(type => values.some(value => typeOf(value) === type));
  }
  if (schema.$ref && !refs.has(schema.$ref)) {
    const target = localReference(schema.$ref, root);
    if (target !== undefined) {
      const allowed = possibleTypes(target.rule, path, root, new Set([...refs, schema.$ref]));
      types = types.filter(type => allowed.includes(type));
    }
  }
  for (const rule of schema.allOf ?? []) {
    const allowed = possibleTypes(rule, path, root, refs);
    types = types.filter(type => allowed.includes(type));
  }
  for (const rules of [schema.anyOf, schema.oneOf]) if (rules) {
    const allowed = rules.flatMap((rule: Schema) => possibleTypes(rule, path, root, refs));
    types = types.filter(type => allowed.includes(type));
  }
  return types;
}

/** Bound values are unknown during planning. Check unconditional presence constraints on the full
 * set of names and validate each fixed member against the applicable fragments of the original
 * schema. Conditions involving an unknown value are evaluated by Ajv on the actual delivery. */
function checkPartial(schema: object, fields: Map<string, unknown>, bound: Set<string>, context: string) {
  if (!bound.size) return checkInput(schema, Object.fromEntries(fields), context);
  const compiled = prepared(schema);
  const fail = (message: string): never => { throw Error(context + ": " + message); };
  const checkFragment = (path: string[], value: unknown, field: string) => {
    // The complete schema passed strict lints in context. Re-linting a fragment by itself would
    // discard inherited types (propertyNames, for example, always receives a string).
    const validator = compiled.fragments ??= new Ajv({ strict: false, ownProperties: true, allErrors: true }).addSchema(compiled.schema, schemaId);
    const check = validator.getSchema(fragment(path));
    if (!check) return;
    if (!check(value)) fail("/" + escapeToken(field) + " " + check.errors!.map(explain).join(", "));
  };
  const visited = new Set<Schema>();
  const inspect = (rule: Schema, location: string[], resource: Schema, base: string[]) => {
    if (rule === false) return fail("schema disallows this input object");
    if (!rule || rule === true || visited.has(rule)) return;
    visited.add(rule);
    if (rule.$id) { resource = rule; base = location; }
    if (!possibleTypes(rule, [], resource).includes("object")) fail("schema must accept an object");
    for (const key of rule.required ?? []) if (!fields.has(key)) fail("/" + escapeToken(key) + " is required");
    if (fields.size < rule.minProperties || fields.size > rule.maxProperties) fail("the number of supplied properties is outside the schema bounds");
    for (const [key, value] of fields) {
      if (rule.propertyNames !== undefined) checkFragment([...location, "propertyNames"], key, key);
      for (const member of propertyRules(rule, key)) {
        if (member.rule === false) fail("/" + escapeToken(key) + " is disallowed by the schema");
        if (!bound.has(key)) checkFragment([...location, ...member.location], value, key);
      }
    }
    for (const [index, part] of (rule.allOf ?? []).entries()) inspect(part, [...location, "allOf", String(index)], resource, base);
    const target = localReference(rule.$ref, resource);
    if (target !== undefined) inspect(target.rule, [...base, ...target.path], resource, base);
  };
  inspect(schema, [], schema, []);
}

export function checkBindingTypes(edge: Edge, source: NodeDef, n: NodeDef) {
  for (const [field, pointer] of Object.entries(edge.bind ?? {})) {
    const context = `Binding ${edge.from} result ${JSON.stringify(pointer)} → ${n.node} input ${JSON.stringify(field)}`;
    const available = possibleTypes(source.schema as Schema, tokens(pointer));
    if (!available.length) throw Error(context + " cannot be supplied by the source schema");
    for (const schema of n.kind === "end" && n.schema ? [n.inputSchema, n.schema] : [n.inputSchema]) {
      const accepted = possibleTypes(schema as Schema, [field]);
      if (!available.some(type => accepted.includes(type))) throw Error(context + " is incompatible with the " + (schema === n.inputSchema ? "input" : "end result") + " schema");
    }
  }
}

export function checkRouteInputs(n: NodeDef, edges: Edge[]) {
  const bound = new Set<string>();
  const fields = new Map(Object.entries(n.input));
  for (const edge of edges) for (const field of Object.keys(edge.bind ?? {})) {
    if (fields.has(field)) {
      const prior = Object.hasOwn(n.input, field) ? "fixed input" : edges.find(other => other !== edge && Object.hasOwn(other.bind ?? {}, field))!.from;
      throw Error(`Binding ${edge.from} → ${n.node} input ${JSON.stringify(field)} has multiple sources on this route; already supplied by ${prior}`);
    }
    bound.add(field);
    fields.set(field, null); // placeholder for property presence; dynamic field values are checked after delivery
  }
  checkPartial(n.inputSchema!, fields, bound, `Node "${n.node}" input on this route`);
  if (n.kind === "end" && n.schema) checkPartial(n.schema, fields, bound, `End "${n.node}" result on this route`);
}
