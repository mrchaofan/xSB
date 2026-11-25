// 智能体操作网页时的蒙层：叠在 <webview2> 上面的一个 DOM 元素，右栏和网页自己的窗口都用它。
// 它接住用户的鼠标；键盘由主进程拦（../src/page-input.ts）。智能体的输入经调试器直接进网页，不经过这里。
import { h } from "./dom.js";
import { t } from "./i18n.js";

const shield = h("div", { class: "control-shield" }, h("div", { class: "control-label", role: "status" }, t("web.controlling")));
// 不让按下鼠标带走焦点：用户正在输入框里打字时，焦点留在那里。
for (const type of ["mousedown", "click", "wheel", "contextmenu", "dragover", "drop"]) {
  shield.addEventListener(type, (event) => { event.preventDefault(); event.stopPropagation(); }, { passive: false });
}

/** container 里显示着 page：智能体在操作它时盖上蒙层，否则撤掉。 */
export function showControl(container, page) {
  if (!page.controlling) { if (shield.parentElement === container) shield.remove(); }
  else if (shield.parentElement !== container) container.append(shield);
}
