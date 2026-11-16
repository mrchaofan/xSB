// 表单与对话框的小工具。agent.js 和 team.js 的界面都由它们拼成。
import { h } from "./dom.js";
import { t } from "./i18n.js";

/** 一个带标签和提示的表单项。hint 可以是文字或节点。 */
export function field(label, control, hint) {
  const single = control.matches("input, textarea, select");
  return h(single ? "label" : "div", { class: "field" },
    h("span", {}, label), control, hint && (typeof hint === "string" ? h("small", {}, hint) : hint));
}

/** 与 obj[key] 双向绑定的输入框；props.rows 存在时是多行。 */
export function input(obj, key, props = {}) {
  const { oninput, ...rest } = props;
  const el = h(props.rows ? "textarea" : "input", rest);
  el.value = obj[key] ?? "";
  el.addEventListener("input", () => { obj[key] = el.value; oninput?.(); });
  return el;
}

/** 与 obj[key] 双向绑定的下拉框。options：[[值, 文字], …] */
export function select(obj, key, options, onchange) {
  const el = h("select", {}, ...options.map(([value, label]) => h("option", { value }, label)));
  el.value = obj[key] ?? "";
  el.addEventListener("change", () => { obj[key] = el.value; onchange?.(); });
  return el;
}

/** 模态对话框。buttons：{ label, primary?, side?, run? }；run 返回 false 或失败时对话框不关闭，失败的原因显示在按钮上方。 */
export function openDialog(title, content, buttons) {
  const failure = h("p", { class: "error", role: "alert" });
  const press = (b) => async () => {
    try { if (await b.run?.() !== false) dialog.close(); } catch (e) { failure.textContent = e.message; }
  };
  const dialog = h("dialog", { class: "form" },
    h("h1", {}, title),
    ...content,
    failure,
    h("div", { class: "actions" }, ...buttons.map((b) =>
      h("button", { class: `btn${b.primary ? " primary" : ""}${b.side ? " side" : ""}`, onclick: press(b) }, b.label))));
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

/** 确认一个有后果的操作；得到 true 才继续。 */
export function confirmDialog(title, content, label) {
  return new Promise((resolve) => {
    const dialog = openDialog(title, content, [{ label: t("common.cancel") }, { label, primary: true, run: () => resolve(true) }]);
    dialog.addEventListener("close", () => resolve(false));
  });
}
