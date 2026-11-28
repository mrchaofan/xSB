// 右栏的标签：工作流、文件目录、独立文件预览，以及主进程持有的网页（../src/pages.ts）。
// 每个标签都由用户打开、可以关闭；没有当前标签时显示启动页，从那里在新标签中打开它们。
// 网页也可以移到自己的窗口里（page-window.js）。
import { rootSession, rememberPosition, refreshPreview, renderArtifact, revealArtifacts, state } from "./app.js";
import { currentFlow, renderWorkflow } from "./workflow.js";
import { artifactLabel } from "./artifacts.js";
import { fileIcon } from "./file-icons.js";
import { openDialog } from "./form.js";
import { openContextMenu } from "./menu.js";
import { $, ICON, fill, h } from "./dom.js";
import { t } from "./i18n.js";
import { showWeb } from "./page-slot.js";
import { annotateButton, showAnnotateBar } from "./annotate.js";

function ownerOf(page) {
  const agent = state.agents.find(a => a.mainSessionId === page.sessionId);
  return agent?.workflowOwner ?? page.sessionId;
}
export const sessionPages = () => (state.pages ?? []).filter(p => ownerOf(p) === rootSession());
const pageOf = id => sessionPages().find(p => p.id === id);
const titleOf = (page) => (!page.url || page.url === "about:blank" ? t("tabs.new") : page.title || page.url);
const address = $("#web-url");
let editingAddress;
function syncAddress(page) {
  if (!page || editingAddress === page.id) return;
  editingAddress = undefined;
  address.value = page.url.replace(/^about:blank$/, "");
}

/** 网页的图标：加载中转圈，否则是网站的 favicon，没有或加载失败时是地球。 */
function pageIcon(page) {
  if (page.loading) return h("span", { class: "tab-icon tab-spinner", "aria-hidden": "true" });
  const globe = () => h("span", { class: "tab-icon", "aria-hidden": "true", html: ICON.globe });
  if (!page.favicon) return globe();
  return h("img", { class: "tab-icon favicon", src: page.favicon, alt: "", draggable: "false", referrerpolicy: "no-referrer",
    onerror: (event) => event.currentTarget.replaceWith(globe()) });
}

/** id："workflow"、"catalog"、文件标签或网页的 id；null 显示启动页。打开工作流或文件即让它的标签出现。 */
export function selectTab(id, focusPage = true) {
  const changed = id !== state.tab;
  if (changed) rememberPosition();
  if (id === "workflow") state.workflowTab = true;
  if (id === "catalog") state.catalogTab = true;
  state.tab = id;
  renderSide(focusPage);
  if (changed) refreshPreview();
}

/** 标签栏从左到右的 id。 */
function tabIds() {
  return ordered([state.workflowTab && "workflow", state.catalogTab && "catalog",
    ...state.artifactTabs.map((tab) => tab.id), ...sessionPages().map((p) => p.id)].filter(Boolean));
}

