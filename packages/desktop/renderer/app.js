import { composerCapabilities } from "./capabilities.js";
// 窗口本身：打开工作区、左栏、对话栏、文件栏。
// 只通过 window.xsb 取数据和发指令，不知道背后是 mock 还是 Electron 的 preload。
// xsb 是全局对象：Electron 里由 preload 注入，浏览器里直接打开时由 mock.js 提供。
import { onArkLoginUrl } from "./ark.js";
import { avatarImage, avatarPicker } from "./avatars.js";
import { AVATARS } from "./avatar-catalog.js";
import { backendIcon, backendKind, backendMark } from "./backend-icons.js";
import { createArtifactBrowser, artifactLabel, artifactNavigation } from "./artifacts.js";
import { currentFlow, renderWorkflow, showTask, workflowPanelState, restoreWorkflowPanel } from "./workflow.js";
import { contentView, createEditor, markdownView } from "./content.js";
import { dropPageAnnotations } from "./web-annotation.js";
import { draftKey, loadDraft, moveDraft, saveDraft } from "./drafts.js";
import { $, ICON, fill, h } from "./dom.js";
import { composerSettings } from "./composer-settings.js";
import { backendPicker } from "./backend-picker.js";
import { clock, t } from "./i18n.js";
import { sessionPages, onPage, onPageRemoved, renderSide, selectTab } from "./pages.js";
import { closeSettings, showSettings } from "./settings.js";
import { migrateWorkspaceState, onPreferencesChanged, syncWindowColors } from "./preferences.js";
import { confirmDialog, openDialog } from "./form.js";
import { openNativeContextMenu } from "./menu.js";
import { questionRecord, syncAskPanel } from "./ask.js";
import { bindArtifactResize } from "./resize.js";

import { showWeb } from "./page-slot.js";

export const state = {
  workspace: null, recent: [],
  workflows: {}, agents: [], backends: [], tasks: [], artifacts: [],
  activities: {},        // 智能体的标识 → 它此刻在做什么（有一轮在进行时）
  pages: [],            // 右栏打开的网页；null 表示这个 Electron 显示不了网页
  tab: null,            // null = 启动页；"workflow"、"catalog"（文件）、文件标签或网页的 id
  workflowTab: false,   // 工作流、文件的标签是否开着
  catalogTab: false,
  tabOrder: [],         // 侧栏标签被拖出的顺序（标签 id）
  artifactTabs: [],     // { id, artifactId, mode }：每份打开的文件独立保留查看方式
  history: {},
  transcripts: {},      // agentId -> Entry[]
  open: [],             // 当前打开的主会话。任务会话由工作流标签中的节点选择决定
  settings: null,      // 设置对话框开着时，其中的当前分类
  artifactId: null,     // 右栏正在看的文件
  listing: false,       // 右栏在显示文件列表
  mode: "preview",      // preview | source
};

export const STATE_TEXT = { idle: t("state.idle"), running: t("state.running"), requires_action: t("state.requires_action"), asking: t("state.asking") };
/** 提问工具等待用户回答时显示"等你回答"。 */
export const shownState = (agent) => agent.asking && ["idle", "requires_action"].includes(agent.state) ? "asking" : agent.state;
export const TASK_TEXT = {
  blocked: t("task.status.blocked"), queued: t("task.status.queued"), running: t("task.status.running"),
  completed: t("task.status.completed"), failed: t("task.status.failed"), cancelled: t("task.status.cancelled"), interrupted: t("task.status.interrupted"),
};
/** 任务的状态怎么说：被派发方换成新任务的（改派），和被撤销的分开说。 */
export const taskText = (task) => (task.ended?.reason === "superseded" ? t("task.status.superseded") : TASK_TEXT[task.status]);
const TASK_GLYPH = { blocked: "idle", queued: "idle", running: "running", completed: "done", failed: "failed", cancelled: "failed", interrupted: "failed" };
export const OVER = ["completed", "failed", "cancelled", "interrupted"];

export const agentOf = (id) => state.agents.find((a) => a.id === id);
export const nameOf = (agentId) => agentOf(agentId)?.name ?? agentId;      // 已删除的 Agent 只剩 id
/** 谁起的任务：用户起的没有 from，看 initiator。 */
export const initiatorOf = (task) => task.initiator.kind === "agent" ? nameOf(task.initiator.agentId) : t(`task.initiator.${task.initiator.kind}`);
const artifactOf = (id) => state.artifacts.find((a) => a.id === id);
const windowState = new Map();
function remember(key, value) {
  windowState.set(key, structuredClone(value));
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* In-memory switching still works. */ }
}
function recall(key) {
  if (windowState.has(key)) return structuredClone(windowState.get(key));
  try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; }
}

function upsert(list, item, key = "id") {
  const i = list.findIndex((x) => x[key] === item[key]);
  if (i < 0) list.push(item); else list[i] = item;
}

// ---------- 没有工作区 ----------

/** candidate：用户刚选的、还不是工作区的文件夹，等待确认是否创建。error：刚才没打开成的原因。 */
/**
 * 没有工作区的窗口（新建窗口、或第一次打开）：和主窗口同一块工作面，左边"开始"，右边"最近打开"。
 * 选好工作区之前窗口不能用；也可以从菜单"文件 › 打开文件夹…"打开（main.ts 的 openFolder）。
 */
function renderWelcome(candidate, error) {
  const open = (path) => xsb.open(path).then(start, (e) => renderWelcome(candidate, e.message));
  const pick = async () => {
    const folder = await xsb.pickFolder();
    if (folder?.initialized) open(folder.path); else if (folder) renderWelcome(folder);
  };
  const mac = /Mac/.test(navigator.platform);
  const key = (keys) => h("kbd", {}, mac ? keys.replace("Ctrl+Shift+", "⇧⌘").replace("Ctrl+", "⌘") : keys);
  const action = (icon, label, keys, onclick) => h("button", { class: "welcome-action", onclick },
    h("span", { class: "welcome-action-icon", html: icon }), h("span", { class: "welcome-action-label" }, label), keys && key(keys));
  const short = (path) => path.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");
  fill($("#welcome"), h("div", { class: "welcome-inner" },
    h("header", { class: "welcome-head" }, h("h1", {}, t("welcome.title")), h("p", {}, t("welcome.intro"))),
    error && h("div", { class: "notice", role: "status" }, h("span", {}, error)),
    candidate && h("div", { class: "notice" },
      h("span", {}, t("welcome.candidate", { path: short(candidate.path) })),
      h("button", { class: "btn sm", onclick: () => renderWelcome() }, t("common.cancel")),
      h("button", { class: "btn sm primary", onclick: () => open(candidate.path) }, t("welcome.create"))),
    h("div", { class: "welcome-grid" },
      h("section", { class: "welcome-start" }, h("h2", {}, t("welcome.start")),
        action(ICON.folder, t("welcome.pick"), "Ctrl+O", pick),
        action(ICON.plus, t("welcome.newWindow"), "Ctrl+Shift+N", () => xsb.newWindow())),
      h("section", { class: "welcome-recent" }, h("h2", {}, t("welcome.recent")),
        state.recent.length
          ? h("div", { class: "welcome-recent-list" }, ...state.recent.map((w) => h("button", { class: "welcome-recent-item", title: w.path, onclick: () => open(w.path) },
              h("strong", {}, w.name), h("small", {}, short(w.path)))))
          : h("p", { class: "hint" }, t("welcome.noRecent"))))));
}

