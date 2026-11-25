import { Ajv } from "ajv";
const string = { type: "string" };
const strings = { type: "array", items: string };
const obj = { type: "object" };
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
const main = [
  tool(
    "plan",
    "Save one candidate workflow for review. One JSON object per line: {node,prompt,input?,model?,schema?,multi?}, {node,kind:'end'}, or {from,to,case?}.",
    { version: string, graphJsonl: string },
    ["version", "graphJsonl"],
  ),
  tool(
    "execute",
    "Adopt the reviewed version, a complete graphJsonl, or one complete replaceNode definition. Supply exactly one.",
    { version: string, graphJsonl: string, replaceNode: obj },
  ),
  tool(
    "choose",
    "Answer the current branch invitation. Multi-select permits an empty array.",
    { from: string, cases: strings },
    ["from", "cases"],
  ),
  tool(
    "prompt",
    "Queue independent additional work for one task using its current goal and material.",
    { node: string, text: string },
    ["node", "text"],
  ),
  tool("pause", "Pause all work or the listed nodes and affected descendants.", { nodes: strings }),
  tool("resume", "Explicitly continue paused or suspended work, globally or for specific nodes.", {
    nodes: strings,
  }),
];
const task = [
  tool(
    "finish",
    "Stage this assignment's delivery. It is accepted only on a normal end.",
    {
      summary: string,
      assets: {
        type: "array",
        items: {
          type: "object",
          properties: { name: string, version: string },
          required: ["name", "version"],
          additionalProperties: false,
        },
      },
      result: {},
    },
    ["summary", "assets"],
  ),
  tool(
    "replan",
    "Request a change to your own current graph work or delivery. Set invalidateSelf if it must be withdrawn.",
    { reason: string, invalidateSelf: { type: "boolean" } },
    ["reason"],
  ),
];
const common = [
  tool("asset_list", "List accessible registered versions in creation order.", { name: string }, ["name"]),
  tool(
    "asset_version_get",
    "Read the currently registered version, pinned on first use in this work.",
    { name: string },
    ["name"],
  ),
  tool(
    "asset_get",
    "Read one precise immutable version. Media is returned by absolute path.",
    { name: string, version: string },
    ["name", "version"],
  ),
  tool(
    "asset_put",
    "Register a new immutable version from a file. A null path clears its current pointer when authorized.",
    { name: string, path: { type: ["string", "null"] } },
    ["name", "path"],
  ),
  tool("asset_version_put", "Select an existing version as current.", { name: string, version: string }, [
    "name",
    "version",
  ]),
  tool(
    "read_context",
    "Read a page of your own quoted context by UTF-8 offset.",
    { ref: string, offset: { type: "integer" }, bytes: { type: "integer" } },
    ["ref"],
  ),
];
export const workflowTools = (worker: boolean) => [...(worker ? task : main), ...common];

const validator = new Ajv();
const schemas = new Map([...main, ...task, ...common].map((t) => [t.name, validator.compile(t.inputSchema)]));
export function checkArguments(name: string, args: unknown) {
  const check = schemas.get(name);
  if (!check) throw Error("Unknown workflow tool");
  if (!check(args)) throw Error(validator.errorsText(check.errors));
}