/** 按用户拖出的顺序（state.tabOrder）排；没排过的标签按打开的先后接在后面。 */
function ordered(ids) {
  const rank = new Map((state.tabOrder ?? []).map((id, i) => [id, i]));
  return ids.map((id, i) => [id, rank.get(id) ?? rank.size + i]).sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

/**
 * 拖动标签排序：按下后移动超过几个像素才算拖动；拖着越过相邻标签的中线就和它换位，松手时记下新顺序。
 * 拖过之后的那次点击不算选中。
 */
function dragToReorder(list) {
  list.onpointerdown = (down) => {
    const dragged = down.target.closest(".tab");
    if (!dragged || down.button !== 0 || down.target.closest(".icon-btn")) return;
    const startX = down.clientX, offset = startX - dragged.getBoundingClientRect().left;
    let dragging = false, shift = 0;
    const move = (event) => {
      if (!dragging) {
        if (Math.abs(event.clientX - startX) < 5) return;
        dragging = true;
        dragged.setPointerCapture(down.pointerId);
        list.classList.add("reordering");
        dragged.classList.add("dragging");
      }
      const tabs = [...list.querySelectorAll(".tab")];
      const left = event.clientX - offset, center = left + dragged.offsetWidth / 2;
      const target = tabs.find((other) => {
        if (other === dragged) return false;
        const box = other.getBoundingClientRect();
        return center > box.left && center < box.right;
      });
      if (target) {
        const before = tabs.indexOf(target) < tabs.indexOf(dragged);
        target.insertAdjacentElement(before ? "beforebegin" : "afterend", dragged);
      }
      // 换位后它的自然位置变了：位移按新位置重算，让它仍停在指针下。
      shift = left - (dragged.getBoundingClientRect().left - shift);
      dragged.style.transform = `translateX(${shift}px)`;
    };
    const up = () => {
      list.removeEventListener("pointermove", move);
      list.removeEventListener("pointerup", up);
      list.removeEventListener("pointercancel", up);
      if (!dragging) return;
      list.classList.remove("reordering");
      dragged.classList.remove("dragging");
      dragged.style.transform = "";
      state.tabOrder = [...list.querySelectorAll(".tab")].map((tab) => tab.dataset.id);
      // 拖完紧跟的 click 落在标签上，不算选中。
      list.addEventListener("click", (event) => { event.stopPropagation(); event.preventDefault(); }, { capture: true, once: true });
      setTimeout(renderSide);
    };
    list.addEventListener("pointermove", move);
    list.addEventListener("pointerup", up);
    list.addEventListener("pointercancel", up);
  };
}

// 用户关闭网页的请求由主进程回报；收到后允许相邻网页接过焦点。
const closingPages = new Set();

/** 关掉一个标签；关的是当前标签时，选中它旁边的那个，一个都不剩就回到启动页。 */
function closeTab(id) {
  if (pageOf(id)) {
    closingPages.add(id);
    void xsb.page(id, "close").catch(() => closingPages.delete(id));
    return;
  }
  const ids = tabIds(), index = ids.indexOf(id);
  if (id === "workflow") state.workflowTab = false;
  else if (id === "catalog") state.catalogTab = false;
  else state.artifactTabs = state.artifactTabs.filter((tab) => tab.id !== id);
  if (state.tab === id) selectTab(ids[index + 1] ?? ids[index - 1] ?? null);
  else renderSide();
}

/** 一次关掉几个标签；当前标签在其中时，改选 keep。 */
function closeTabs(ids, keep) {
  if (ids.includes(state.tab)) selectTab(keep);
  for (const id of ids) closeTab(id);
}

/** 标签的右键菜单：网页标签先是对这个网页的操作（同地址栏的按钮），然后是关闭标签的几种方式。 */
function tabMenu(event, id) {
  const ids = tabIds(), page = pageOf(id), others = ids.filter((other) => other !== id), right = ids.slice(ids.indexOf(id) + 1);
  const blank = !page?.url || page.url === "about:blank";
  const op = (name) => () => void xsb.page(id, name).catch(() => {});
  openContextMenu(event, [
    ...(page ? [
      { label: t("web.reload"), icon: "reload", disabled: page.controlling, run: op("reload") },
      { label: t("tabs.copyUrl"), icon: "copy", disabled: blank, run: () => void xsb.copyText(page.url).catch(() => {}) },
      { label: t("web.external"), icon: "external", disabled: blank || page.controlling, run: op("external") },
      page.window ? { label: t("web.restore"), icon: "collapse", run: op("restore") } : { label: t("web.detach"), icon: "detach", run: op("detach") },
      null,
    ] : []),
    { label: t("tabs.close"), icon: "close", run: () => closeTab(id) },
    { label: t("tabs.closeOthers"), icon: "close", disabled: !others.length, run: () => closeTabs(others, id) },
    { label: t("tabs.closeRight"), icon: "close", disabled: !right.length, run: () => closeTabs(right, id) },
  ], t("tabs.menu"));
}

/** 启动页列出可在新标签中打开的内容。没有打开的会话时禁用这些入口。 */
function launcher(hasWorkflow) {
  const session = !!rootSession();
  const item = (icon, title, hint, onclick, disabled = false) =>
    h("button", { class: "launcher-item", disabled: disabled || !session, onclick }, h("span", { class: "launcher-icon", html: icon }),
      h("span", { class: "row-text" }, h("strong", {}, title), h("small", {}, hint)));
  return h("div", { class: "launcher" },
    state.pages && item(ICON.globe, t("side.launcher.browser"), t("side.launcher.browserHint"), newTab),
    item(ICON.grid, t("tabs.artifacts"), t("side.launcher.filesHint"), () => selectTab("catalog")),
    item(ICON.flow, t("flow.title"), t(hasWorkflow || !session ? "side.launcher.workflowHint" : "side.launcher.workflowNone"), () => selectTab("workflow")));
}

// 用鼠标连续关标签时（像 Chromium）：关掉一个后，其余标签保持关之前的宽度，下一个标签的关闭按钮正好移到鼠标下；
// 鼠标离开标签栏后再恢复随数量伸缩。键盘关闭不冻结。
let frozenWidth = null;

/**
 * 把标签栏改成 next 列出的标签。已有的标签元素留着、换上新的内容和属性，不重新创建：
 * 宽度的缓动是 CSS 过渡（styles.css 的 .tab），元素一换就接不上。
 */
function syncTabs(list, next) {
  const kept = new Map([...list.children].map((el) => [el.dataset.id, el]));
  const els = next.map((fresh) => {
    const el = kept.get(fresh.dataset.id);
    if (!el) return fresh;
    for (const { name } of [...el.attributes]) if (!fresh.hasAttribute(name)) el.removeAttribute(name);
    for (const { name, value } of [...fresh.attributes]) if (el.getAttribute(name) !== value) el.setAttribute(name, value);
    el.oncontextmenu = fresh.oncontextmenu;
    el.replaceChildren(...fresh.childNodes);
    return el;
  });
  for (const el of kept.values()) if (!els.includes(el)) el.remove();
  els.forEach((el, i) => { if (list.children[i] !== el) list.insertBefore(el, list.children[i] ?? null); });
}

/** 按 state.tab 和 state.pages 画出标签栏和当前的网页。 */
export function renderSide(focusPage = false) {
  const flow = currentFlow();
  const hasWorkflow = flow?.version || flow?.candidate;
  // 标签都属于打开的会话；没有会话时只剩启动页。
  if (!rootSession()) { state.tab = null; state.catalogTab = false; state.workflowTab = false; state.artifactTabs = []; }
  if (state.tab === "catalog") state.catalogTab = true;
  const workflow = state.tab === "workflow";
  const pages = sessionPages();
  const page = pageOf(state.tab);
  const launching = state.tab === null;
  $("#side-workflow").hidden = !workflow;
  if (workflow || !hasWorkflow) renderWorkflow(hasWorkflow ? flow : null);
  showAnnotateBar($("#web-annotate-bar"), page && !page.window ? page : null);
  $("#side-launcher").hidden = !launching;
  if (launching) fill($("#side-launcher"), launcher(hasWorkflow));
  $("#side-artifacts").hidden = !!page || workflow || launching;
  $("#side-web").hidden = !page;
  $("#tabs").hidden = false;
  // 标签栏本身也留着（见 syncTabs）；它后面的按钮每次重画。
  const tabList = $("#tabs .tab-list") ?? h("div", { class: "tab-list" });
  tabList.classList.toggle("frozen", !!frozenWidth);
  if (frozenWidth) tabList.style.setProperty("--tab-frozen", frozenWidth + "px");
  $("#tabs").onpointerleave = () => {
    if (!frozenWidth) return;
    frozenWidth = null;
    tabList.classList.remove("frozen");
  };
  const closeButton = (onclick) => h("button", { class: "icon-btn", title: t("tabs.close"), "aria-label": t("tabs.close"), html: ICON.close,
    onclick: (e) => { if (e.detail > 0) frozenWidth ??= e.currentTarget.closest(".tab").getBoundingClientRect().width; onclick(); } });
  // 标签像 Chromium 的标签条一样随数量变窄（styles.css 的 .tab 容器查询）：先藏起非当前标签的关闭按钮，再只留图标。
  const tab = (id, icon, label, title, close, extra = {}) => h("div", { class: "tab", "data-id": id, "aria-current": String(state.tab === id), title,
    oncontextmenu: (e) => tabMenu(e, id), ...extra },
    h("button", { class: "tab-main", onclick: () => selectTab(id) }, icon, h("span", { class: "tab-title" }, label)),
    closeButton(close));
  const fixed = (id, icon, label) => tab(id, h("span", { class: "tab-icon", "aria-hidden": "true", html: icon }), label, label, () => closeTab(id));
  const tabs = [
    state.workflowTab && fixed("workflow", ICON.flow, t("flow.title")),
    state.catalogTab && fixed("catalog", ICON.grid, t("tabs.artifacts")),
    ...state.artifactTabs.map((item) => {
      const artifact = state.artifacts.find((a) => a.id === item.artifactId);
      return tab(item.id, fileIcon(artifact?.name ?? item.artifactId), artifact ? artifactLabel(artifact) : item.artifactId,
        artifact ? `${artifact.name}\n${artifact.path}` : item.artifactId, () => closeTab(item.id));
    }),
    // 智能体打开并操作的网页，图标角上有一个强调色的点。
    ...pages.map((p) => tab(p.id, pageIcon(p), titleOf(p), p.agent ? `${titleOf(p)}\n${p.url}\n${t("tabs.agent")}` : `${titleOf(p)}\n${p.url}`,
      () => closeTab(p.id), { "data-agent": p.agent ? "true" : null })),
  ].filter(Boolean);
  const byId = new Map(tabs.map((el) => [el.dataset.id, el]));
  syncTabs(tabList, ordered([...byId.keys()]).map((id) => byId.get(id)));
  tabList.style.setProperty("--tabs", String(Math.max(1, byId.size)));
  dragToReorder(tabList);
  if (tabList.parentElement !== $("#tabs")) $("#tabs").prepend(tabList);
  while (tabList.nextSibling) tabList.nextSibling.remove();
  tabList.after(...[
    (pages.length + state.artifactTabs.length > 0) && h("button", { class: "icon-btn", title: t("tabs.opened"), "aria-label": t("tabs.opened"), html: ICON.list, onclick: openedTabs }),
    h("button", { class: "icon-btn", title: t("tabs.new"), "aria-label": t("tabs.new"), "aria-pressed": String(launching), html: ICON.plus, onclick: () => selectTab(null) }),
    h("button", { class: "icon-btn", title: t(document.body.classList.contains("artifact-focused") ? "artifact.restore" : "artifact.focus"), "aria-label": t(document.body.classList.contains("artifact-focused") ? "artifact.restore" : "artifact.focus"), html: document.body.classList.contains("artifact-focused") ? ICON.collapse : ICON.expand, onclick: () => { document.body.classList.toggle("artifact-focused"); renderSide(); } }),
    h("button", { class: "icon-btn side-close", title: t("side.close"), "aria-label": t("side.close"), html: ICON.close, onclick: () => { document.body.classList.remove("artifact-focused", "artifact-expanded"); renderSide(); } }),
  ].filter(Boolean));
  tabList.querySelector('.tab[aria-current="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (workflow) return fill($("#web-body"));
  if (launching) {
    state.listing = false;
    state.artifactId = null;
    renderArtifact();
    return fill($("#web-body"));
  }
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
  annotateButton($("#web-annotate"), page);
  syncAddress(page);
  if (page.window) {
    fill($("#web-body"), h("div", { class: "web-note" },
      h("p", {}, t("web.detached")),
      h("div", { class: "actions" },
        h("button", { class: "btn primary", onclick: () => xsb.page(page.id, "restore") }, t("web.restore")),
        h("button", { class: "btn", onclick: () => xsb.page(page.id, "show") }, t("web.show")))));
  } else showWeb($("#web-body"), page, focusPage === true);
}

/** 已打开的标签：完整列出标题和位置，点一个就切过去。 */
function openedTabs() {
  const list = h("div", { class: "opened-tabs" });
  const dialog = openDialog(t("tabs.opened"), [list], [{ label: t("common.close") }]);
  dialog.classList.add("tabs-dialog");
  const items = [
    ...state.artifactTabs.map((tab) => { const a = state.artifacts.find((a) => a.id === tab.artifactId); return { id: tab.id, title: a?.name ?? tab.artifactId, path: a?.path, icon: fileIcon(a?.name ?? tab.artifactId) }; }),
    ...sessionPages().map((p) => ({ id: p.id, title: titleOf(p), path: p.url, icon: pageIcon({ ...p, loading: false }) })),
  ];
  fill(list, ...items.map((item) => h("button", { class: "row", "aria-pressed": String(item.id === state.tab), onclick: () => { dialog.close(); selectTab(item.id); } },
    item.icon, h("span", { class: "row-text" }, h("strong", {}, item.title), h("small", {}, item.path)))),
    !items.length && h("p", { class: "empty" }, t("tabs.empty")));
  list.querySelector('[aria-pressed="true"]')?.focus();
}

/** 下一个新标签是 newTab 开的空白标签：键盘给地址栏。它的 page 事件先于 openPage 的答复到达。 */
let addressBarNext = false;

async function newTab() {
  const owner = rootSession();
  addressBarNext = true;
  const page = await xsb.openPage("about:blank", false, owner).finally(() => { addressBarNext = false; });     // 新标签随 page 事件出现并被选中
  if (rootSession() === owner && state.tab === page.id) $("#web-url").focus();
}

/** 用户新开的网页接过焦点。后台网页可以展示，但不能隐藏正操作的面板，也不能在窄窗口遮住输入。 */
export function onPage(page, keepTab = false) {
  const known = state.pages.find(p => p.id === page.id);
  if (!page.sessionId) page.sessionId = known?.sessionId ?? rootSession();
  const here = ownerOf(page) === rootSession();
  let focusPage = false;
  if (known) Object.assign(known, page);
  else {
    state.pages.push(page);
    const active = document.activeElement;
    const keepPanel = page.background && (active?.closest(".side") || (innerWidth <= 1000 && (active?.isContentEditable || active?.matches("input, textarea"))));
    if (here && !keepTab && !keepPanel) {
      rememberPosition();
      state.tab = page.id;
      revealArtifacts();
      // 用户从启动页新开的空白标签由 newTab 聚焦地址栏，网页不拿走键盘。
      focusPage = !page.background && !addressBarNext;
    }
  }
  if (here) renderSide(focusPage);
}

/** 网页关了：关的是当前标签时，回到它旁边的那个。 */
export function onPageRemoved(id) {
  const userClosed = closingPages.delete(id);
  const index = state.pages.findIndex((p) => p.id === id);
  if (index < 0) return;
  const localIndex = sessionPages().findIndex(p => p.id === id);
  state.pages.splice(index, 1);
  if (localIndex < 0) return;
  if (state.tab !== id) return renderSide();
  const pages = sessionPages();
  selectTab((pages[localIndex] ?? pages[localIndex - 1])?.id ?? state.artifactTabs.at(-1)?.id ?? null, userClosed);
}

const act = (op) => () => xsb.page(state.tab, op);
$("#web-back").onclick = act("back");
$("#web-forward").onclick = act("forward");
$("#web-reload").onclick = act("reload");
$("#web-external").onclick = act("external");
$("#web-detach").onclick = act("detach");
address.oninput = address.oncompositionstart = () => { editingAddress = state.tab; };
address.onblur = () => {
  editingAddress = undefined;
  address.setCustomValidity("");
  syncAddress(pageOf(state.tab));
};
address.onkeydown = (e) => {
  if (e.isComposing) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    address.blur();
    return;
  }
  const tab = state.tab, submitted = address.value, text = submitted.trim();
  e.target.setCustomValidity("");
  if (e.key !== "Enter" || !text) return;
  // 地址怎么补全、哪些能打开，由主进程定（与智能体的浏览器工具是同一条规则）；打不开的原因就写在地址栏上。
  const stillEditing = () => state.tab === tab && document.activeElement === address && address.value === submitted;
  xsb.page(tab, "navigate", text).then(() => { if (stillEditing()) address.blur(); }, (error) => {
    if (!stillEditing()) return;
    address.setCustomValidity(error.message);
    address.reportValidity();
  });
};
