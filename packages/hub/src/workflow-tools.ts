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
    "xSB workflow: save one candidate workflow (a DAG of task nodes) for review, in place of any earlier candidate. One JSON object per line: {node,prompt,input?,model?,schema?,multi?}, {node,kind:'end'}, or {from,to,case?}. xSB names the version; the workflow context shows it with the graph.",
    { graphJsonl: string },
    ["graphJsonl"],
  ),
  tool(
    "execute",
    "xSB workflow: adopt and run a workflow. With no arguments, adopt the candidate the workflow context shows; or supply a complete graphJsonl, or one complete replaceNode definition.",
    { graphJsonl: string, replaceNode: obj },
  ),
  tool(
    "choose",
    "Answer the current branch invitation. Multi-select permits an empty array.",
    { from: string, cases: strings },
    ["from", "cases"],
  ),
  tool(
    "prompt",
    "xSB workflow: queue independent additional work for one task node, using its current goal and material.",
    { node: string, text: string },
    ["node", "text"],
  ),
  tool(
    "previous_conversation",
    "Read the conversation this one continues, when the user moved it here from another agent program: a page of its record, oldest first. Start at offset 0; go on at next_offset until done.",
    { offset: { type: "integer" }, bytes: { type: "integer" } },
  ),
  tool("pause", "xSB workflow: pause all work or the listed nodes and affected descendants.", { nodes: strings }),
  tool("resume", "xSB workflow: explicitly continue paused or suspended work, globally or for specific nodes.", {
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
    "escalate",
    "xSB workflow: hand something to the main agent, which runs the whole workflow from the main conversation. Use it for the user's question or request about the overall task (other nodes, the plan, priorities, the final result), and for a change your own assignment needs (its goal, input, scope or delivery) or a need you cannot settle alone. Write it in full, with the user's own words. pauseSelf: your own assignment must change, so you stop and wait for the main agent's decision; add invalidateSelf if your current delivery must be withdrawn. Without pauseSelf your work goes on. Returns at once; then tell the user the main agent takes it up in the main conversation.",
    { message: string, pauseSelf: { type: "boolean" }, invalidateSelf: { type: "boolean" } },
    ["message"],
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
