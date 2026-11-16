// 右栏的标签：第一个是制品，其余每个是一个网页。网页由主进程持有（../src/pages.ts），
// 这里显示它们的标签和地址栏，并把当前的那个显示出来。网页也可以移到自己的窗口里（page-window.js）。
import { state } from "./app.js";
import { $, ICON, fill, h } from "./dom.js";
import { t } from "./i18n.js";
import { showWeb } from "./webview.js";

const pageOf = (id) => state.pages?.find((p) => p.id === id);
const titleOf = (page) => (!page.url || page.url === "about:blank" ? t("tabs.new") : page.title || page.url);

/** 右栏显示哪个标签：null 是制品，否则是网页的 id。 */
export function selectTab(id) {
  state.tab = id;
  renderSide();
}

/** 按 state.tab 和 state.pages 画出标签栏和当前的网页。 */
export function renderSide() {
  const page = pageOf(state.tab);
  $("#side-artifacts").hidden = !!page;
  $("#side-web").hidden = !page;
  $("#tabs").hidden = !state.pages;      // 这个 Electron 显示不了网页：没有标签栏，右栏只有制品
  fill($("#tabs"),
    h("div", { class: "tab", "aria-current": String(!page) }, h("button", { onclick: () => selectTab(null) }, t("tabs.artifacts"))),
    ...(state.pages ?? []).map((p) => h("div", { class: "tab", "aria-current": String(p === page), title: p.url },
      h("button", { onclick: () => selectTab(p.id) },
        p.agent && h("i", { class: "state", "data-state": p.loading ? "running" : "idle", title: t("tabs.agent") }),
        h("span", {}, titleOf(p))),
      h("button", { class: "icon-btn", title: t("tabs.close"), "aria-label": t("tabs.close"), html: ICON.close, onclick: () => xsb.page(p.id, "close") }))),
    h("button", { class: "icon-btn", title: t("tabs.new"), "aria-label": t("tabs.new"), html: ICON.plus, onclick: newTab }));
  if (!page) return fill($("#web-body"));       // 不再显示网页；网页本身还在

  $("#web-back").disabled = !page.canGoBack;
  $("#web-forward").disabled = !page.canGoForward;
  if (document.activeElement !== $("#web-url")) $("#web-url").value = page.url.replace(/^about:blank$/, "");
  if (page.window) {
    fill($("#web-body"), h("div", { class: "web-note" },
      h("p", {}, t("web.detached")),
      h("div", { class: "actions" },
        h("button", { class: "btn primary", onclick: () => xsb.page(page.id, "restore") }, t("web.restore")),
        h("button", { class: "btn", onclick: () => xsb.page(page.id, "show") }, t("web.show")))));
  } else showWeb($("#web-body"), page);
}

async function newTab() {
  await xsb.openPage("about:blank");     // 新标签随 page 事件出现并被选中
  $("#web-url").focus();
}

/** 一个网页新开或者变了。新开的成为当前标签，右栏收起时把它打开。 */
export function onPage(page) {
  const known = pageOf(page.id);
  if (known) Object.assign(known, page);
  else {
    state.pages.push(page);
    state.tab = page.id;
    document.body.classList.remove("no-artifact");
  }
  renderSide();
}

/** 网页关了：关的是当前标签时，回到它旁边的那个。 */
export function onPageRemoved(id) {
  const index = state.pages.findIndex((p) => p.id === id);
  if (index < 0) return;
  state.pages.splice(index, 1);
  if (state.tab === id) state.tab = (state.pages[index] ?? state.pages[index - 1])?.id ?? null;
  renderSide();
}

const act = (op) => () => xsb.page(state.tab, op);
$("#web-back").onclick = act("back");
$("#web-forward").onclick = act("forward");
$("#web-reload").onclick = act("reload");
$("#web-external").onclick = act("external");
$("#web-detach").onclick = act("detach");
$("#web-url").onkeydown = (e) => {
  const text = e.target.value.trim();
  if (e.key !== "Enter" || !text) return;
  xsb.page(state.tab, "navigate", /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  e.target.blur();
};
