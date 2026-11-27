import { Ajv } from "ajv";
const string = { type: "string" };
const strings = { type: "array", items: string };
const obj = { type: "object" };
export const graphContractGuidance =
  "Design the graph backwards from the user's deliverable. Give every new node an object inputSchema with named properties and required fields. With no inputs, declare an empty object schema. " +
  "Put known values in input. For each value supplied by a predecessor, map the receiving field in edge.bind to a JSON Pointer into the producer's result (an empty string selects the whole result). " +
  "Give each task a result JSON Schema in schema. Describe fields in the user's terms, including units. On every active route supply all required inputs, with a single source per field. " +
  "The end publishes its named inputs. Put any final calculation, writing or decision in a task before the end.";
export const deliveryGuidance =
  "Use the assignment's named inputs and their units. In finish, write a summary for the user and put the actual deliverable in result using its declared JSON type. " +
  "Text, booleans, numbers, lists and objects can be delivered directly. Include working file links when the task produces files. " +
  "If validation fails, correct the indicated field and call finish again. The workflow starts eligible successors after it accepts the delivery.";
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
const main = [
  tool(
    "plan",
    "xSB workflow: save one candidate DAG for review, replacing the earlier candidate. Write one JSON object per line: " +
    "{node,prompt,inputSchema,schema,input?,model?,multi?,agent?}, {node,kind:'end',inputSchema,input?,schema?}, or {from,to,case?,bind?}. " +
    graphContractGuidance + " Use names in the conversation language. xSB assigns the version. " +
    "For a stable role, use agent:{systemPrompt?,skills?:[{name,description,content}]}. Limits: systemPrompt 2048 estimated tokens, up to 8 skills, directory 1024 tokens, each body 8192 tokens. Reused nodes inherit omitted role/skills and reject changes.",
    { graphJsonl: string },
    ["graphJsonl"],
  ),
  tool(
    "execute",
    "xSB workflow: adopt and run the candidate shown in the workflow context with no arguments, or supply a complete graphJsonl or one complete replaceNode definition. " +
    graphContractGuidance + " Keep the node name for the same responsibility and include its contracts when replacing it. Change edges by submitting a complete graph. " +
    "Name nodes in the conversation language. Reused nodes inherit omitted agent.systemPrompt and skills. Give a changed role or skill set a new node name.",
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
    "xSB workflow: queue independent additional work for one task node using its current goal and material. Its named inputs must already satisfy the node's inputSchema. Additional results are kept separately from the graph delivery.",
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
  tool("load_skill", "Read a fixed skill from this task agent's assignment skill directory before applying it. This loads Hub-managed instructions, not a backend-native slash command. Long content is retained with a read_context reference.", { name: string }, ["name"]),
  tool(
    "finish",
    "Stage the current assignment's delivery for acceptance on normal turn completion. " + deliveryGuidance +
    " A graph assignment with an output schema requires result. For additional work or an older assignment with no output schema, result is optional.",
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
export const workflowTools = (worker: boolean) => [...(worker ? task : main), ...common];

const validator = new Ajv();
const schemas = new Map([...main, ...task, ...common].map((t) => [t.name, validator.compile(t.inputSchema)]));
export function checkedArguments(name: string, args: Record<string, any>) {
  // Already-bound task conversations can finish with the schema they received before the upgrade.
  if (name === "finish" && Array.isArray(args.assets)) {
    args = { ...args };
    delete args.assets;
  }
  const check = schemas.get(name);
  if (!check && name.startsWith("asset_")) throw Error("Unknown workflow tool. Use your backend's file tools and share working files with Markdown links.");
  if (!check) throw Error("Unknown workflow tool");
  if (!check(args)) throw Error(validator.errorsText(check.errors));
  return args;
}
