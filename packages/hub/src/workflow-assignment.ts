import type { Language } from "@xsb/protocol";
import type { Completion, Work } from "./workflow-state.ts";

const labels = {
  en: { graph: "Workflow task", extra: "Additional task", resume: "Continue task", instructions: "Instructions", target: "Original task goal", input: "Input materials", predecessors: "Predecessor deliveries", previous: "Previous delivery", schema: "Output format requirements", revisions: "Assignment history", details: "Assignment details", withdrawn: "Earlier assignments were withdrawn. Work only on the assignment below.", continuing: "Continue the saved assignment in this conversation. Verify any effects already observed.", facts: "These are previously delivered results to use as material.", changed: "The requirements or predecessor deliveries changed. Follow the current instructions below." },
  "zh-CN": { graph: "工作流任务", extra: "追加任务", resume: "继续任务", instructions: "任务要求", target: "原任务目标", input: "输入材料", predecessors: "前置成果", previous: "上次交付", schema: "输出格式要求", revisions: "任务变更记录", details: "任务详情", withdrawn: "此前的任务已撤回，请只执行下面的任务。", continuing: "继续本会话中保存的任务；先核对已经发生的操作及结果。", facts: "以下为此前已交付的结果，作为本次任务的材料。", changed: "任务要求或前置成果已更新，请按下面的要求继续。" },
} as const;

function backticks(body: string, minimum: number): string {
  let longest = 0, run = 0;
  for (const char of body) { run = char === "`" ? run + 1 : 0; longest = Math.max(longest, run); }
  return "`".repeat(Math.max(minimum, longest + 1));
}

/** Fenced data never becomes Markdown instructions, even if a value contains fences. */
function json(value: unknown): string {
  const body = JSON.stringify(value, null, 2), fence = backticks(body, 3);
  return `${fence}json\n${body}\n${fence}`;
}

function quoted(body: string): string {
  return body.split(/\r\n?|\n/).map(line => `> ${line}`).join("\n");
}

function codeSpan(value: string): string {
  const body = /[\r\n\\]/.test(value) ? JSON.stringify(value) : value;
  const fence = backticks(body, 1);
  const pad = /^[` ]|[` ]$/.test(body) ? " " : "";
  return fence + pad + body + pad + fence;
}

/** The structured result is data. Indent continuation lines under their field or numbered item. */
function resultMarkdown(value: unknown, field = false): string {
  if (typeof value === "string") {
    if (!value) return codeSpan('""');
    // HTML inside a data field is a literal value. Markdown links, including angle-delimited file URIs, stay usable.
    return field ? value.replaceAll("&", "&amp;").replace(/<(?=\/?[a-z][\w.:-]*(?:\s|\/?>)|[!?])/gi, "&lt;") : value;
  }
  if (value === null || typeof value !== "object") return codeSpan(String(value));
  const list = Array.isArray(value);
  const entries = Object.entries(value);
  if (!entries.length) return codeSpan(list ? "[]" : "{}");
  return entries.map(([key, child], i) => {
    const marker = list ? String(i + 1) + "." : "-";
    const indent = " ".repeat(marker.length + 1);
    const label = list ? "" : " " + codeSpan(key);
    const body = resultMarkdown(child, true).replaceAll("\n", "\n" + indent);
    const nested = child !== null && typeof child === "object" && Object.keys(child).length > 0;
    return marker + label + (nested ? "\n" + indent : " ") + body;
  }).join("\n");
}

/** The workflow publishes final Markdown using ordinary file links. Consumers only need the conversation entry format. */
export function renderCompletion(report: Completion, language: Language): string {
  if (report.output !== undefined) return report.output;
  const zh = language === "zh-CN";
  const title = zh ? "# 工作流已完成" : "# Workflow completed";
  const overview = (zh ? "工作流版本 " : "Workflow version ") + codeSpan(report.version) +
    (zh ? " · 结束节点 " : " · End node ") + codeSpan(report.end);
  const nodes = report.deliveries.map(({ node, summary, result }) => {
    const parts = ["## " + codeSpan(node), quoted(summary)];
    if (result !== undefined) parts.push((zh ? "**结果**" : "**Result**") + "\n\n" + resultMarkdown(result));
    return parts.join("\n\n");
  });
  if (report.result !== undefined) {
    const history = nodes.length && `<details>\n<summary>${zh ? "节点交付记录" : "Task deliveries"}</summary>\n\n${nodes.join("\n\n")}\n\n</details>`;
    return [title, resultMarkdown(report.result), overview, history].filter(Boolean).join("\n\n");
  }
  return [title, overview, ...nodes].join("\n\n");
}

