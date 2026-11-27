import type { AgentSpec, Language } from "@xsb/protocol";
import { agentInstructions, WORKFLOW_AGENT_LIMITS } from "./workflow-agent.ts";

/** Discovery text is also sent through MCP for backends that surface server instructions. */
export function workflowToolHint(worker: boolean, language: Language): string {
  if (language === "zh-CN") return worker
    ? "按当前指派使用 workflow.finish 交付。收据列出候选时，用 workflow.choose 选择下一节点。"
    : "简单请求直接完成。一项交付要用到前一项成果，或复杂工作需要跨阶段协调、并行、汇合或条件分支时，即使用户未提工作流，也主动用 MCP 工具 workflow.plan 规划。用户要求先审阅时等其确认，需要执行时用 workflow.execute。重做图中某项交付时，用 workflow.rollback 指定原节点。整图已暂停时，用 workflow.resume 恢复用户要求继续的工作。建图示例和操作细节见 workflow.guide。";
  return worker
    ? "Deliver the current assignment with workflow.finish. If its receipt lists candidates, select one with workflow.choose."
    : "Handle simple requests directly. When one deliverable uses another, or complex work needs coordination across stages, parallel tasks, joins or conditional branches, proactively use the MCP tool workflow.plan even when the user does not mention workflows. Wait if the user wants to review first. Use workflow.execute to start. To redo a workflow deliverable, use workflow.rollback on its original node. If the graph is paused, use workflow.resume to continue the work the user requests. See workflow.guide for a graph example and control details.";
}

export function workflowInstructions(agent: AgentSpec, language: Language): string {
  const hint = workflowToolHint(!!agent.workflowOwner, language);
  if (!agent.workflowOwner) return hint;
  return [hint, taskGuidance(agent.workflowNode!), agentInstructions(agent.workflowAgent)].filter(Boolean).join("\n\n");
}

/**
 * A task agent's part, and how it sorts what the user says to it directly: its own assignment is its own to handle
 * (escalating with pauseSelf where the assignment itself must change); the whole task is the main agent's (escalate);
 * anything else it simply answers. One tool for both: the only difference is whether the node stops and waits.
 */
const taskGuidance = (node: string): string => `# Your part
You are the task agent for node "${node}" of the user's workflow. The main agent runs the whole workflow from the main conversation and gives you your assignment; the user sees your conversation and may talk to you here at any time.

Follow the requirements, materials and finish instructions in your current assignment. The finish tool declaration has the parameters this session accepts. When a receipt offers branch candidates, compare the saved delivery with the cases and call choose({node}) with the selected destination. A routing continuation contains a saved delivery and requires only the remaining step. An additional assignment saves a separate delivery. Get essential missing information through the native question tools, or escalate a change in assignment scope.

# When the user talks to you
Sort each message before you act, and say briefly which it is when that is not obvious:
1. About your own assignment (its goal, input, materials, progress, your delivery): handle it yourself. Answer, explain, or do the work your assignment covers. If it changes what your assignment must deliver, or needs input or scope your assignment does not give you, do not quietly change course: call escalate({message, pauseSelf: true}) with what the user wants and why (add invalidateSelf if your current delivery must be withdrawn); you stop until the main agent decides.
2. Not about your assignment but about the overall task (other nodes, the plan, ordering, priorities, the final result): do not act on it yourself, and do not answer for the main agent. Call escalate({message}) with the user's request in their own words and anything you know that helps; your own work goes on.
3. About neither (a general question, an explanation, something unrelated): answer it directly and briefly, and change no work.
After an escalation, tell the user the main agent takes it up in the main conversation. When unsure between 1 and 2, escalate; pause yourself only when your own assignment must change. Questions about earlier versions of your delivery are your own to answer.`;

function workflowExample(language: Language): string {
  const zh = language === "zh-CN";
  const [read, travel, day, end] = zh ? ["整理需求", "跨城路线", "市内路线", "交付行程"] : ["Read request", "Intercity route", "City route", "Deliver itinerary"];
  return [
    { node: read, requirements: zh ? "需要旅游地点与日期，交付城市、日期和游览顺序。" : "Read the destinations and dates. Deliver the cities, dates and visiting order.",
      input: zh ? "5 月 2 日至 4 日，先杭州后苏州。" : "May 2–4, visit Hangzhou then Suzhou." },
    { node: travel, requirements: zh ? "根据城市、日期和游览顺序，交付含跨城交通的每日路线。" : "Use the cities, dates and visiting order to deliver a daily route including intercity transfers." },
    { node: day, requirements: zh ? "根据城市与日期，交付每日市内路线。" : "Use the city and dates to deliver a daily local route." },
    { node: end, kind: "end" },
    { from: read, to: travel, case: zh ? "游览两座或更多城市" : "The trip visits at least two cities" },
    { from: read, to: day, case: zh ? "全程游览一座城市" : "The trip stays in one city" },
    { from: travel, to: end }, { from: day, to: end },
  ].map(row => JSON.stringify(row)).join("\n");
}

