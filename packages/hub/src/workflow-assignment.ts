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
  const zh = language === "zh-CN";
  const title = zh ? "# 工作流已完成" : "# Workflow completed";
  const overview = (zh ? "工作流版本 " : "Workflow version ") + codeSpan(report.version) +
    (zh ? " · 结束节点 " : " · End node ") + codeSpan(report.end);
  const nodes = report.deliveries.map(({ node, summary, result }) => {
    const parts = ["## " + codeSpan(node), quoted(summary)];
    if (result !== undefined) parts.push((zh ? "**结果**" : "**Result**") + "\n\n" + resultMarkdown(result));
    return parts.join("\n\n");
  });
  return [title, overview, ...nodes].join("\n\n");
}

/** The exact same readable assignment is recorded for the user and sent to ACP. No UI parsing. */
export function renderAssignment(work: Work, language: Language, resume = false, withdrawn: string[] = []): string {
  const t = labels[language], a = work.assignment;
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
    if (a.input !== undefined) {
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
    for (const [key, value] of Object.entries(a)) if (!["target", "text", "input", "schema", "revisions", "predecessors", "previous"].includes(key)) details[key] = value;
  }
  sections.push(`<details>\n<summary>${t.details}</summary>\n\n${json(details)}\n\n</details>`);
  return sections.join("\n\n");
}