function markdownAssignment(work: Work, language: Language, resume: boolean, withdrawn: string[]): string {
  const zh = language === "zh-CN", t = labels[language], a = work.assignment;
  const saved = work.staged?.output ?? (work.routing ? String(a.output) : undefined);
  const candidates = (a.candidates ?? []) as { node: string; case: string }[];
  const heading = work.routing ? (zh ? "选择下一节点" : "Choose the next node") : resume ? t.resume : t[work.kind];
  const sections = ["# " + heading];
  const section = (name: string, body: string) => sections.push("## " + name + "\n\n" + body);
  if (withdrawn.length) sections.push(t.withdrawn);
  if (resume) sections.push(t.continuing);
  if (!work.routing && saved === undefined) {
    section(t.instructions, String(a.text ?? a.requirements));
    if (a.text !== undefined) section(t.target, String(a.requirements));
    if (typeof a.input === "string" && a.input.length) section(zh ? "本次输入" : "Input", a.input);
    sections.push(zh ? "完成后调用 `finish({output})` 提交完整 Markdown 产物。" : "Submit the complete Markdown delivery with `finish({output})`.");
  } else {
    section(zh ? "已保存的交付" : "Saved delivery", saved!);
  }
  if (work.staged?.selected !== undefined) {
    section(zh ? "已选下一节点" : "Selected next node", codeSpan(work.staged.selected));
    sections.push(zh ? "交付与选路已保存，核对后正常结束本轮。" : "The delivery and choice are saved. Verify them and complete this turn normally.");
  } else if (candidates.length) {
    section(zh ? "候选节点" : "Candidate nodes", candidates.map(c => "- " + codeSpan(c.node) + " — " + c.case).join("\n"));
    sections.push(saved !== undefined
      ? (zh ? "对照已保存的交付与文字条件，直接调用 `choose({node})` 完成选路。" : "Compare the saved delivery with the cases and call `choose({node})` to finish routing.")
      : (zh ? "提交产物后，对照交付与文字条件，调用 `choose({node})` 选择一个目标节点。" : "After finish, compare the delivery with the cases and select one destination with `choose({node})`."));
  } else if (saved !== undefined) {
    sections.push(zh ? "交付已保存，核对后正常结束本轮。" : "The delivery is saved. Verify it and complete this turn normally.");
  }
  return sections.join("\n\n");
}

/** Public ACP input text paired with the assistant-only assignment. */
export function assignmentTitle(node: string, work: Work, language: Language): string {
  const zh = language === "zh-CN";
  if (work.routing) return zh ? `选择 ${node} 的下一节点` : `Choose the next node for ${node}`;
  if (work.inserted) return (zh ? "继续 " : "Continue ") + node;
  if (work.kind === "extra") return (zh ? "追加 " : "Additional task for ") + node;
  return (zh ? "开始 " : "Start ") + node;
}

/** The model's assignment, including its full instructions and actual input. */
export function renderAssignment(work: Work, language: Language, resume = false, withdrawn: string[] = []): string {
  const t = labels[language], a = work.assignment;
  if (a.format === "markdown") return markdownAssignment(work, language, resume, withdrawn);
  const sections: string[] = [`# ${resume ? t.resume : t[work.kind]}`];
  const section = (title: string, body: string) => sections.push(`## ${title}\n\n${body}`);
  const delivery = (value: Record<string, unknown>): string => {
    const { node, id, result, summary } = value;
    const parts: string[] = [];
    if (node) parts.push(`### ${String(node)}`);
    parts.push(quoted(String(summary)));
    if (id !== undefined || result !== undefined) parts.push(`<details>\n<summary>${t.details}</summary>\n\n${json({ id, result })}\n\n</details>`);
    return parts.join("\n\n");
  };
  if (withdrawn.length) sections.push(t.withdrawn);
  if (resume) sections.push(t.continuing);
  else if (a.reason === "Definition or predecessor delivery changed") sections.push(t.changed);
  section(t.instructions, String(a.text ?? a.target));
  const details: Record<string, unknown> = { id: work.id, kind: work.kind, ...(withdrawn.length && { withdrawn }) };
  if (!resume) {
    if (a.text !== undefined && a.text !== a.target) section(t.target, String(a.target));
    if (a.inputSchema !== undefined) {
      const zh = language === "zh-CN";
      const sources = (a.inputSources ?? {}) as Record<string, unknown>;
      const fixed = Object.keys(a.input as Record<string, unknown>).filter(name => !Object.hasOwn(sources, name));
      section(zh ? "本次命名输入" : "Assigned input", json(a.input));
      section(zh ? "输入字段约定" : "Input schema", json(a.inputSchema));
      const provenance = [
        fixed.length && (zh ? "方案固定值 · " : "Fixed in the plan · ") + fixed.map(codeSpan).join(", "),
        Object.keys(sources).length && json(sources),
      ].filter(Boolean);
      if (provenance.length) section(zh ? "输入来源" : "Input sources", provenance.join("\n\n"));
    } else if (a.input !== undefined) {
      const input = a.input as Record<string, unknown>;
      const entries = Object.entries(input);
      if (entries.length) section(t.input, entries.map(([name, value]) => `### ${name}\n\n${typeof value === "string" ? quoted(value) : json(value)}`).join("\n\n"));
      else details.input = input;
    }
    for (const key of ["schema", "revisions"] as const) {
      const value = a[key];
      if (value !== undefined) {
        if (key === "schema") section(t[key], json(value));
        else details[key] = value;
      }
    }
    for (const key of ["predecessors", "previous"] as const) {
      const value = a[key];
      if (value !== undefined && (!Array.isArray(value) || value.length)) section(t[key], `${t.facts}\n\n${(Array.isArray(value) ? value : [value]).map(delivery).join("\n\n")}`);
    }
    // Preserve future fields as well as identifiers/model/reason without repeating the task body.
    for (const [key, value] of Object.entries(a)) if (!["target", "text", "input", "inputSchema", "inputSources", "schema", "revisions", "predecessors", "previous"].includes(key)) details[key] = value;
  }
  if (work.kind === "graph" && a.schema !== undefined) {
    sections.push(language === "zh-CN"
      ? "调用 `finish({summary,result})` 提交摘要和符合本次输出格式要求的实际结果。"
      : "Call `finish({summary,result})` with a summary and the actual result matching the assignment's output schema.");
  } else {
    sections.push(language === "zh-CN"
      ? "调用 `finish({summary})` 提交完整交付摘要。需要结构化结果时可同时传入 `result`。"
      : "Call `finish({summary})` with the complete delivery summary. Include the optional `result` when delivering structured data.");
  }
  sections.push(`<details>\n<summary>${t.details}</summary>\n\n${json(details)}\n\n</details>`);
  return sections.join("\n\n");
}
