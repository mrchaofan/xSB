// 草稿按工作区和主会话隔离；尚未创建会话时临时用 agent 身份。
export const draftKey = (workspace, agent) => JSON.stringify([workspace, agent.mainSessionId ?? `agent:${agent.id}`]);
const memory = new Map();
const storageKey = (key) => `xsb.draft:${key}`;

export function loadDraft(key) {
  if (memory.has(key)) return structuredClone(memory.get(key));
  try {
    const content = JSON.parse(localStorage.getItem(storageKey(key)) ?? "[]");
    return Array.isArray(content) && content.every((block) => block && typeof block.type === "string") ? content : [];
  } catch { return []; }
}

export function saveDraft(key, content) {
  memory.set(key, structuredClone(content));
  // 存储空间不足（例如大图片）时，切换对话仍能通过内存恢复。
  try {
    if (content.length) localStorage.setItem(storageKey(key), JSON.stringify(content));
    else localStorage.removeItem(storageKey(key));
  } catch { /* 保留内存草稿 */ }
}

export function moveDraft(from, to) {
  saveDraft(to, loadDraft(from));
  saveDraft(from, []);
}
