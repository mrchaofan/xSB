// 窗口本身：打开工作区、左栏、对话栏、制品栏。
// 只通过 window.xsb 取数据和发指令，不知道背后是 mock 还是 Electron 的 preload。
// Agent 的创建与编辑在 agent.js，角色与产出总览在 team.js。
// xsb 是全局对象：Electron 里由 preload 注入，浏览器里直接打开时由 mock.js 提供。
import { avatarImage } from "./avatars.js";
import { createArtifactBrowser, artifactDetails, artifactLabel, artifactNavigation } from "./artifacts.js";
import { editAgent } from "./agent.js";
import { contentView, createEditor, markdownView } from "./content.js";
import { draftKey, loadDraft, moveDraft, saveDraft } from "./drafts.js";
import { $, ICON, fill, h } from "./dom.js";
import { clock, t } from "./i18n.js";
import { onPage, onPageRemoved, renderSide, selectTab } from "./pages.js";
import { refreshSettings, settingsShell, showSettings } from "./settings.js";
import { onPreferencesChanged, workspacePreferences } from "./preferences.js";
import { showOverview } from "./team.js";
import { showWeb } from "./webview.js";

export const state = {
  workspace: null, recent: [],
  agents: [], roles: [], backends: [], tasks: [], artifacts: [],
  activities: {},        // 智能体的标识 → 它此刻在做什么（有一轮在进行时）
  assetNames: {},       // 资产类型 -> 显示名
  pages: [],            // 右栏打开的网页；null 表示这个 Electron 显示不了网页
  tab: null,            // null = 制品目录，否则是制品标签或网页的 id
  artifactTabs: [],     // { id, artifactId, mode }：每份打开的制品独立保留查看方式
  history: {},
  transcripts: {},      // agentId -> Entry[]
  open: [],             // 已打开对话栏的 agentId，按显示顺序。最多两个：第一栏，和分屏出来的第二栏
  pinned: false,        // 第一栏是否固定：固定后，再点别的智能体是分屏，而不是换掉它
  settings: null,      // 全局或工作区设置中的当前分类
  page: null,           // 主区域显示的页面：null = 对话；"overview"；角色名；"+" = 新建角色
  artifactId: null,     // 右栏正在看的制品
  listing: false,       // 右栏在显示制品列表
  mode: "preview",      // preview | source
};

export const STATE_TEXT = { idle: t("state.idle"), running: t("state.running"), requires_action: t("state.requires_action") };
export const TASK_TEXT = {
  blocked: t("task.status.blocked"), queued: t("task.status.queued"), running: t("task.status.running"),
  completed: t("task.status.completed"), failed: t("task.status.failed"), cancelled: t("task.status.cancelled"), interrupted: t("task.status.interrupted"),
};
/** 任务的状态怎么说：被派发方换成新任务的（改派），和被撤销的分开说。 */
export const taskText = (task) => (task.ended?.reason === "superseded" ? t("task.status.superseded") : TASK_TEXT[task.status]);
const TASK_GLYPH = { blocked: "idle", queued: "idle", running: "running", completed: "done", failed: "failed", cancelled: "failed", interrupted: "failed" };
export const OVER = ["completed", "failed", "cancelled", "interrupted"];

export const agentOf = (id) => state.agents.find((a) => a.id === id);
export const roleOf = (name) => state.roles.find((r) => r.name === name);
export const nameOf = (agentId) => agentOf(agentId)?.name ?? agentId;      // 已删除的 Agent 只剩 id
/** 谁起的任务：用户起的没有 from，看 initiator。 */
export const initiatorOf = (task) => task.initiator.kind === "agent" ? nameOf(task.initiator.agentId) : t(`task.initiator.${task.initiator.kind}`);
/** 角色给人看的名字：预设团队给它起的显示名，没有就是目录名。 */
export const roleTitle = (role) => role.preset?.title ?? role.name;
/** 资产类型给人看的名字。 */
export const assetName = (type) => state.assetNames[type] ?? type;
const artifactOf = (id) => state.artifacts.find((a) => a.id === id);

