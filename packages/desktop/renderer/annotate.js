// 网页批注在窗口页面里的部分：工具栏上的开关，和批注时网页上方的提示条（提示、清除、完成）。
// 节点由调试器的节点选择在网页里选出并框住（../src/page-annotations.ts）；写批注的编辑框是盖在网页上的另一个视图
// （annotation.js、../src/page-host.ts），这里不认识节点，也不碰批注的文字。
import { h } from "./dom.js";
import { t } from "./i18n.js";

const hint = h("span", { class: "annotate-hint" });
const clearButton = h("button", { class: "btn sm" });
const doneButton = h("button", { class: "btn sm primary" }, t("web.annotate.done"));
let error = "", current;

// 失败的原因显示在提示条上，下一次成功的操作清掉它。
const settle = (promise) => promise.then(() => { error = ""; render(); }, (e) => { error = e.message; render(); });
clearButton.onclick = () => current && settle(xsb.page(current.id, "annotationsClear"));
doneButton.onclick = () => current && settle(xsb.page(current.id, "annotate", false));

/** 工具栏上的"批注"开关：智能体正在操作时不能用。 */
export function annotateButton(button, page) {
  button.setAttribute("aria-pressed", String(!!page.annotating));
  button.disabled = !page.annotating && (!!page.controlling || !!page.error || page.window && button.dataset.panel === "true");
  button.title = t(page.annotating ? "web.annotate.done" : "web.annotate");
  button.onclick = () => xsb.page(page.id, "annotate", !page.annotating).catch((e) => { error = e.message; render(); });
}

/** bar 是网页上方的提示条：page 在批注时显示，否则藏起来；page 为空表示这里没显示网页。 */
export function showAnnotateBar(bar, page) {
  current = page?.annotating && !page.error ? page : undefined;
  if (bar.firstChild !== hint) bar.replaceChildren(hint, clearButton, doneButton);
  bar.hidden = !current;
  if (current) bar.dataset.tone = current.tone ?? "default";
  render();
}

function render() {
  if (!current) return;
  const count = current.annotations ?? 0;
  hint.textContent = error || t("web.annotate.hint");
  clearButton.textContent = t("web.annotate.clear", { count });
  clearButton.hidden = !count;
}