// ---------- 左栏 ----------

export function refreshRail() { renderRail(); }

/** 窗口的风格跟着打开的对话的后端走：codex 黑白，claude 橘黄（styles.css 的 data-provider），其余用默认。 */
function applyProviderTheme() {
  const kind = backendKind(agentOf(state.open[0])?.backend);
  if (kind) document.documentElement.dataset.provider = kind;
  else delete document.documentElement.dataset.provider;
  syncWindowColors();
}

/**
 * 删除对话（会话行的右键菜单）：有对话记录的先确认；没有记录的（哪怕已有后端会话）直接删。
 * 不论对话或它的任务 Agent 是否还在工作，菜单都可点：确认后由中枢先停下全部工作再删（Agents.delete），
 * 停下前这一行显示“正在删除”，别处不必等它。
 */
const deleting = new Set();
async function deleteConversation(agent) {
  if (deleting.has(agent.id)) return;
  if (agent.conversed && !(await confirmDialog(t("rail.delete.title", { name: agent.name }), [h("p", { class: "hint" }, t("rail.delete.body"))], t("rail.delete.confirm")))) return;
  deleting.add(agent.id);
  renderRail();
  try { await xsb.deleteConversation(agent.id); }
  catch (e) { openDialog(t("rail.delete.failed"), [h("p", {}, e.message)], [{ label: t("common.close"), primary: true }]); }
  finally { deleting.delete(agent.id); renderRail(); }
}

function renderRail() {
  applyProviderTheme();
  const roots = state.agents.filter(a => !a.workflowOwner);
  const menu = (e, a) => openNativeContextMenu(e, [
    { label: t("rail.delete"), disabled: deleting.has(a.id), hint: t("rail.delete.deleting"), run: () => deleteConversation(a) },
  ]);
  fill($("#agents"), ...roots.map(a =>
    h("button", { class:"row session-row", "aria-pressed":String(state.open.includes(a.id)),"aria-busy":String(deleting.has(a.id)),title:deleting.has(a.id) ? t("rail.delete.deleting") : a.name,onclick:() => focusLane(a.id),
      oncontextmenu: (e) => menu(e, a) },
      avatarImage(a),
      h("span",{class:"row-text"},h("strong",{},a.name)), backendMark(a.backend),
      h("i",{class:"state","data-state":shownState(a),title:STATE_TEXT[shownState(a)]}))));
  $("#agent-count").textContent = roots.length;
  $("#settings").setAttribute("aria-pressed", String(!!state.settings));
  fill($("#blank"),h("p",{},t("flow.empty")),h("button",{class:"btn primary",onclick:() => newSession()},t("flow.new")));

}


// ---------- 对话栏 ----------

/** 节点停在那里等用户：暂停了、挂起了，或者被一条还没处理完的插话挡住（它那一轮失败或被停了）。 */
const resumable = (node) => !!node.controls?.resume;

/** 一条输入在模型那边的状态：标签和说明（原因写进说明）。 */
function inputState(entry) {
  const why = entry.reason ? t(`entry.reason.${entry.reason}`) + (entry.detail ? `：${entry.detail}` : "") : "";
  if (entry.unsent) return { tag: t("entry.tag.unsent"), title: [t("entry.tag.unsent.title"), entry.detail].filter(Boolean).join("\n") };
  if (entry.redelivered) return { tag: t("entry.tag.redelivered"), title: t("entry.tag.redelivered.title") };
  if (entry.discarded && entry.resentAs) return { tag: t("entry.tag.resent"), title: why };
  if (entry.discarded && entry.owed) return { tag: t("entry.tag.owed"), title: [t("entry.tag.owed.title"), why].filter(Boolean).join("\n") };
  if (entry.discarded && ["uncertain", "interrupted"].includes(entry.reason)) return { tag: t("entry.tag.uncertain"), title: [t("entry.tag.uncertain.title"), entry.detail].filter(Boolean).join("\n") };
  if (entry.discarded) return { tag: t(entry.reason === "stopped" ? "entry.tag.cancelled" : "entry.tag.discarded"), title: [t("entry.tag.discarded.title"), why].filter(Boolean).join("\n") };
  if (entry.pending) return { tag: t(entry.delivery === "queued" ? "entry.tag.queued" : entry.delivery === "waiting" ? "entry.tag.waiting" : "entry.tag.pending"), title: t("entry.tag.pending.title") };
  return { tag: entry.origin.steered ? t("entry.tag.interjected") : null };
}

/** 模型收到的和用户看到的不一样的地方：看不到的图片、存成文件的长文本、附在前面的说明。 */
function deliveredNote(as) {
  return [as.imagesHidden && t("entry.delivered.images", { count: as.imagesHidden }),
    as.spilled?.length && t("entry.delivered.spilled", { count: as.spilled.length }),
    as.scope && t("entry.delivered.scope")].filter(Boolean).join(" · ");
}

const laneOf = (agentId) => document.querySelector(`.lane[data-agent="${agentId}"]`);