function upsert(list, item, key = "id") {
  const i = list.findIndex((x) => x[key] === item[key]);
  if (i < 0) list.push(item); else list[i] = item;
}

// ---------- 没有工作区 ----------

/** candidate：用户刚选的、还不是工作区的文件夹，等待确认是否创建。error：刚才没打开成的原因。 */
function renderWelcome(candidate, error) {
  const open = (path) => xsb.open(path).then(start, (e) => renderWelcome(candidate, e.message));
  const pick = async () => {
    const folder = await xsb.pickFolder();
    if (folder?.initialized) open(folder.path); else if (folder) renderWelcome(folder);
  };
  fill($("#welcome"), 
    h("h1", {}, t("welcome.title")),
    h("p", {}, t("welcome.intro")),
    error && h("div", { class: "notice", role: "status" }, h("span", {}, error)),
    candidate
      ? h("div", { class: "notice" },
          h("span", {}, t("welcome.candidate", { path: candidate.path })),
          h("button", { class: "btn", onclick: () => renderWelcome() }, t("common.cancel")),
          h("button", { class: "btn primary", onclick: () => open(candidate.path) }, t("welcome.create")))
      : h("button", { class: "btn primary", onclick: pick }, t("welcome.pick")),
    state.recent.length > 0 && h("h2", {}, t("welcome.recent")),
    ...state.recent.map((w) => h("button", { class: "row", onclick: () => open(w.path) },
      h("span", { class: "row-text" }, h("strong", {}, w.name), h("small", {}, w.path)))));
}

// ---------- 左栏 ----------

export function refreshRail() { renderRail(); }

function renderRail() {
  const talking = !state.page;
  fill($("#agents"), ...state.agents.map((a, i) =>
    h("button", { class: "row", "aria-pressed": String(talking && state.open.includes(a.id)), title: t("rail.agent.open", { n: i + 1 }), onclick: () => focusLane(a.id) },
      avatarImage(a, roleOf(a.role)),
      h("span", { class: "row-text" }, h("strong", {}, a.name), h("small", {}, a.description)),
      h("i", { class: "state", "data-state": a.state, title: STATE_TEXT[a.state] }))));

  $("#agent-count").textContent = state.agents.length;
  $("#settings").setAttribute("aria-pressed", String(!!state.settings));
  $("#overview").setAttribute("aria-pressed", String(state.page === "overview"));
  // 生成花费：已花的估算，有没能计价的生成时一并说出来。只是记账，不限制生成。
  const showCompleted = workspacePreferences(state.workspace?.path).showCompleted;
  const visibleTasks = state.tasks.filter((task) => showCompleted || !["completed", "cancelled"].includes(task.status));

  fill($("#tasks"), ...visibleTasks.map((task) =>
    h("button", { class: "row task", "data-over": OVER.includes(task.status), onclick: () => agentOf(task.to.agentId) && focusLane(task.to.agentId) },
      h("i", { class: "state", "data-state": TASK_GLYPH[task.status] }),
      h("span", { class: "row-text" },
        h("strong", {}, task.title),
        h("small", {}, t("rail.task.meta", { from: initiatorOf(task), to: nameOf(task.to.agentId), status: taskText(task) }))))));
  if (!visibleTasks.length) $("#tasks").append(h("div", { class: "empty" }, t(state.tasks.length ? "rail.tasks.finished" : "rail.tasks.empty")));

  // 没有打开任何对话栏时，中间显示的内容
  fill($("#blank"), ...(state.agents.length
    ? [t("blank.pick")]
    : [h("p", {}, t("blank.none")), h("button", { class: "btn primary", onclick: () => editAgent() }, t("agent.new.title")), h("small", {}, t("blank.setupHint"))]));
}

/** 主区域换成一个页面（角色编辑、产出总览）；closePage 回到对话。 */
export function showPage(key, ...content) {
  if (key === "overview") state.settings = null;
  document.body.classList.remove("artifact-focused");
  state.page = key;
  fill($("#page"), ...(state.settings ? settingsShell(...content) : content));
  document.body.classList.toggle("settings-open", !!state.settings);
  document.body.classList.add("paging");
  renderRail();
}
export function closePage() {
  state.page = null;
  state.settings = null;
  document.body.classList.remove("paging", "settings-open");
  renderRail();
}

