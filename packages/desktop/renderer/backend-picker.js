// 输入框里的后端切换：一个只显示后端图标的按钮，点开下拉列出可用的后端（claude、codex …）。
// 对话还没有消息时直接切换；已有消息时先确认：换后端会开一个新的后端会话，之前的对话按新后端的上下文限制压缩成交接
// 带过去，模型从此只看到摘要（中枢的 backend_changed 分割线）。
import { agentOf, onAgent, state } from "./app.js";
import { backendIcon } from "./backend-icons.js";
import { fill, h, ICON } from "./dom.js";
import { confirmDialog } from "./form.js";
import { t } from "./i18n.js";

export function backendPicker(agentId) {
  const trigger = h("button", { class: "backend-picker", type: "button", "aria-haspopup": "menu", "aria-expanded": "false" });
  const menu = h("div", { class: "session-menu backend-menu", popover: "auto", role: "menu", "aria-label": t("composer.backend") });
  const failure = h("p", { class: "error", role: "alert" });

  const hasHistory = () => (state.transcripts[agentId] ?? []).some((e) => e.kind === "input" || e.kind === "output");
  const choose = async (name) => {
    menu.hidePopover();
    const agent = agentOf(agentId);
    if (!agent || name === agent.backend) return;
    if (hasHistory() && !(await confirmDialog(t("composer.backend.confirmTitle", { name }),
      [h("p", {}, t("composer.backend.confirmBody", { from: agent.backend, to: name }))], t("composer.backend.confirm")))) return;
    try { onAgent(await xsb.setBackend(agentId, name)); }
    catch (e) { failure.textContent = e.message; menu.showPopover(); }
  };
  const paint = () => {
    const agent = agentOf(agentId);
    if (!agent) return;
    fill(trigger, backendIcon(agent.backend));
    trigger.title = t("composer.backend") + " · " + agent.backend;
    trigger.setAttribute("aria-label", trigger.title);
    trigger.disabled = agent.state !== "idle";
    fill(menu, h("small", {}, t("composer.backend")),
      ...state.backends.map((b) => h("button", { type: "button", role: "menuitemradio", class: "session-menu-item", "aria-checked": String(b.name === agent.backend),
        onclick: () => choose(b.name) },
        backendIcon(b.name), h("span", { class: "session-menu-name" }, b.name),
        !b.installed && h("small", {}, t("flow.backend.missing")),
        b.name === agent.backend && h("span", { class: "cascade-check", html: ICON.check, style: "visibility: visible" }))),
      failure);
  };
  menu.addEventListener("toggle", () => trigger.setAttribute("aria-expanded", String(menu.matches(":popover-open"))));
  trigger.onclick = () => {
    if (menu.matches(":popover-open")) return menu.hidePopover();
    failure.textContent = "";
    paint();
    if (!menu.isConnected) document.body.append(menu);
    const rect = trigger.getBoundingClientRect();
    menu.style.left = Math.max(8, rect.left) + "px";
    menu.style.bottom = (innerHeight - rect.top + 6) + "px";
    menu.style.top = "auto";
    menu.showPopover();
  };
  paint();
  return { el: trigger, update: paint };
}