/** 主会话的标题：点击就地编辑，失焦或 Enter 保存；同步状态时不覆盖正在编辑的文字。 */
function conversationTitle(agentId) {
  const errorId = `title-error-${agentId}`;
  const name = h("input", { class: "lane-title-input", type: "text", maxlength: 64, required: true, autocomplete: "off", hidden: true,
    "aria-label": t("lane.rename.name"), "aria-describedby": errorId });
  const failure = h("span", { class: "lane-title-error", id: errorId, role: "alert", hidden: true });
  let editing = false, saving = false;
  const clearError = () => { failure.hidden = true; name.removeAttribute("aria-invalid"); };
  const finish = () => { editing = false; name.hidden = true; button.hidden = false; clearError(); };
  const fail = (message) => { failure.textContent = message; failure.hidden = false; name.setAttribute("aria-invalid", "true"); };
  const button = h("button", { class: "lane-title-button", type: "button", "aria-label": t("lane.rename"), onclick: () => {
    name.value = agentOf(agentId).name;
    editing = true;
    clearError();
    button.hidden = true;
    name.hidden = false;
    name.focus();
    name.select();
  } }, h("strong", {}));
  const save = async () => {
    if (!editing || saving) return;
    const title = name.value.trim();
    if (!title) { fail(t("lane.rename.empty")); return; }
    if (title === agentOf(agentId)?.name) { finish(); return; }
    saving = true;
    name.readOnly = true;
    clearError();
    try { onAgent(await xsb.renameConversation(agentId, title)); finish(); }
    catch (e) { fail(t("lane.rename.failed", { error: e.message })); }
    finally { saving = false; name.readOnly = false; }
  };
  name.onblur = save;
  name.oninput = clearError;
  name.onkeydown = (e) => {
    if (e.isComposing || !["Enter", "Escape"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (saving) return;
    if (e.key === "Escape") { finish(); button.focus(); }
    else { name.blur(); }
  };
  return h("div", { class: "lane-title" }, button, name, failure);
}

/** 主会话在中央打开，任务会话在所属工作流的侧栏打开。 */
export function focusLane(agentId) {
  const agent = agentOf(agentId);
  if (!agent) return;
  if (agent.workflowOwner) {
    const root = state.agents.find(a => a.mainSessionId === agent.workflowOwner);
    if (!root) return;
    focusLane(root.id);
    revealArtifacts(); selectTab("workflow"); showTask(agentId);
    return;
  }
  closeSettings();
  if (!state.open.includes(agentId)) {
    for (const id of [...state.open]) closeLane(id, true);
    openLane(agentId);
    restoreSide();
    remember("xsb.active:" + (state.workspace.id ?? state.workspace.path), agentId);
  }
  const lane = laneOf(agentId);
  lane.scrollIntoView({ block: "nearest", inline: "nearest" });
  const target = state.tab === "workflow" && laneOf(state.referenceAgent);
  if (target || state.referenceAgent === agentId) (target || lane).editor.el.focus();
}

const pendingEditors = new Map();
/** 任务节点的对话，开在工作流标签下方。readonly：只能查看时的说明文字（节点已被新版本删掉，或在看历史版本）。 */
export const openTaskLane = (id, panel, readonly) => openLane(id, panel, readonly);
function openLane(agentId, panel, readonly) {
  const send = async () => {
    if (readonly) return;
    const node = panel && currentFlow()?.nodes.find(n => n.agentId === agentId);
    // 默认作用于当前：节点的消息作用于它当前的工作；主会话有正在运行的工作流时，作用于这个工作流（及其中的智能体）。
    const target = panel ? node?.target : currentFlow()?.version ? "workflow" : undefined;
    try { await editor.ready(); } catch { return; }
    const content = editor.read();
    if (!content.length) return;
    const sent = editor.snapshot();
    editor.clear();
    // /clear 是 xsb 自己的命令，不交给后端：由中枢换一个新的后端会话，对哪种后端都一样。
    if (content.length === 1 && content[0].type === "text" && content[0].text.trim() === "/clear") return xsb.clear(agentId);
    try {
      await xsb.send(agentId, content, target);
    }
    catch (e) {
      const current = laneOf(agentId)?.editor ?? editor;
      current.restore([...sent, ...(current.el.isConnected ? current.snapshot() : loadDraft(key))]);
      saveDraft(key, current.snapshot());
      current.error.textContent = e.message;
      current.error.hidden = false;
      syncLane(agentId);
      return;
    }
    // 已发送的消息不因网页清理失败而重新进入草稿。
    dropPageAnnotations(sent.filter((b) => b.type === "web_annotation")).catch((e) => {
      editor.error.textContent = e.message; editor.error.hidden = false;
    });
  };
  // 一个按钮管两件事：输入框里有内容就是发送；没有内容而智能体在工作，就是停止。
  const press = () => (readonly ? undefined : lane.dataset.action === "stop" ? xsb.cancel(agentId) : send());
  let key = draftKey(state.workspace.id ?? state.workspace.path, agentOf(agentId));
  let editor = pendingEditors.get(key);
  if (!editor) {
    editor = createEditor(() => editor.el.closest(".lane")?.send(), () => {
      saveDraft(key, editor.snapshot());
      if (editor.isReading()) pendingEditors.set(key, editor);
      else if (pendingEditors.get(key) === editor) pendingEditors.delete(key);
      syncLane(agentId);
    }, dropPageAnnotations);
    editor.restore(loadDraft(key));
  }
  editor.el.onfocus = () => {
    setReferenceTarget(agentId);
  };
  const capabilities = composerCapabilities(editor);
  const controls = composerSettings(agentId, value => capabilities.update(value), !panel && !readonly && !agentOf(agentId).conversed);
  // 主会话可以换后端（任务节点的后端由工作流决定）。
  const picker = panel ? null : backendPicker(agentId, () => controls.discover(true));

  const lane = h("section", { class: "lane", "data-agent": agentId, "data-session": agentOf(agentId).mainSessionId },
    h("header", { class: "bar lane-head" },
      panel ? h("span", { class: "lane-avatar" })
        : h("button", { class: "lane-avatar", type: "button", title: t("lane.icon"), "aria-label": t("lane.icon"), "aria-haspopup": "dialog", onclick: (e) => pickIcon(agentId, e.currentTarget) }),
      panel ? h("strong", {}) : conversationTitle(agentId), h("span", { class: "lane-backend" }),
      h("span", { class: "lane-state" }, h("i", { class: "state" }), h("span", {})),
      h("button", { class: "icon-btn", title: t("lane.close"), "aria-label": t("lane.close"), html: ICON.close, hidden:!!panel, onclick: () => {closeLane(agentId); renderSide();} })),
    h("div", { class: "transcript" }, h("button", { class: "btn history-more", hidden: state.history?.[agentId] == null, onclick: () => loadHistory(agentId) }, t("history.more")), h("div", { class: "entries" })),
    h("div", { class: "composer" },
      editor.tray, editor.el, editor.error,
      h("div", { class: "composer-row" },
        h("span", { class: "hint", role: "status" }, h("i", { class: "state" }), h("span", {})),
        picker?.el, controls.el, controls.usage, h("button", { class: "send", onclick: press }))));
  lane.picker = picker;
  lane.editor = editor;
  lane.controls = controls;
  lane.capabilities = capabilities;
  lane.send = send;
  lane.saveDraft = () => saveDraft(key, editor.snapshot());
  lane.updateSession = (previous) => {
    const next = draftKey(state.workspace.id ?? state.workspace.path, agentOf(agentId));
    if (next === key) return;
    saveDraft(key, editor.snapshot());
    if (!previous?.mainSessionId) moveDraft(key, next);
    key = next;
    editor.restore(loadDraft(key));
  };

  // 只能查看：不给输入框和停止按钮，换成一行说明。
  if (readonly) {
    lane.dataset.readonly = readonly;
    lane.querySelector(".composer").after(h("p", { class: "lane-readonly", role: "note" }, h("span", { html: ICON.info }), readonly));
  }
  (panel ?? $("#lanes")).append(lane);
  if (!panel) state.open.push(agentId);
  else {
    lane.querySelector(".lane-head").append(h("button",{class:"btn task-control",onclick:() => {
      const flow = currentFlow(), node = flow?.nodes.find(n => n.agentId === agentId);
      if (!node) return;
      if (resumable(node)) xsb.workflowControl(flow.sessionId,false,[node.name]);
      else xsb.cancel(agentId);
    }},t("flow.stop")));
  }
  lane.querySelector(".entries").append(...state.transcripts[agentId].map((entry) => entryNode(agentId, entry)));
  syncAsk(agentId);
  syncLane(agentId);
  renderRail();
  const scroller = lane.querySelector(".transcript");
  scroller.scrollTop = scroller.scrollHeight;
}

/** 对话的图标：点栏头的头像，从内置的图里选一个，立即保存到中枢。 */
function pickIcon(agentId, anchor) {
  document.querySelector(".icon-menu")?.remove();
  const agent = agentOf(agentId);
  const draft = { avatar: agent?.avatar ?? "" };
  const failure = h("p", { class: "error", role: "alert" });
  const picker = avatarPicker(draft);
  const menu = h("div", { class: "icon-menu", popover: "auto", role: "dialog", "aria-label": t("lane.icon") },
    h("strong", {}, t("lane.icon")), picker, failure);
  picker.addEventListener("click", async () => {
    if (draft.avatar === (agentOf(agentId)?.avatar ?? "")) return;
    try { onAgent(await xsb.setAvatar(agentId, draft.avatar)); menu.hidePopover(); }
    catch (e) { failure.textContent = t("lane.icon.failed", { error: e.message }); }
  });
  menu.addEventListener("toggle", (e) => { if (e.newState === "closed") menu.remove(); });
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(innerWidth - 340, rect.left)) + "px";
  menu.style.top = (rect.bottom + 6) + "px";
  menu.showPopover();
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

function closeLane(agentId, switching = false) {
  if (state.open.includes(agentId)) {
    rememberSide();
    $("#task-conversation .lane")?.saveDraft();
    $("#task-conversation").replaceChildren();
  }
  laneOf(agentId)?.saveDraft();
  laneOf(agentId)?.remove();
  const closingRoot = state.open.includes(agentId);
  state.open = state.open.filter((id) => id !== agentId);
  if (closingRoot && !switching) restoreSide();
  state.open.forEach(syncLane);
  renderRail();
}

/** 把智能体反映到它的对话栏上：栏头、输入框下面的状态、那个按钮此刻是发送还是停止。 */
function syncLane(agentId) {
  const lane = laneOf(agentId);
  if (!lane) return;
  const { state: s, name, backend } = agentOf(agentId);
  lane.dataset.state = s;
  lane.capabilities?.refresh(t(s === "idle" ? "lane.placeholder" : "lane.placeholder.busy"));
  lane.picker?.update();
  fill(lane.querySelector(".lane-avatar"), avatarImage(agentOf(agentId)));
  lane.querySelector(".lane-head strong").textContent = name;
  const titleButton = lane.querySelector(".lane-title-button");
  if (titleButton) titleButton.title = name;
  fill(lane.querySelector(".lane-backend"), backendMark(backend));
  lane.querySelector(".lane-state .state").dataset.state = shownState(agentOf(agentId));
  lane.querySelector(".lane-state span").textContent = STATE_TEXT[shownState(agentOf(agentId))];
  const control = lane.querySelector(".task-control");
  if (control) {
    const node = currentFlow()?.nodes.find(n => n.agentId === agentId);
    control.textContent = t(node && resumable(node) ? "flow.resume" : "flow.stop");
    control.hidden = s === "idle" && !(node && resumable(node));
  }

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
  const agent = agentOf(agentId), s = agent.state;
  const activity = state.activities[agentId];
  const kind = shownState(agent) === "asking" ? "asking" : s === "idle" ? null : s === "requires_action" ? "permission" : (activity?.kind ?? "waiting");
  hint.hidden = !kind;
  if (!kind) return;
  const seconds = activity && !["permission", "asking"].includes(kind) ? Math.max(0, Math.floor((Date.now() - Date.parse(activity.since)) / 1000)) : null;
  const elapsed = seconds === null ? "" : ` ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  hint.dataset.activity = kind;
  hint.querySelector(".state").dataset.state = kind === "permission" ? "requires_action" : kind === "asking" ? "asking" : "running";
  hint.querySelector("span").textContent = t(`activity.${kind}`, { detail: activity?.detail ?? "" }) + elapsed;
}
setInterval(() => state.open.forEach(syncActivity), 1000);

function upsertEntry(agentId, entry) {
  const lane = laneOf(agentId);
  if (!lane) return;
  const scroller = lane.querySelector(".transcript");
  const pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const old = lane.querySelector(`.entry[data-id="${CSS.escape(entry.id)}"]`);
  const node = entryNode(agentId, entry);
  if (entry.kind === "tool" && old) {
    const prior = old.matches("details") ? old : old.querySelector("details");
    const current = node.matches("details") ? node : node.querySelector("details");
    if (current && prior?.open) current.open = true;
  }
  if (old) old.replaceWith(node); else lane.querySelector(".entries").append(node);
  if (entry.kind === "question") syncAsk(agentId);
  if (pinned) scroller.scrollTop = scroller.scrollHeight;
}

/** 输入框上方的表单分别绑定各自的 ACP 请求。 */
function syncAsk(agentId) {
  const lane = laneOf(agentId);
  if (lane && !lane.dataset.readonly) syncAskPanel(lane, state.transcripts[agentId] ?? [], (answer) => xsb.answerQuestion(agentId, answer));
}

function entryNode(agentId, entry) {
  const base = { class: `entry ${entry.kind}`, "data-id": entry.id };

  const openLink = (href, container) => followContentLink(href, container, agentId);
  if (entry.kind === "publication") {
    return h("article", { ...base, "data-origin": entry.source.kind, "data-source": entry.source.id },
      h("header", { class: "publication-source", title: entry.source.id }, entry.source.label),
      contentView([{ type: "text", text: entry.markdown }], openLink));
  }
  if (entry.kind === "output") {
    const offTurn = entry.run?.turnId === null;
    const notification = entry.runOrigin === "task-notification" || entry.runOrigin?.kind === "task-notification";
    return h("div", { ...base, "data-streaming": entry.streaming, "data-off-turn": offTurn },
      offTurn && h("div", { class: "run-label" }, t("entry.run.offTurn")),
      contentView(entry.content, openLink, { streaming: entry.streaming }),
      offTurn && entry.stopReason && h("div", { class: "run-end" }, t(notification ? "entry.run.notification" : "entry.run.ended")));
  }
  if (entry.kind === "error") return h("div", base, entry.text);
  // 上下文的边界：对话记录都还在，分隔线告诉用户模型从哪里起看不到上面的内容。
  if (entry.kind === "boundary") {
    return h("div", { ...base, role: "separator", "data-boundary": entry.boundary.kind },
      h("span", {}, t(`entry.boundary.${entry.boundary.kind}`, { backend: entry.boundary.backend ?? "", from: entry.boundary.from ?? "" })));
  }

  // 提问的卡片；回答它的那条消息由卡片显示，不另画（没送达的照常显示，好重发）。
  if (entry.kind === "question") return questionRecord(base, entry);
  if (entry.kind === "input" && entry.reply && !entry.discarded && !entry.unsent) return h("div", { ...base, hidden: true });
  if (entry.kind === "input") {
    const o = entry.origin;
    // 每条输入显示送达状态；未确认终结仍保留原文和删除线，不推断模型是否读取。
    const { tag, title } = inputState(entry);
    const terminated = entry.discarded && !entry.redelivered;
    const resendable = entry.discarded && o.kind === "user" && !entry.redelivered && !entry.resentAs;
    return h("div", { ...base, "data-origin": o.kind, "data-discarded": terminated, "data-pending": entry.pending || entry.unsent, title },
      o.kind === "agent" && h("div", { class: "from" }, avatarImage(agentOf(o.agentId)),
        t({ task: "entry.from.task", task_result: "entry.from.result" }[o.role] ?? "entry.from.message", { name: nameOf(o.agentId), task: o.taskId })),
      o.kind === "system" && h("div", { class: "from" }, t(o.role === "task_result" ? "entry.from.systemResult" : "entry.from.system")),
      h("div", { class: "said" }, contentView(entry.content, openLink)),
      entry.deliveredAs && h("div", { class: "delivered-as" }, deliveredNote(entry.deliveredAs)),
      tag && h("span", { class: "tag" }, tag),
      entry.pending && entry.canCancel && h("button", { class: "btn sm", onclick: e => {
        e.currentTarget.disabled = true;
        xsb.cancelMessage(agentId, entry.id).catch(error => { e.target.disabled = false; e.target.title = error.message; });
      } }, t("entry.cancel")),
      entry.pending && entry.isQueueHead && h("button", { class: "btn sm", disabled: !entry.canSendNow, title: entry.sendNowBlockedBy ? t("entry.sendNow." + entry.sendNowBlockedBy) : undefined, onclick: e => {
        e.currentTarget.disabled = true;
        xsb.sendMessageNow(agentId, entry.id).catch(error => { e.target.disabled = false; e.target.title = error.message; });
      } }, t("entry.sendNow")),
      resendable && h("button", { class: "btn sm resend", onclick: (e) => {
        e.currentTarget.disabled = true;
        xsb.resend(agentId, entry.id).catch((error) => { e.target.disabled = false; e.target.title = error.message; });
      } }, t("entry.resend")));
  }

  if (entry.kind === "tool") {
    const changes = entry.status === "done" ? [...(entry.changes ?? [])] : [];
    if (entry.status === "done" && entry.savedFile && !changes.some(change => change.path === entry.savedFile.path))
      changes.push({ operation: "save", ...entry.savedFile });
    const title = entry.title.split(/\r?\n/)[0].trim() || entry.name || t("tool.call");
    const body = h("div", { class: "tool-body" });
    const format = value => typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const part = (label, value) => value !== undefined && h("div", { class: "tool-part" }, h("small", {}, t(label)), h("pre", {}, format(value)));
    const details = h("details", { ...(changes?.length ? { class: "entry tool" } : base), ontoggle: e => {
      if (e.currentTarget.open && !body.childNodes.length) fill(body,
        entry.title && h("pre", { class: "tool-description" }, entry.title),
        part("tool.input", entry.input), part("tool.output", entry.terminalOutput ?? entry.output));
    } },
      h("summary", { title: t("tool.details") },
        h("span", { class: "tool-chevron", "aria-hidden": "true", html: ICON.forward }),
        h("i", { class: "state", "data-state": entry.status === "running" ? "running" : entry.status === "failed" ? "failed" : "done" }),
        h("span", { class: "tool-title" }, title), h("small", { class: "tool-status" }, t(`tool.status.${entry.status}`))), body);
    if (!changes?.length) return details;
    const files = h("div", { class: "changed-files" });
    for (const change of changes) {
      const path = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
      const target = change.operation === "delete"
        ? h("span", {}, path)
        : h("button", { type: "button", class: "link", onclick: () => openLink(change.uri, files) }, path);
      files.append(h("div", { class: "changed-file" }, h("small", {}, t(`files.operation.${change.operation}`)), target));
    }
    return h("div", { ...base, class: "entry file-changes" }, details, files);
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

// ---------- 右栏：文件 ----------

export async function followContentLink(href, container, agentId, baseFile) {
  const owner = rootSession();
  container.querySelector(".content-error")?.remove();
  try {
    if (/^https?:\/\//i.test(href)) {
      await xsb.openPage(href, false, owner);
      return;
    }
    const artifact = await xsb.openArtifact(href, agentId, baseFile);
    upsert(state.artifacts, artifact);
    if (owner === rootSession()) showArtifact(artifact.id);
  } catch (error) {
    container.append(h("div", { class: "content-error", role: "status" }, t("content.openFailed", { error: error.message })));
  }
}

function showArtifact(id) {
  let tab = state.artifactTabs.find((tab) => tab.artifactId === id);
  if (!tab) {
    tab = { id: `artifact:${id}`, artifactId: id, mode: "preview" };
    state.artifactTabs.push(tab);
  }
  revealArtifacts();
  selectTab(tab.id);
}

let catalogScroll = 0;
export function rememberPosition() {
  if ($("#side-artifacts").hidden) return;
  const scroll = $("#artifact-body").scrollTop;
  if (state.tab === "catalog") catalogScroll = scroll;
  const tab = state.artifactTabs.find(t => t.id === state.tab);
  if (tab) tab.scroll = scroll;
}
const artifactBrowser = createArtifactBrowser(showArtifact, nameOf, referenceArtifact, referenceTitle);
// The list is the Hub's projection of successful file edits across the main session and its task sessions.
let fileList = null;
async function loadFileList(owner) {
  const previousFiles = fileList?.owner === owner ? fileList.files : null;
  const request = fileList = { owner, files: previousFiles, pending: true, dirty: false };
  try {
    const files = await xsb.conversationFiles(owner);
    if (fileList !== request) return;
    request.files = files;
    for (const file of files) upsert(state.artifacts, file);
  } catch (error) {
    if (fileList !== request) return;
    request.error = error.message;
  }
  request.pending = false;
  if (rootSession() === owner && state.tab === "catalog") renderArtifact();
}
// A preview opened from a Markdown link can also change, even if it was never in Files.
export function refreshPreview() {
  const tab = state.artifactTabs.find(tab => tab.id === state.tab);
  if (tab) void xsb.refreshArtifact(tab.artifactId).catch(error => {
    if (state.tab === tab.id) {
      const message = $("#artifact-reveal-error");
      message.dataset.file = tab.artifactId;
      message.textContent = t("content.openFailed", { error: error.message });
      message.hidden = false;
    }
  });
}
let artifactRender = 0;
let artifactView = null;

function browseArtifacts() {
  revealArtifacts();
  selectTab("catalog");
}

// HTML 文件的预览是一个网页，和右栏的网页一样由主进程持有，只是不进标签栏：它在自己的进程里运行，
// 脚本照常执行，又碰不到应用。同一时刻只有一个，换成别的内容时关掉。
let embedded = null;      // { url, page: Promise<PageView> }
function embed(url) {
  if (embedded?.url !== url) {
    closeEmbedded();
    embedded = { url, page: xsb.openPage(url, true, rootSession()) };
  }
  return embedded.page;
}
function closeEmbedded() {
  embedded?.page.then((page) => xsb.page(page.id, "close")).catch(() => {});
  embedded = null;
}

async function revealFile(id) {
  const error = $("#artifact-reveal-error");
  error.hidden = true;
  try {
    await xsb.revealArtifact(id);
  } catch (e) {
    if (id !== state.artifactId) return;
    error.dataset.file = id;
    error.textContent = t("content.openFailed", { error: e.message });
    error.hidden = false;
  }
}

function unavailablePreview(artifact, failure) {
  return h("div", { class: "web-note" },
    h("p", { role: "status" }, failure ? t("content.openFailed", { error: failure.message }) : t("artifact.noPreview")),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary", onclick: () => revealFile(artifact.id) }, t("artifact.reveal")),
      failure && h("button", { type: "button", class: "btn", onclick: () => renderArtifact(true) }, t("artifact.retry"))));
}

export async function renderArtifact(force = false) {
  const artifact = state.listing ? null : artifactOf(state.artifactId);
  document.querySelectorAll(".chip[data-artifact]").forEach((chip) => chip.setAttribute("aria-pressed", String(chip.dataset.artifact === artifact?.id)));
  $("#file-reference").hidden = !artifact || !!artifact.missing || !state.open.length;
  $("#artifact-reveal").disabled = !!artifact?.missing;
  $("#file-reference").title = referenceTitle();
  $(".artifact-toolbar").hidden = !artifact;
  const body = $("#artifact-body");
  const modes = $("#artifact-modes");
  const navigation = $("#artifact-navigation");
  $("#artifact-list").hidden = !artifact;
  navigation.hidden = !artifact;
  const revealError = $("#artifact-reveal-error");
  if (!artifact || revealError.dataset.file !== artifact.id) revealError.hidden = true;
  const owner = rootSession();
  if (state.tab === "catalog" && owner && (fileList?.owner !== owner || (fileList.dirty && !fileList.pending))) void loadFileList(owner);
  const items = fileList?.owner === owner ? fileList?.files ?? [] : [];
  artifactBrowser.update(items, state.artifactId);
  const tasks = (currentFlow()?.nodes ?? []).filter(n => n.sessionId && agentOf(n.agentId));
  const destination = $("#reference-destination");
  destination.hidden = !!artifact?.missing || (!items.length && !artifact) || !tasks.length;
  $("#artifact-references").hidden = $("#file-reference").hidden && destination.hidden;
  if (!destination.hidden) {
    const select = destination.querySelector("select");
    fill(select, h("option", { value: state.open[0] }, t("artifact.mainComposer")),
      ...tasks.map(n => h("option", { value: n.agentId }, n.name)));
    select.value = referenceTarget();
    select.onchange = () => setReferenceTarget(select.value);
  }
  if (!(artifact?.kind === "html" && state.mode === "preview")) closeEmbedded();

  if (!artifact) {
    artifactView = null;
    ++artifactRender;
    $("#artifact-name").textContent = t("artifact.list.title");
    modes.hidden = true;
    if (state.tab === "catalog" && !fileList?.files) {
      if (fileList?.error) {
        fill(body, h("div", { class: "catalog-empty", role: "status" }, fileList.error,
          h("button", { class: "btn", onclick: () => { fileList = null; renderArtifact(); } }, t("artifact.retry"))));
      } else fill(body, h("div", { class: "catalog-empty", role: "status" }, t("artifact.loading")));
      return;
    }
    if (artifactBrowser.el.parentElement !== body) {
      fill(body, artifactBrowser.el);
      body.scrollTop = catalogScroll;
    }
    return;
  }

  fill(navigation, artifactNavigation(artifactBrowser, artifact, showArtifact));

  // Markdown 和 HTML 能切换预览与源码。
  const media = artifact.kind === "image" || artifact.kind === "video";
  const switchable = artifact.kind === "markdown" || artifact.kind === "html";
  const preview = media || (switchable && state.mode === "preview");
  modes.hidden = !switchable;
  modes.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.mode === "preview") === preview)));
  $("#artifact-name").textContent = artifactLabel(artifact);
  $("#artifact-name").title = artifact.name;

  if (artifact.missing) {
    ++artifactRender;
    artifactView = null;
    closeEmbedded();
    modes.hidden = true;
    return fill(body, h("p", { class: "catalog-empty file-unavailable", role: "status" }, t("artifact.missing")));
  }

  // 放大或调整窗口不重建同一预览，保留视频播放位置和图片节点。
  const view = JSON.stringify([artifact.id, artifact.url, artifact.kind, artifact.updatedAt, preview]);
  // 原生网页和浏览器标签共用窗口的位置，切回同一个 HTML 预览时也要重新摆好它。
  const htmlPreview = preview && artifact.kind === "html";
  if (!htmlPreview && !force && artifactView === view) return;
  artifactView = view;
  const request = ++artifactRender;

  if (artifact.kind === "unsupported") return fill(body, unavailablePreview(artifact));
  if (media) {
    const node = h(artifact.kind === "image" ? "img" : "video", { src: artifact.url, alt: artifact.name, controls: artifact.kind === "video" });
    const fit = () => {
      const width = node.videoWidth || node.naturalWidth, height = node.videoHeight || node.naturalHeight;
      if (width && height) node.style.setProperty("--media-ratio", String(width / height));
    };
    node.onload = node.onloadedmetadata = fit;
    node.onerror = () => { if (request === artifactRender) fill(body, unavailablePreview(artifact)); };
    return fill(body, h("figure", {}, node));
  }
  try {
    if (htmlPreview) {
      const page = await embed(artifact.url);
      if (request === artifactRender && !$("#side-artifacts").hidden) showWeb(body, page);
      return;
    }
    fill(body, h("div", { class: "catalog-empty", role: "status" }, t("artifact.loading")));
    const response = await fetch(artifact.url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const text = await response.text();
    if (request !== artifactRender) return;
    fill(body, preview
      ? markdownView(text, (href, container) => followContentLink(href, container, state.open[0], artifact.id), "doc md")
      : h("pre", { class: "source" }, ...text.split("\n").map((line) => h("span", {}, line + "\n"))));
  } catch (error) {
    if (request !== artifactRender) return;
    if (htmlPreview) closeEmbedded();
    fill(body, unavailablePreview(artifact, error));
  }
  body.scrollTop = state.artifactTabs.find(t => t.id === state.tab)?.scroll ?? 0;
}

// ---------- 窗口级交互 ----------

$("#ws").onclick = () => showSettings(state.workspace ? "workspace" : "general");
$("#settings").onclick = () => showSettings();
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
/**
 * 新建会话：不选后端，用默认的那个（最近一个会话的后端，否则第一个已安装的）；要换就在输入框里换。
 * 已经有一个还没说过话的会话时，直接打开它，不再新建。
 */
const defaultBackend = () => {
  const last = [...state.agents].filter((a) => !a.workflowOwner).sort((x, y) => (y.createdAt ?? "").localeCompare(x.createdAt ?? ""))[0];
  return last?.backend ?? state.backends.find((b) => b.installed)?.name ?? state.backends[0]?.name;
};
async function newSession() {
  if (!state.workspace) return;
  const unused = state.agents.find((a) => !a.workflowOwner && !(state.transcripts[a.id] ?? []).length);
  if (unused) return focusLane(unused.id);
  const agent = await xsb.newSession(defaultBackend());
  onAgent(await xsb.setAvatar(agent.id, AVATARS[Math.floor(Math.random() * AVATARS.length)].id));
  focusLane(agent.id);
}
$("#new-agent").onclick = () => newSession().catch((e) => fill($("#blank"), h("p", { class: "error" }, e.message)));
export const rootSession = () => agentOf(state.open[0])?.mainSessionId;
function belongsHere(artifact) {
  const root = rootSession(), agent = agentOf(artifact.agentId);
  return !!root && (artifact.sessionIds?.includes(root) || (agent?.workflowOwner ?? agent?.mainSessionId) === root);
}
function referenceTarget() {
  return currentFlow()?.nodes.some(n => n.sessionId && n.agentId === state.referenceAgent && agentOf(n.agentId)) ? state.referenceAgent : state.open[0];
}
function setReferenceTarget(id) {
  state.referenceAgent = id;
  $("#reference-destination select").value = referenceTarget();
  const title = referenceTitle();
  $("#file-reference").title = title;
  document.querySelectorAll(".reference-action").forEach(b => { b.title = title; b.setAttribute("aria-label", [b.textContent, b.dataset.name, title].join(" · ")); });
}
function referenceTitle() { return t("artifact.referenceTo", { name: nameOf(referenceTarget()) ?? "" }); }
function referenceArtifact(artifact) {
  if (!artifact || !belongsHere(artifact)) return;
  const id = referenceTarget();
  if (id !== state.open[0]) { selectTab("workflow"); showTask(id); }
  else { document.body.classList.remove("artifact-focused", "artifact-expanded"); }
  laneOf(id)?.editor.insert([{ type: "resource_link", name: artifact.name, uri: artifact.fileUri }]);
}
$("#file-reference").onclick = () => referenceArtifact(artifactOf(state.artifactId));

function sideKey() { return "xsb.side:" + JSON.stringify([state.workspace?.id ?? state.workspace?.path, rootSession()]); }
function rememberSide() {
  if (!rootSession()) return;
  rememberPosition();
  remember(sideKey(), {
    tab: state.tab, tabs: state.artifactTabs, workflowTab: state.workflowTab, catalogTab: state.catalogTab, tabOrder: state.tabOrder, filters: artifactBrowser.filters,
    scroll: catalogScroll, target: state.referenceAgent, flow: workflowPanelState(currentFlow()),
  });
}
function restoreSide() {
  closeEmbedded(); artifactRender++; artifactView = null;
  const saved = recall(sideKey()) ?? {};
  state.artifactTabs = (saved.tabs ?? []).filter(tab => { const a = artifactOf(tab.artifactId); return a && belongsHere(a); });
  state.referenceAgent = agentOf(saved.target) ? saved.target : state.open[0];
  restoreWorkflowPanel(currentFlow(), saved.flow);
  state.artifactId = null; state.listing = true;
  catalogScroll = saved.scroll ?? 0;
  artifactBrowser.restore(saved.filters);
  const hasFlow = !!(currentFlow()?.version || currentFlow()?.candidate);
  state.workflowTab = saved.workflowTab ?? (saved.tab === undefined && hasFlow);
  state.catalogTab = !!saved.catalogTab;
  state.tabOrder = saved.tabOrder ?? [];
  state.tab = saved.tab === undefined && hasFlow ? "workflow" : saved.tab ?? null;
  const open = state.tab === "workflow" ? state.workflowTab : state.tab === "catalog" ? state.catalogTab
    : state.artifactTabs.some(t => t.id === state.tab) || sessionPages().some(p => p.id === state.tab);
  if (!open) state.tab = null;
  renderSide();
  refreshPreview();
  if (state.tab === "catalog") $("#artifact-body").scrollTop = catalogScroll;
}
window.addEventListener("pagehide", rememberSide);
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
$("#artifact-reveal").onclick = () => revealFile(state.artifactId);
$("#artifact-modes").onclick = (e) => {
  if (!e.target.dataset.mode) return;
  state.mode = e.target.dataset.mode;
  const tab = state.artifactTabs.find((tab) => tab.id === state.tab);
  if (tab) tab.mode = state.mode;
  renderArtifact();
};

bindArtifactResize($("#divider"));

// ⌘1…⌘9：打开并聚焦第 n 个 Agent 的输入框
window.onkeydown = (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ",") { e.preventDefault(); showSettings(); return; }
  if (document.querySelector("dialog[open]")) return;
  if (e.key === "Escape" && document.body.classList.contains("artifact-focused")) { document.body.classList.remove("artifact-focused"); renderSide(); return; }
  if (e.key === "Escape" && document.body.classList.contains("artifact-expanded")) { document.body.classList.remove("artifact-expanded"); return; }
  const agent = (e.metaKey || e.ctrlKey) && state.agents.filter(a => !a.workflowOwner)[Number(e.key) - 1];
  if (!agent) return;
  e.preventDefault();
  focusLane(agent.id);
};

// ---------- 数据 ----------

/** 一个 会话从快照、创建回执或订阅中更新。 */
export function onAgent(agent) {
  const previous = agentOf(agent.id);
  upsert(state.agents, agent);
  const lane = laneOf(agent.id);
  if (lane) lane.updateSession(previous);
  else if (previous && !previous.mainSessionId && agent.mainSessionId) {
    moveDraft(draftKey(state.workspace.id ?? state.workspace.path, previous), draftKey(state.workspace.id ?? state.workspace.path, agent));
  }
  state.transcripts[agent.id] ??= [];
  renderRail();
  syncLane(agent.id);
}
/**
 * 网页批注和输入框联动：确认的批注（一份完整快照）进这个网页所属会话输入框的附件栏，下次发送时跟着发出；
 * 会话没有打开时存进它的草稿。网页上清除批注，附件栏也去掉；附件栏删掉或已发出的，网页上也撤下。
 */
function addAnnotation({ sessionId, annotation }) {
  const agent = state.agents.find((a) => a.mainSessionId === sessionId);
  if (!agent || annotation?.type !== "web_annotation") return;
  const key = draftKey(state.workspace.id ?? state.workspace.path, agent);
  const editor = laneOf(agent.id)?.editor ?? pendingEditors.get(key);
  if (editor) return editor.insert([annotation], true);
  saveDraft(key, [...loadDraft(key), annotation]);
}
function onAnnotationsRemoved({ sessionId, ids }) {
  const agent = state.agents.find((a) => a.mainSessionId === sessionId);
  if (!agent || !Array.isArray(ids)) return;
  const key = draftKey(state.workspace.id ?? state.workspace.path, agent);
  const editor = laneOf(agent.id)?.editor ?? pendingEditors.get(key);
  if (editor) return editor.removeAnnotations(ids);
  saveDraft(key, loadDraft(key).filter((b) => b.type !== "web_annotation" || !ids.includes(b.id)));
}
xsb.on((event) => {
  if (event.controls) laneOf(event.agentId)?.controls.update(event.controls);
  else if (event.workflow) {
    const flow = event.workflow, prior = state.workflows[flow.sessionId];
    state.workflows[flow.sessionId] = flow;
    if (currentFlow() === flow) {
      if ((!prior?.version && !prior?.candidate) && (flow.version || flow.candidate)) { revealArtifacts(); selectTab("workflow"); }
      else renderSide();
      if (state.open[0]) syncLane(state.open[0]);
      for (const n of flow.nodes) if (n.agentId) syncLane(n.agentId);
    }
  } else if (event.agent) onAgent(event.agent);
  else if (event.removedAgent) {
    // 删掉的是正在看的对话：改看列表里占它位置的那条（它是最后一条时看新的最后一条），一条不剩才不选中。
    const roots = state.agents.filter((a) => !a.workflowOwner);
    const index = state.open.includes(event.removedAgent) ? roots.findIndex((a) => a.id === event.removedAgent) : -1;
    const rest = roots.filter((a) => a.id !== event.removedAgent);
    const next = index < 0 ? undefined : rest[Math.min(index, rest.length - 1)];
    state.agents = state.agents.filter((a) => a.id !== event.removedAgent);
    closeLane(event.removedAgent, !!next);
    if (next) focusLane(next.id);
  }
  else if (event.task) { upsert(state.tasks, event.task); renderRail(); }
  else if (event.filesChanged) {
    if (fileList?.owner === event.filesChanged) fileList.dirty = true;
    if (rootSession() === event.filesChanged) {
      if (state.tab === "catalog") renderArtifact();
      else refreshPreview();
    }
  }
  else if (event.artifact) {
    upsert(state.artifacts, event.artifact);
    if (state.artifactTabs.some(tab => tab.id === state.tab && tab.artifactId === event.artifact.id)) renderArtifact();
  }
  else if (event.webAnnotation) addAnnotation(event.webAnnotation);
  else if (event.webAnnotationsRemoved) onAnnotationsRemoved(event.webAnnotationsRemoved);
  else if (event.page) onPage(event.page, event.keepTab);
  else if (event.removedPage) onPageRemoved(event.removedPage);
  else if (event.hub === "down") showHub(false);
  else if (event.arkLoginUrl) onArkLoginUrl(event.arkLoginUrl);
  else if (event.showAgent) { if (agentOf(event.showAgent)) focusLane(event.showAgent); }
  // 应用菜单：设置；文件 › 打开文件夹… 换了这个窗口的工作区。
  else if (event.openSettings) showSettings();
  else if (event.workspaceChanged) { closeSettings(); start(); }
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
  rememberSide();
  Object.assign(state, { activities: {}, workflows:{} }, await xsb.load(), { open: [], settings: null, listing: true, tab: null, workflowTab: false, catalogTab: false, tabOrder: [], artifactTabs: [] });
  catalogScroll = 0;
  $("#artifact-body").scrollTop = 0;
  fileList = null;
  artifactBrowser.reset();
  document.body.classList.toggle("no-workspace", !state.workspace);
  $("#ws-name").textContent = document.title = state.workspace?.name ?? t("app.title");
  $("#ws-path").textContent = state.workspace?.path ?? "";
  $("#ws").title = state.workspace?.path ?? t("settings.workspace");
  if (!state.workspace) return renderWelcome();
  migrateWorkspaceState(state.workspace);

  showHub(true);
  $("#lanes").replaceChildren();
  const activeId = recall("xsb.active:" + (state.workspace.id ?? state.workspace.path));
  const first = state.agents.find(a => !a.workflowOwner && a.id === activeId) ?? state.agents.find(a => !a.workflowOwner);
  $("#task-conversation").replaceChildren();
  if (first) openLane(first.id);
  // 首次使用：直接给一个可以说话的会话，不用先新建。
  else void newSession().catch(() => {});
  restoreSide();
  renderRail();
}

// 系统的窗口按钮（位置见 preferences.js）配色跟着系统深浅变时同步给它们。
syncWindowColors();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncWindowColors);

// Other workspace windows share global appearance and update immediately.
onPreferencesChanged(() => {
  refreshRail();
  if (state.settings) showSettings(state.settings);
});
