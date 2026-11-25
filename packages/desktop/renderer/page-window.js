import "./preferences.js";
// 一个网页自己的窗口（page.html）：标题栏上是网页的标题、置顶和"在主窗口中显示"，下面是网页本身。
// 网页是从右栏移过来的同一个，不重新加载；关掉这个窗口就关掉了网页和它的标签（../src/pages.ts）。
import { $ } from "./dom.js";
import "./i18n.js";      // 换上 page.html 里的静态文字
import { showWeb } from "./webview.js";
import { annotateButton } from "./annotate.js";
import { syncWindowColors } from "./preferences.js";

let id;
function sync(page) {
  id = page.id;
  $("#title").textContent = document.title = page.title || page.url;
  // 配色跟着网页所属对话的后端走，和主窗口一样（styles.css 的 data-provider）
  if (page.tone === "claude") document.documentElement.dataset.provider = "claude";
  else delete document.documentElement.dataset.provider;
  syncWindowColors();
  $("#pin").setAttribute("aria-pressed", String(page.pinned));
  annotateButton($("#annotate"), page);
  showWeb($("#web-body"), page);
}

$("#pin").onclick = (e) => xsb.page(id, "pin", e.currentTarget.getAttribute("aria-pressed") !== "true");
$("#restore").onclick = () => xsb.page(id, "restore");
xsb.on((event) => { if (event.page?.id === id) sync(event.page); });
xsb.pageWindow().then(sync);