// ---------- 对话栏 ----------

const laneOf = (agentId) => document.querySelector(`.lane[data-agent="${agentId}"]`);

/**
 * 把一个智能体的对话显示出来并聚焦。对话区最多两栏，规则只有三条：
 *   已经显示着的，不动；
 *   有第二栏时，换的永远是第二栏；
 *   只有一栏时：它固定了，就分屏出第二栏；没固定，就换掉它。
 */
export function focusLane(agentId) {
  closePage();
  if (!state.open.includes(agentId)) {
    const [first, second] = state.open;
    if (second) closeLane(second);
    else if (first && !state.pinned) closeLane(first);
    openLane(agentId);
  }
  const lane = laneOf(agentId);
  lane.scrollIntoView({ block: "nearest", inline: "nearest" });
  lane.querySelector(".editor").focus();
}

function openLane(agentId) {
  const send = async () => {
    try { await editor.ready(); } catch { return; }
    const content = editor.read();
    if (!content.length) return;
    editor.clear();
    // /clear 是 xsb 自己的命令，不交给后端：由中枢换一个新的后端会话，对哪种后端都一样。
    if (content.length === 1 && content[0].type === "text" && content[0].text.trim() === "/clear") return xsb.clear(agentId);
    xsb.send(agentId, content);
  };
  // 一个按钮管两件事：输入框里有内容就是发送；没有内容而智能体在工作，就是停止。
  const press = () => (lane.dataset.action === "stop" ? xsb.cancel(agentId) : send(false));
  let key = draftKey(state.workspace.path, agentOf(agentId));
  const editor = createEditor(send, () => {
    saveDraft(key, editor.snapshot());
    syncLane(agentId);
  });
  editor.restore(loadDraft(key));

  const lane = h("section", { class: "lane", "data-agent": agentId },
    h("header", { class: "bar lane-head" },
      h("span", { class: "lane-avatar" }), h("strong", {}), h("small", {}),
      h("span", { class: "lane-state" }, h("i", { class: "state" }), h("span", {})),
      h("button", { class: "icon-btn pin", html: ICON.pin, onclick: () => { state.pinned = !state.pinned; state.open.forEach(syncLane); } }),
      h("button", { class: "icon-btn", title: t("lane.close"), "aria-label": t("lane.close"), html: ICON.close, onclick: () => closeLane(agentId) })),
    h("div", { class: "transcript" }, h("button", { class: "btn history-more", hidden: state.history?.[agentId] == null, onclick: () => loadHistory(agentId) }, t("history.more")), h("div", { class: "entries" })),
    h("div", { class: "composer" },
      editor.el, editor.error,
      h("div", { class: "composer-row" },
        h("span", { class: "hint", role: "status" }, h("i", { class: "state" }), h("span", {})),
        h("button", { class: "send", onclick: press }))));
  lane.editor = editor;
  lane.updateSession = (previous) => {
    const next = draftKey(state.workspace.path, agentOf(agentId));
    if (next === key) return;
    saveDraft(key, editor.snapshot());
    if (!previous?.mainSessionId) moveDraft(key, next);
    key = next;
    editor.restore(loadDraft(key));
  };

  $("#lanes").append(lane);
  state.open.push(agentId);
  lane.querySelector(".entries").append(...state.transcripts[agentId].map((entry) => entryNode(agentId, entry)));
  syncLane(agentId);
  renderRail();
  const scroller = lane.querySelector(".transcript");
  scroller.scrollTop = scroller.scrollHeight;
}

