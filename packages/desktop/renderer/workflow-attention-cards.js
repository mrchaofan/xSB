import { h, ICON } from "./dom.js";
import { t } from "./i18n.js";

/** Keep a button for each pending workflow request so sibling updates preserve keyboard focus. */
export function syncWorkflowAttentionCards(lane, requests, open) {
  let stack = lane.querySelector(".workflow-requests");
  if (!requests.length) { stack?.remove(); return; }
  if (!stack) {
    stack = h("div", { class: "workflow-requests", role: "group", "aria-label": t("flow.requests"), "aria-live": "polite" });
    lane.querySelector(".ask-stack, .composer").before(stack);
  }
  const existing = new Map([...stack.children].map(card => [card.dataset.entry, card]));
  for (const request of requests) {
    const { agentId, nodeName, entry } = request;
    let card = existing.get(entry.id);
    if (!card) {
      card = h("button", { type: "button", class: "workflow-request", "data-entry": entry.id, "data-agent": agentId, "data-kind": entry.kind,
        "aria-controls": "task-conversation" },
        h("span", { class: "workflow-request-icon", html: ICON.flow, "aria-hidden": "true" }),
        h("span", { class: "workflow-request-text" }, h("strong"), h("small")),
        h("span", { class: "workflow-request-chevron", html: ICON.forward, "aria-hidden": "true" }));
      stack.append(card);
    }
    existing.delete(entry.id);
    const label = t(entry.kind === "question" ? "flow.request.question" : "flow.request.permission", { node: nodeName });
    const detail = entry.kind === "question" ? entry.questions[0]?.question ?? "" : entry.detail;
    const heading = card.querySelector("strong"), preview = card.querySelector("small");
    if (heading.textContent !== label) heading.textContent = label;
    if (preview.textContent !== detail) preview.textContent = detail;
    card.title = [label, detail].filter(Boolean).join("\n");
    card.onclick = () => open(request);
  }
  for (const card of existing.values()) card.remove();
}