/** Read on demand through guide(). The example is a complete, runnable graph in the project's language. */
export function workflowGuide(language: Language): string {
  const limits = WORKFLOW_AGENT_LIMITS;
  const instructions = language === "zh-CN" ? [
    "# 工作流指南",
    "用 graphJsonl 给 plan 或 execute 传图，每行一个 JSON 对象。节点使用简短的中文名称，边和工具调用使用相同的名称。每条路径都应到达一个终点，每种合法选路恰好到达一个终点。",
    "任务节点写 node 和 requirements。用 Markdown 声明所需参数、传递方式和交付要求。只有入度为零的任务可写 input，用 Markdown 传本次实参及文件链接。每个任务通过 finish({output}) 提交自己的正文。任务正常结束且指派仍有效时，交付被接纳。普通边自动推进。所有相关依赖就绪后，后继按稳定顺序读取生效直接前驱的交付。",
    "条件边的 case 用自然语言描述。来源任务根据交付和候选调用 choose({node})。终点写 node 和 kind，Hub 将终点的 Markdown 直接发布在主对话。",
    "用 plan({graphJsonl}) 保存一份候选图供用户审阅。execute({}) 采用当前看到的候选，execute({graphJsonl}) 直接采用完整图。若候选已过期，先展示新候选。用 execute({replaceNode}) 提交单个任务的新定义。相同职责保留原节点名，职责变化时使用新名称。修改边时提交完整图。",
    "任务可指定 model 以及 agent:{systemPrompt,skills:[{name,description,content}]}。复用的角色和技能保持创建时的内容，任务用 load_skill 按需读取技能正文。角色上限 " + limits.systemPromptTokens + " 个估算 token，技能目录上限 " + limits.skillIndexTokens + " 个，最多 " + limits.skills + " 个技能，每篇正文上限 " + limits.skillTokens + " 个。",
    "用户要求重做 Markdown 工作流中的一项交付时，在原图调用 rollback({nodes:[节点名]})，已完成的图也可回退。这会保留有效上游交付，撤回所选节点及受影响后继的交付和选路。省略 nodes 会重做全图。",
    "pause 保存进度。用 resume({nodes:[节点名]}) 继续暂停的节点。若用户停止了整图，或未完成的图因重启而暂停，局部回退后仍需 resume({}) 解除全图暂停，所有可运行节点都会继续。若用户只要求继续某条支线，先用 pause({nodes:[节点名]}) 暂停范围外的未完成分支，再恢复整图。",
    "prompt 给节点追加独立工作，结果保存在节点记录。已有旧图继续使用原图的字段与工具，主会话通过 choose({from,cases}) 处理旧图的分支邀请。",
    "节点上报 escalate 时，在主对话处理其 message 和 userSaid。paused 为 true 表示该节点等待决定，可用 execute({replaceNode}) 修改指派，或用 resume({nodes:[节点名]}) 保留指派并继续。上下文恢复时会提供当前图及候选图，必要时用 read_context 读取 graphRef。",
  ] : [
    "# Workflow guide",
    "Pass graphJsonl to plan or execute as one JSON object per line. Give tasks and ends short English names. Use the same names in edges and tool arguments. All leaves are ends, and each legal set of choices must reach exactly one end.",
    "Each task has a node name and Markdown requirements describing its parameters, how to supply them, and what it delivers. Only entry tasks (no incoming edges) may declare a Markdown input with actual values and file links. The task stages its own Markdown with finish({output}). Normal turn completion and revalidation accept it and release ordinary edges. Once the relevant dependencies settle, a successor receives the active direct predecessors’ deliveries in stable order.",
    "A conditional edge has a plain-language case. The source task considers its output and candidates, then calls choose({node}). An end has node and kind. The Hub publishes its Markdown delivery in the main conversation.",
    "Use plan({graphJsonl}) to save a candidate for review, execute({}) to adopt the candidate shown, or execute({graphJsonl}) to adopt a complete graph directly. Show an updated candidate before adopting it if the reviewed one is stale. Use execute({replaceNode}) with a complete task definition for changed requirements. Keep its name for the same responsibility and use a new name for a different role. Submit the whole graph when editing edges.",
    "A task can set model and agent:{systemPrompt,skills:[{name,description,content}]}. Reused roles and skills retain their original content. A task reads skill bodies on demand with load_skill. Estimated token limits are " + limits.systemPromptTokens + " for systemPrompt, " + limits.skillIndexTokens + " for the skill directory and " + limits.skillTokens + " per body, with up to " + limits.skills + " skills.",
    "To redo one deliverable in a Markdown workflow, call rollback({nodes:[name]}) on the existing graph, even after completion. This preserves valid upstream deliveries and withdraws deliveries and choices from the selected nodes and affected successors. Omitting nodes rolls back the whole graph.",
    "pause preserves progress. Use resume({nodes:[name]}) to continue a paused node. If the user stopped the whole graph or a restart paused an unfinished graph, call resume({}) to lift the graph-wide pause, even after a targeted rollback. This releases all runnable nodes. If the user wants to continue just one branch, first pause the other unfinished branches with pause({nodes:[name]}), then resume the graph.",
    "Use prompt for independent additional work and inspect its results on the node. Existing legacy graphs keep their original fields and tools. Their branch invitations go to the main conversation for choose({from,cases}).",
    "When a task sends an escalate notice, handle its message and userSaid in the main conversation. A paused task awaits your decision. Use execute({replaceNode}) to update the assignment or resume({nodes:[name]}) to continue with it. A restored context receives the current graph and candidate. Use read_context with graphRef to retrieve them as needed.",
  ];
  return [...instructions, "```jsonl\n" + workflowExample(language) + "\n```"].join("\n\n");
}