async function loadHistory(agentId) {
  const lane = laneOf(agentId);
  if (!lane) return;
  const button = lane.querySelector(".history-more");
  if (button.disabled) return;
  const scroller = lane.querySelector(".transcript");
  const height = scroller.scrollHeight;
  const top = scroller.scrollTop;
  button.disabled = true;
  button.textContent = t("history.loading");
  try {
    const page = await xsb.history(agentId);
    state.transcripts[agentId] = page.entries;
    state.history[agentId] = page.cursor;
    lane.querySelector(".entries").replaceChildren(...page.entries.map((entry) => entryNode(agentId, entry)));
    button.hidden = page.cursor == null;
    scroller.scrollTop = top + scroller.scrollHeight - height;
  } catch (e) {
    button.textContent = e.message;
    return;
  } finally { button.disabled = false; }
  button.textContent = t("history.more");
}

function closeLane(agentId) {
  // 第一栏关掉后，第二栏成为第一栏；固定是说给被关掉的那一栏的，不跟着过去
  if (state.open[0] === agentId) state.pinned = false;
  laneOf(agentId)?.remove();
  state.open = state.open.filter((id) => id !== agentId);
  state.open.forEach(syncLane);
  renderRail();
}

/** 把智能体反映到它的对话栏上：栏头、输入框下面的状态、那个按钮此刻是发送还是停止。 */
function syncLane(agentId) {
  const lane = laneOf(agentId);
  if (!lane) return;
  const { state: s, name, backend } = agentOf(agentId);
  lane.dataset.state = s;
  fill(lane.querySelector(".lane-avatar"), avatarImage(agentOf(agentId), roleOf(agentOf(agentId).role)));
  lane.querySelector(".lane-head strong").textContent = name;
  lane.querySelector(".lane-head small").textContent = backend;
  lane.querySelector(".lane-state .state").dataset.state = s;
  lane.querySelector(".lane-state span").textContent = STATE_TEXT[s];
  lane.querySelector(".editor").dataset.placeholder = t(s === "idle" ? "lane.placeholder" : "lane.placeholder.busy", { name });
  // 只有第一栏能固定
  const pin = lane.querySelector(".pin");
  const pinLabel = t(state.pinned ? "lane.unpin" : "lane.pin");
  pin.hidden = state.open[0] !== agentId;
  pin.title = pinLabel;
  pin.setAttribute("aria-label", pinLabel);
  pin.setAttribute("aria-pressed", String(state.pinned));

  const action = s !== "idle" && !lane.editor.read().length && !lane.editor.isReading() ? "stop" : "send";
  const label = t(action === "stop" ? "lane.stop" : s === "idle" ? "lane.send" : "lane.send.queue");
  const button = lane.querySelector(".send");
  if (lane.dataset.action !== action) button.innerHTML = ICON[action];
  lane.dataset.action = action;
  button.title = label;
  button.setAttribute("aria-label", label);
  syncActivity(agentId);
}

