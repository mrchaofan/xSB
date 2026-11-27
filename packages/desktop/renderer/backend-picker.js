// 输入框里的后端切换：一个只显示后端图标的按钮，点开下拉列出可用的后端（claude、codex …）。
// 没有对话记录的对话（哪怕已为读取设置建立了后端会话）直接切换；有记录的不能原地换，确认后新建一个用新后端的对话，
// 新对话的模型用 previous_conversation 工具按需读取原对话（只迁移主对话，工作流不迁移），原对话保留。
// 当前一轮还没结束时不能切换。
import { agentOf, focusLane, onAgent, state } from "./app.js";
import { backendIcon } from "./backend-icons.js";
import { fill, h, ICON } from "./dom.js";
import { confirmDialog, openDialog } from "./form.js";
import { t } from "./i18n.js";

/** onSwitched：原地换了后端之后（还没有记录的对话）。 */
export function backendPicker(agentId, onSwitched = () => {}) {
  const trigger = h("button", { class: "backend-picker", type: "button", "aria-haspopup": "menu", "aria-expanded": "false" });
  const menu = h("div", { class: "session-menu backend-menu", popover: "auto", role: "menu", "aria-label": t("composer.backend") });
  const failure = h("p", { class: "error", role: "alert" });

  const choose = async (name) => {
    menu.hidePopover();
    const agent = agentOf(agentId);
    if (!agent || name === agent.backend) return;
    if (agent.state !== "idle") {
      openDialog(t("composer.backend.busyTitle"), [h("p", {}, t("composer.backend.busyBody"))], [{ label: t("common.close") }]);
      return;
    }
    try {
      if (!agent.conversed) {
        onAgent(await xsb.setBackend(agentId, name));
        // 换了后端，原来的设置随旧后端会话作废：立即为新后端拉取模型和推理强度。
        return onSwitched();
      }
      if (!(await confirmDialog(t("composer.backend.confirmTitle", { name }),
        [h("p", {}, t("composer.backend.confirmBody", { from: agent.backend, to: name }))], t("composer.backend.confirm")))) return;
      const moved = await xsb.migrate(agentId, name);
      onAgent(moved);
      focusLane(moved.id);
    } catch (e) { failure.textContent = e.message; menu.showPopover(); }
  };
  const paint = () => {
    const agent = agentOf(agentId);
    if (!agent) return;
    fill(trigger, backendIcon(agent.backend));
    trigger.title = t("composer.backend") + " · " + agent.backend;
    trigger.setAttribute("aria-label", trigger.title);
    // 工作中也能点开：选了别的后端时，弹窗说明当前一轮还没结束。
    trigger.dataset.busy = String(agent.state !== "idle");
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
