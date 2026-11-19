// 右栏的标签：制品目录、独立制品预览，以及主进程持有的网页（../src/pages.ts）。
// 这里显示它们的标签和地址栏，并把当前的那个显示出来。网页也可以移到自己的窗口里（page-window.js）。
import { renderArtifact, revealArtifacts, state } from "./app.js";
import { $, ICON, fill, h } from "./dom.js";
import { t } from "./i18n.js";
import { showWeb } from "./webview.js";

const pageOf = (id) => state.pages?.find((p) => p.id === id);
const titleOf = (page) => (!page.url || page.url === "about:blank" ? t("tabs.new") : page.title || page.url);

/** null 显示制品目录，其余 id 显示制品预览或网页。 */
export function selectTab(id) {
  state.tab = id;
  renderSide();
}

/** 按 state.tab 和 state.pages 画出标签栏和当前的网页。 */
export function renderSide() {
  const page = pageOf(state.tab);
  $("#side-artifacts").hidden = !!page;
  $("#side-web").hidden = !page;
  $("#tabs").hidden = false;      // 没有 webview2 时仍然可以打开制品标签
  fill($("#tabs"),
    h("div", { class: "tab", "aria-current": String(state.tab === null) }, h("button", { onclick: () => selectTab(null) }, t("tabs.artifacts"))),
    ...state.artifactTabs.map((tab) => {
      const artifact = state.artifacts.find((a) => a.id === tab.artifactId);
      return h("div", { class: "tab", "aria-current": String(tab.id === state.tab), title: artifact?.path },
        h("button", { onclick: () => selectTab(tab.id) }, h("span", {}, artifact?.name ?? tab.artifactId)),
        h("button", { class: "icon-btn", title: t("tabs.close"), "aria-label": t("tabs.close"), html: ICON.close, onclick: () => {
          const index = state.artifactTabs.indexOf(tab);
          state.artifactTabs.splice(index, 1);
          if (state.tab === tab.id) state.tab = (state.artifactTabs[index] ?? state.artifactTabs[index - 1])?.id ?? state.pages?.[0]?.id ?? null;
          renderSide();
        } }));
    }),
    ...(state.pages ?? []).map((p) => h("div", { class: "tab", "aria-current": String(p === page), title: p.url },
      h("button", { onclick: () => selectTab(p.id) },
        p.agent && h("i", { class: "state", "data-state": p.loading ? "running" : "idle", title: t("tabs.agent") }),
        h("span", {}, titleOf(p))),
      h("button", { class: "icon-btn", title: t("tabs.close"), "aria-label": t("tabs.close"), html: ICON.close, onclick: () => xsb.page(p.id, "close") }))),
    state.pages && h("button", { class: "icon-btn", title: t("tabs.new"), "aria-label": t("tabs.new"), html: ICON.plus, onclick: newTab }));
  if (!page) {
    const tab = state.artifactTabs.find((tab) => tab.id === state.tab);
    state.listing = !tab;
    state.artifactId = tab?.artifactId ?? null;
    state.mode = tab?.mode ?? "preview";
    renderArtifact();
    return fill($("#web-body"));
  }

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
    revealArtifacts();
  }
  renderSide();
}

/** 网页关了：关的是当前标签时，回到它旁边的那个。 */
export function onPageRemoved(id) {
  const index = state.pages.findIndex((p) => p.id === id);
  if (index < 0) return;
  state.pages.splice(index, 1);
  if (state.tab === id) state.tab = (state.pages[index] ?? state.pages[index - 1])?.id ?? state.artifactTabs.at(-1)?.id ?? null;
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
  e.target.setCustomValidity("");
  if (e.key !== "Enter" || !text) return;
  // 地址怎么补全、哪些能打开，由主进程定（与智能体的浏览器工具是同一条规则）；打不开的原因就写在地址栏上。
  xsb.page(state.tab, "navigate", text).then(() => e.target.blur(), (error) => {
    e.target.setCustomValidity(error.message);
    e.target.reportValidity();
  });
};
