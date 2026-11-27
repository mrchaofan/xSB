import { Ajv } from "ajv";
const string = { type: "string" };
const strings = { type: "array", items: string };
const obj = { type: "object" };
const graphRows = "Use one JSON object per line: task {node,requirements,input?}, end {node,kind:'end'}, edge {from,to,case?}. Use Markdown input only on entry tasks. Call guide for a complete example.";
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
const main = [
  { ...tool("guide", "Read the workflow authoring guide, a runnable JSONL example in the project's language and guidance for handling node notices.", {}), annotations: { readOnlyHint: true } },
  tool(
    "plan",
    "xSB workflow: save a candidate DAG for review with node names in the conversation language. " + graphRows,
    { graphJsonl: string },
    ["graphJsonl"],
  ),
  tool(
    "execute",
    "xSB workflow: execute the reviewed candidate with no arguments. To run a graph directly, supply graphJsonl with names in the conversation language. To revise a task, supply its complete replaceNode definition. " + graphRows,
    { graphJsonl: string, replaceNode: obj },
  ),
  tool(
    "choose",
    "For a legacy workflow only, answer its branch invitation. Multi-select permits an empty array.",
    { from: string, cases: strings },
    ["from", "cases"],
  ),
  tool(
    "prompt",
    "xSB workflow: queue independent additional work for a task node using its current goal and material. Its result is kept separately from the graph delivery.",
    { node: string, text: string },
    ["node", "text"],
  ),
  tool(
    "previous_conversation",
    "Read the conversation this one continues, when the user moved it here from another agent program: a page of its record, oldest first. Start at offset 0; go on at next_offset until done.",
    { offset: { type: "integer" }, bytes: { type: "integer" } },
  ),
  tool("rollback", "xSB workflow: rerun the listed Markdown nodes and their downstream work, or the whole active Markdown workflow if nodes is omitted. This withdraws their current deliveries and choices.", { nodes: strings }),
  tool("pause", "xSB workflow: pause all work or the listed nodes and affected descendants.", { nodes: strings }),
  tool("resume", "xSB workflow: explicitly continue paused or suspended work, globally or for specific nodes.", {
    nodes: strings,
  }),
];
const task = [
  tool("load_skill", "Read a fixed skill from this task agent's assignment skill directory before applying it. This loads Hub-managed instructions, not a backend-native slash command. Long content is retained with a read_context reference.", { name: string }, ["name"]),
  tool(
    "finish",
    "Stage the legacy assignment summary and its structured result for acceptance on normal turn completion. A declared output schema requires a result of its declared type.",
    {
      summary: string,
      result: {},
    },
    ["summary"],
  ),
  tool(
    "escalate",
    "xSB workflow: hand something to the main agent, which runs the whole workflow from the main conversation. Use it for the user's question or request about the overall task (other nodes, the plan, priorities, the final result), and for a change your own assignment needs (its goal, input, scope or delivery) or a need you cannot settle alone. Write it in full, with the user's own words. pauseSelf: your own assignment must change, so you stop and wait for the main agent's decision; add invalidateSelf if your current delivery must be withdrawn. Without pauseSelf your work goes on. Returns at once; then tell the user the main agent takes it up in the main conversation.",
    { message: string, pauseSelf: { type: "boolean" }, invalidateSelf: { type: "boolean" } },
    ["message"],
  ),
];
const common = [
  tool(
    "read_context",
    "Read a page of your own quoted context by UTF-8 offset.",
    { ref: string, offset: { type: "integer" }, bytes: { type: "integer" } },
    ["ref"],
  ),
];
const markdownFinish = tool("finish",
  "Save this assignment's Markdown output on its own node. Include links for files you produced. If the receipt lists candidates, select a target with choose before ending this turn.",
  { output: string }, ["output"]);
const markdownChoose = tool("choose",
  "Select one of this task's conditional targets after submitting its output. Use the exact candidate node name. Your assignment identifies the source.",
  { node: string }, ["node"]);
const workersLegacy = [...task, ...common];
const workersMarkdown = [...task.filter(t => t.name !== "finish"), markdownFinish, markdownChoose, ...common];
const planners = [...main, ...common];

// Main sessions can change graph format during a single backend connection. Keep their tool list stable.
export function workflowTools(worker: boolean, markdown = true) {
  if (!worker) return planners;
  return markdown ? workersMarkdown : workersLegacy;
}

const validator = new Ajv();
const checksFor = (list: typeof task) => new Map(list.map(t => [t.name, validator.compile(t.inputSchema)]));
const mainChecks = checksFor(planners);
const markdownChecks = checksFor(workersMarkdown);
const legacyChecks = checksFor(workersLegacy);
export function checkedArguments(name: string, args: Record<string, any>, worker: boolean, markdown: boolean) {
  // Already-bound task conversations can finish with the schema they received before the upgrade.
  if (worker && !markdown && name === "finish" && Array.isArray(args.assets)) {
    args = { ...args };
    delete args.assets;
  }
  const checks = worker ? markdown ? markdownChecks : legacyChecks : mainChecks;
  const check = checks.get(name);
  if (!check && name.startsWith("asset_")) throw Error("Unknown workflow tool. Use your backend's file tools and share working files with Markdown links.");
  if (!check) throw Error("Unknown or unavailable workflow tool: " + name);
  if (!check(args)) throw Error(validator.errorsText(check.errors));
  return args;
}
