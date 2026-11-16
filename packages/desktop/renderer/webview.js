// 把一个网页显示出来。网页归主进程所有（../src/pages.ts），这里只是用 <webview2> 把它显示在某处：
// 右栏（pages.js）、HTML 制品的预览（app.js）、网页自己的窗口（page-window.js）。
// 元素移走不影响网页本身，所以它在这几处之间移动时不会重新加载。
import { fill, h } from "./dom.js";
import { t } from "./i18n.js";

/** container 里显示 page；page 打不开时显示原因。container 里换成别的内容，就是不再显示它。 */
export function showWeb(container, page) {
  if (page.error) {
    return fill(container, h("div", { class: "web-note" },
      h("p", {}, t("web.error", { error: page.error })),
      h("button", { class: "btn", onclick: () => xsb.page(page.id, "reload") }, t("web.reload"))));
  }
  const id = String(page.contentsId);
  if (container.firstElementChild?.getAttribute("web-contents-id") === id) return;
  const el = document.createElement("webview2");
  // 一个网页同一时刻只能显示在一处。它刚从别处移过来时，那边可能还没放手：稍等再试。
  let tries = 0;
  el.addEventListener("error", () => setTimeout(() => {
    if (!el.isConnected || ++tries > 20) return;
    el.removeAttribute("web-contents-id");
    el.setAttribute("web-contents-id", id);
  }, 100));
  fill(container, el);
  el.setAttribute("web-contents-id", id);
}
