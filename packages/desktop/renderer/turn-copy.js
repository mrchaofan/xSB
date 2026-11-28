import { t } from "./i18n.js";

function link(label, uri, image = false) {
  if (!uri) return label;
  const title = label.replace(/[\\[\]]/g, "\\$&");
  const target = uri.replace(/[<>\r\n]/g, encodeURIComponent);
  return `${image ? "!" : ""}[${title}](<${target}>)`;
}

async function imageSource(block) {
  if (block.data) return `data:${block.mimeType};base64,${block.data}`;
  if (!block.url?.startsWith("xsb-artifact://history/image?")) return block.url;
  const response = await fetch(block.url, { redirect: "error" });
  if (!response.ok) throw new Error(`History image: ${response.status}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function blockText(block) {
  switch (block.type) {
    case "text": return block.text;
    case "image": return link(block.name || t("content.image.alt"), await imageSource(block), true);
    case "resource_link": return link(block.name || block.uri, block.uri);
    case "web_annotation": return [t("composer.annotation", { index: block.index, note: block.note }), block.label, block.url].filter(Boolean).join("\n");
    default: return block.uri || block.name || block.type;
  }
}

async function contentText(content) {
  return (await Promise.all(content.map(blockText))).filter(Boolean).join("\n\n");
}

function toolText(entry) {
  const lines = [entry.title || entry.name || t("tool.call"), t(`tool.status.${entry.status}`)];
  for (const [label, value] of [["tool.input", entry.input], ["tool.output", entry.terminalOutput ?? entry.output]]) {
    if (value !== undefined) lines.push(t(label), typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
  if (entry.status === "done") {
    const changes = entry.changes ?? [];
    for (const change of changes) {
      const path = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
      lines.push(`${t(`files.operation.${change.operation}`)} ${path}`);
    }
    if (entry.savedFile && !changes.some(change => change.path === entry.savedFile.path))
      lines.push(`${t("files.operation.save")} ${entry.savedFile.path}`);
  }
  return lines.join("\n");
}

async function entryText(entry) {
  switch (entry.kind) {
    case "input": {
      if (entry.reply && !entry.discarded && !entry.unsent) return "";
      const origin = entry.origin;
      let sender = t("task.initiator.user");
      if (origin.kind === "agent") {
        const key = { task: "entry.from.task", task_result: "entry.from.result" }[origin.role] ?? "entry.from.message";
        sender = t(key, { name: origin.agentId, task: origin.taskId });
      } else if (origin.kind === "system") {
        sender = t(origin.role === "task_result" ? "entry.from.systemResult" : "entry.from.system");
      }
      return [sender, await contentText(entry.content)].join("\n");
    }
    case "output": return contentText(entry.content);
    case "tool": return toolText(entry);
    case "question": {
      const lines = [t("ask.title"), t(`ask.state.${entry.state}`)];
      entry.questions.forEach((question, index) => {
        lines.push(question.question);
        if (entry.state === "answered") {
          const answer = entry.answers?.[index];
          lines.push((Array.isArray(answer) ? answer.join("\n") : answer) || t("ask.unanswered"));
        }
      });
      return lines.join("\n");
    }
    case "permission": return [entry.detail, entry.outcome && t(`permission.${entry.outcome}`)].filter(Boolean).join("\n");
    case "error": return entry.text;
    default: return "";
  }
}

/** Copy the recorded conversation, including the Markdown source and expandable tool details. */
export async function turnCopyText(entries) {
  return (await Promise.all(entries.map(entryText))).filter(Boolean).join("\n\n");
}