/** 智能体此刻在做什么，以及做了多久。写在输入框下面；每秒重画一次。 */
function syncActivity(agentId) {
  const hint = laneOf(agentId)?.querySelector(".hint");
  if (!hint) return;
  const { state: s } = agentOf(agentId);
  const activity = state.activities[agentId];
  const kind = s === "idle" ? null : s === "requires_action" ? "permission" : (activity?.kind ?? "waiting");
  hint.hidden = !kind;
  if (!kind) return;
  const seconds = activity && kind !== "permission" ? Math.max(0, Math.floor((Date.now() - Date.parse(activity.since)) / 1000)) : null;
  const elapsed = seconds === null ? "" : ` ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  hint.dataset.activity = kind;
  hint.querySelector(".state").dataset.state = kind === "permission" ? "requires_action" : "running";
  hint.querySelector("span").textContent = t(`activity.${kind}`, { detail: activity?.detail ?? "" }) + elapsed;
}
setInterval(() => state.open.forEach(syncActivity), 1000);

function upsertEntry(agentId, entry) {
  const lane = laneOf(agentId);
  if (!lane) return;
  const scroller = lane.querySelector(".transcript");
  const pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const old = lane.querySelector(`.entry[data-id="${entry.id}"]`);
  const node = entryNode(agentId, entry);
  if (old) old.replaceWith(node); else lane.querySelector(".entries").append(node);
  if (pinned) scroller.scrollTop = scroller.scrollHeight;
}

function entryNode(agentId, entry) {
  const base = { class: `entry ${entry.kind}`, "data-id": entry.id };

  const openLink = (href, container) => followContentLink(href, container, agentId);
  if (entry.kind === "output") return h("div", { ...base, "data-streaming": entry.streaming }, contentView(entry.content, openLink, { streaming: entry.streaming }));
  if (entry.kind === "error") return h("div", base, entry.text);
  // 上下文的边界：对话记录都还在，分隔线告诉用户模型从哪里起看不到上面的内容。
  if (entry.kind === "boundary") {
    return h("div", { ...base, role: "separator", "data-boundary": entry.boundary.kind },
      h("span", {}, t(`entry.boundary.${entry.boundary.kind}`, { backend: entry.boundary.backend ?? "" })));
  }

  if (entry.kind === "input") {
    const o = entry.origin;
    // 停止时模型还没看到的输入被丢弃了：照样留在记录里，但标明模型没有看到。
    const tag = entry.discarded ? t("entry.tag.discarded") : o.steered ? t("entry.tag.interjected") : null;
    return h("div", { ...base, "data-origin": o.kind, "data-discarded": entry.discarded, title: entry.discarded ? t("entry.tag.discarded.title") : undefined },
      o.kind === "agent" && h("div", { class: "from" }, avatarImage(agentOf(o.agentId), roleOf(agentOf(o.agentId)?.role)),
        t({ task: "entry.from.task", task_result: "entry.from.result" }[o.role] ?? "entry.from.message", { name: nameOf(o.agentId), task: o.taskId })),
      o.kind === "system" && h("div", { class: "from" }, t("entry.from.system")),
      h("div", { class: "said" }, contentView(entry.content, openLink)),
      tag && h("span", { class: "tag" }, tag));
  }

  if (entry.kind === "tool") {
    const artifact = entry.artifactId && artifactOf(entry.artifactId);
    return h("div", base,
      h("i", { class: "state", "data-state": entry.status === "running" ? "running" : entry.status === "failed" ? "failed" : "done" }),
      h("span", {}, entry.title),
      artifact && h("button", { class: "chip", "data-artifact": artifact.id, "aria-pressed": String(artifact.id === state.artifactId), html: ICON.file, onclick: () => showArtifact(artifact.id) }, artifact.name));
  }

  // permission
  const answer = (allow) => xsb.permit(entry.id, allow);
  return h("div", { ...base, "data-outcome": entry.outcome },
    h("strong", {}, t("permission.title", { name: nameOf(agentId) })),
    h("code", {}, entry.detail),
    entry.outcome
      ? h("span", {}, { allowed: t("permission.allowed"), rejected: t("permission.rejected"), cancelled: t("permission.cancelled") }[entry.outcome])
      : h("div", { class: "actions" },
          h("button", { class: "btn", onclick: () => answer(false) }, t("permission.reject")),
          h("button", { class: "btn primary", onclick: () => answer(true) }, t("permission.allow"))));
}

// ---------- 右栏：制品 ----------

async function followContentLink(href, container, agentId, baseFile) {
  container.querySelector(".content-error")?.remove();
  try {
    if (/^https?:\/\//i.test(href)) {
      await xsb.openPage(href);
      return;
    }
    const artifact = await xsb.openArtifact(href, agentId, baseFile);
    upsert(state.artifacts, artifact);
    showArtifact(artifact.id);
  } catch (error) {
    container.append(h("div", { class: "content-error", role: "status" }, t("content.openFailed", { error: error.message })));
  }
}

function showArtifact(id) {
  if (state.listing) catalogScroll = $("#artifact-body").scrollTop;
  let tab = state.artifactTabs.find((tab) => tab.artifactId === id);
  if (!tab) {
    tab = { id: `artifact:${id}`, artifactId: id, mode: "preview" };
    state.artifactTabs.push(tab);
  }
  revealArtifacts();
  selectTab(tab.id);
}

let catalogScroll = 0;
const artifactBrowser = createArtifactBrowser(showArtifact, nameOf, assetName);
let artifactRender = 0;
let artifactView = null;

function browseArtifacts() {
  state.listing = true;
  state.tab = null;
  revealArtifacts();
  renderSide();
}

// HTML 制品的预览是一个网页，和右栏的网页一样由主进程持有，只是不进标签栏：它在自己的进程里运行，
// 脚本照常执行，又碰不到应用。同一时刻只有一个，换成别的内容时关掉。
let embedded = null;      // { url, page: Promise<PageView> }
function embed(url) {
  if (embedded?.url !== url) {
    closeEmbedded();
    embedded = { url, page: xsb.openPage(url, true) };
  }
  return embedded.page;
}
function closeEmbedded() {
  embedded?.page.then((page) => xsb.page(page.id, "close"));
  embedded = null;
}

export async function renderArtifact(force = false) {
  const artifact = state.listing ? null : artifactOf(state.artifactId);
  document.querySelectorAll(".chip").forEach((chip) => chip.setAttribute("aria-pressed", String(chip.dataset.artifact === artifact?.id)));
  const body = $("#artifact-body");
  const modes = $("#artifact-modes");
  const navigation = $("#artifact-navigation");
  $("#artifact-list").hidden = !artifact;
  navigation.hidden = !artifact;
  $("#artifact-info").hidden = !artifact;
  $("#artifact-details").hidden = !artifact || !state.artifactDetails;
  $("#artifact-info").setAttribute("aria-expanded", String(!!artifact && !!state.artifactDetails));
  artifactBrowser.update(state.artifacts, state.artifactId);
  if (!(artifact?.kind === "html" && state.mode === "preview")) closeEmbedded();

  if (!artifact) {
    artifactView = null;
    ++artifactRender;
    $("#artifact-name").textContent = t("artifact.list.title");
    $("#artifact-meta").textContent = t("artifact.catalog.count", { count: artifactBrowser.groups().length, files: state.artifacts.length });
    modes.hidden = true;
    if (artifactBrowser.el.parentElement !== body) {
      fill(body, artifactBrowser.el);
      body.scrollTop = catalogScroll;
    }
    return;
  }

  fill($("#artifact-detail-content"), artifactDetails(artifactBrowser, artifact, nameOf, showArtifact));
  fill(navigation, artifactNavigation(artifactBrowser, artifact, showArtifact));

  // 文本只有源码，图片和视频只有预览，markdown 和 html 两者都有
  const media = artifact.kind === "image" || artifact.kind === "video";
  const preview = media || (artifact.kind !== "text" && state.mode === "preview");
  modes.hidden = media || artifact.kind === "text";
  modes.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.mode === "preview") === preview)));
  $("#artifact-name").textContent = artifactLabel(artifact);
  $("#artifact-name").title = artifact.name;
  $("#artifact-meta").textContent = "";

  // 改详情、放大或调整窗口不重建同一预览：视频播放位置和图片节点保持原样。
  const view = JSON.stringify([artifact.id, artifact.url, artifact.kind, artifact.updatedAt, preview]);
  if (!force && artifactView === view) return;
  artifactView = view;
  const request = ++artifactRender;

  if (media) {
    const node = h(artifact.kind === "image" ? "img" : "video", { src: artifact.url, alt: artifact.name, controls: artifact.kind === "video" });
    const fit = () => {
      const width = node.videoWidth || node.naturalWidth, height = node.videoHeight || node.naturalHeight;
      if (width && height) node.style.setProperty("--media-ratio", String(width / height));
    };
    node.onload = node.onloadedmetadata = fit;
    return fill(body, h("figure", {}, node));
  }
  if (preview && artifact.kind === "html") {
    // 显示不了网页的 Electron 上，退回到不执行脚本的 iframe
    if (!state.pages) return fill(body, h("iframe", { src: artifact.url, sandbox: "", title: artifact.name }));
    const page = await embed(artifact.url);
    if (request === artifactRender && embedded?.url === artifact.url) showWeb(body, page);
    return;
  }

  fill(body, h("div", { class: "catalog-empty", role: "status" }, t("artifact.loading")));
  try {
    const response = await fetch(artifact.url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const text = await response.text();
    if (request !== artifactRender) return;
    fill(body, preview
      ? markdownView(text, (href, container) => followContentLink(href, container, artifact.agentId, artifact.id), "doc md")
      : h("pre", { class: "source" }, ...text.split("\n").map((line) => h("span", {}, line + "\n"))));
  } catch (error) {
    if (request !== artifactRender) return;
    fill(body, h("div", { class: "catalog-empty", role: "status" }, t("content.openFailed", { error: error.message }),
      h("button", { class: "btn", onclick: () => renderArtifact(true) }, t("artifact.retry"))));
  }
  body.scrollTop = 0;
}

// ---------- 窗口级交互 ----------

$("#ws").onclick = () => showSettings(state.workspace ? "workspace" : "general");
$("#settings").onclick = $("#title-settings").onclick = () => showSettings();
$("#overview").onclick = showOverview;
/** 与中枢的连接是否还在，画成工作区名字旁的圆点。 */
function showHub(up, why) {
  const dot = $("#hub");
  dot.dataset.up = up;
  dot.title = why ?? t(up ? "titlebar.hub.up" : "titlebar.hub.down");
  dot.setAttribute("aria-label", dot.title);
}
// 断了的时候点圆点：重新打开这个工作区（中枢没在运行就启动它），再按最新的状态重画。
$("#hub").onclick = () => {
  if ($("#hub").dataset.up === "false") xsb.open(state.workspace.path).then(start, (e) => showHub(false, e.message));
};
$("#new-agent").onclick = () => editAgent();
$("#toggle-rail").onclick = () => document.body.classList.toggle("no-rail");
export function revealArtifacts() {
  document.body.classList.remove("no-artifact");
  if (window.innerWidth <= 1000) document.body.classList.add("artifact-expanded");
}
$("#toggle-artifact").onclick = () => {
  if (window.innerWidth <= 1000) {
    document.body.classList.remove("no-artifact");
    document.body.classList.remove("artifact-focused");
    document.body.classList.toggle("artifact-expanded");
  } else { document.body.classList.remove("artifact-focused"); document.body.classList.toggle("no-artifact"); }
};
$("#artifact-list").onclick = browseArtifacts;
const showArtifactDetails = (open) => {
  state.artifactDetails = open;
  $("#artifact-details").hidden = !open;
  $("#artifact-info").setAttribute("aria-expanded", String(open));
  if (open) $("#artifact-details-close").focus(); else $("#artifact-info").focus();
};
$("#artifact-info").onclick = () => showArtifactDetails(!state.artifactDetails);
$("#artifact-details-close").onclick = () => showArtifactDetails(false);
$("#artifact-reveal").onclick = async () => {
  const error = $("#artifact-detail-error");
  error.hidden = true;
  try {
    await xsb.revealArtifact(state.artifactId);
  } catch (e) { error.textContent = t("content.openFailed", { error: e.message }); error.hidden = false; }
};
$("#artifact-modes").onclick = (e) => {
  if (!e.target.dataset.mode) return;
  state.mode = e.target.dataset.mode;
  const tab = state.artifactTabs.find((tab) => tab.id === state.tab);
  if (tab) tab.mode = state.mode;
  renderArtifact();
};

// 拖动分隔线改右栏宽度
$("#divider").onpointerdown = (e) => {
  const divider = e.currentTarget;
  divider.setPointerCapture(e.pointerId);
  divider.classList.add("dragging");
  divider.onpointermove = (move) => {
    const width = Math.min(Math.max(window.innerWidth - move.clientX, 300), window.innerWidth * 0.6);
    document.documentElement.style.setProperty("--artifact-w", `${width}px`);
  };
  divider.onpointerup = () => { divider.onpointermove = null; divider.classList.remove("dragging"); };
};

// ⌘1…⌘9：打开并聚焦第 n 个 Agent 的输入框
window.onkeydown = (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ",") { e.preventDefault(); showSettings(); return; }
  if (e.key === "Escape" && state.settings && !document.querySelector("dialog[open]")) { closePage(); return; }
  if (document.querySelector("dialog[open]")) return;
  if (e.key === "Escape" && state.artifactDetails) { showArtifactDetails(false); return; }
  if (e.key === "Escape" && document.body.classList.contains("artifact-focused")) { document.body.classList.remove("artifact-focused"); renderSide(); return; }
  if (e.key === "Escape" && document.body.classList.contains("artifact-expanded")) { document.body.classList.remove("artifact-expanded"); return; }
  const agent = (e.metaKey || e.ctrlKey) && state.agents[Number(e.key) - 1];
  if (!agent) return;
  e.preventDefault();
  focusLane(agent.id);
};

// ---------- 数据 ----------

/** 一个 Agent 新增或改变了。putAgent 的返回值和事件都走这里。 */
export function onAgent(agent) {
  const previous = agentOf(agent.id);
  upsert(state.agents, agent);
  const lane = laneOf(agent.id);
  if (lane) lane.updateSession(previous);
  else if (previous && !previous.mainSessionId && agent.mainSessionId) {
    moveDraft(draftKey(state.workspace.path, previous), draftKey(state.workspace.path, agent));
  }
  state.transcripts[agent.id] ??= [];
  renderRail();
  refreshSettings();
  syncLane(agent.id);
}
export function onRole(role) {
  upsert(state.roles, role, "name");
  renderRail();
  refreshSettings();
  state.open.forEach(syncLane);
}

xsb.on((event) => {
  if (event.agent) onAgent(event.agent);
  else if (event.removedAgent) {
    state.agents = state.agents.filter((a) => a.id !== event.removedAgent);
    closeLane(event.removedAgent);
    refreshSettings();
  }
  else if (event.role) onRole(event.role);
  else if (event.removedRole) { state.roles = state.roles.filter((r) => r.name !== event.removedRole); renderRail(); refreshSettings(); state.open.forEach(syncLane); }
  else if (event.task) { upsert(state.tasks, event.task); renderRail(); }
  else if (event.artifact) {
    upsert(state.artifacts, event.artifact);
    if (state.listing || !state.artifactId || state.artifactId === event.artifact.id) renderArtifact();
  }
  else if (event.page) onPage(event.page);
  else if (event.removedPage) onPageRemoved(event.removedPage);
  else if (event.hub === "down") showHub(false);
  else if (event.revealPage) { revealArtifacts(); selectTab(event.revealPage); }
  else if (event.showAgent) { if (agentOf(event.showAgent)) focusLane(event.showAgent); }
  else if ("activity" in event) {
    if (event.activity) state.activities[event.agentId] = event.activity; else delete state.activities[event.agentId];
    syncActivity(event.agentId);
  }
  else if (event.removedEntry) {
    state.transcripts[event.agentId] = state.transcripts[event.agentId].filter((e) => e.id !== event.removedEntry);
    laneOf(event.agentId)?.querySelector(`.entry[data-id="${event.removedEntry}"]`)?.remove();
  }
  else if (event.entry) { upsert(state.transcripts[event.agentId] ??= [], event.entry); upsertEntry(event.agentId, event.entry); }
});

/** 读一次快照并画出整个窗口。打开工作区之后再调用一次。 */
export async function start() {
  Object.assign(state, { activities: {} }, await xsb.load(), { open: [], pinned: false, page: null, settings: null, listing: true, tab: null, artifactTabs: [], artifactDetails: false });
  catalogScroll = 0;
  $("#artifact-body").scrollTop = 0;
  artifactBrowser.reset();
  document.body.classList.toggle("no-workspace", !state.workspace);
  document.body.classList.remove("paging", "settings-open");
  $("#ws-name").textContent = document.title = state.workspace?.name ?? t("app.title");
  $("#ws-path").textContent = state.workspace?.path ?? "";
  if (!state.workspace) return renderWelcome();

  showHub(true);
  $("#lanes").replaceChildren();
  if (state.agents[0]) openLane(state.agents[0].id);
  state.artifactId = state.artifacts[0]?.id ?? null;
  renderRail();
  renderSide();
}

// Other workspace windows share global appearance and update immediately.
onPreferencesChanged(() => {
  refreshRail();
  if (state.page === "settings") showSettings(state.settings);
});
