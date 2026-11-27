// Topological layers keep parallel branches side by side. Buttons sit over the edge drawing
// so keyboard navigation, the transcript and the prompt composer use native controls.
import { $, ICON, h, fill } from "./dom.js";
import { language, t } from "./i18n.js";
import { state, agentOf, openTaskLane, followContentLink } from "./app.js";
import { avatarImage } from "./avatars.js";
import { renderContract } from "./workflow-contract.js";

export const currentFlow = () => state.workflows?.[agentOf(state.open[0])?.mainSessionId];
// 每个工作流（按主会话）各自记住：选中的节点、正在看的版本（空 = 当前版本）、图是否折叠。
const selected = new Map();
const viewing = new Map();
const collapsed = new Map();
export function workflowPanelState(flow) {
  if (flow) return { selected: selected.get(flow.sessionId), viewing: viewing.get(flow.sessionId), collapsed: collapsed.get(flow.sessionId) };
}
export function restoreWorkflowPanel(flow, saved) {
  if (!flow || !saved) return;
  selected.set(flow.sessionId, saved.selected);
  viewing.set(flow.sessionId, saved.viewing ?? null);
  collapsed.set(flow.sessionId, !!saved.collapsed);
}

/** 节点能不能打开对话：有会话、智能体还在列表里（当前的，或已被新版本删掉、只能查看的）。 */
const openable = (n) => !!(n.sessionId && n.agentId && agentOf(n.agentId));
const inspectable = (n) => !!(n?.contract || n?.markdown);

/** 选中一个节点的对话。正在看历史版本时，只认那个版本里的节点。 */
export function showTask(id) {
  const flow = currentFlow();
  if (!flow) return;
  const shown = versionOf(flow);
  if (!shown.nodes.some((n) => openable(n) && n.agentId === id)) {
    if (!flow.nodes.some((n) => openable(n) && n.agentId === id)) return;
    viewing.set(flow.sessionId, null);
  }
  selected.set(flow.sessionId, id);
  if (!agentOf(id)?.retired) state.referenceAgent = id;
  renderWorkflow(flow);
}

/**
 * 正在看的版本：当前（可以对话）、候选（还没有对话）、或一个历史版本（只能查看）。
 * 看的版本不存在了（候选被采用、历史被裁掉）就回到当前版本。
 */
function versionOf(flow) {
  const want = viewing.get(flow.sessionId) ?? (!flow.version && flow.candidate ? flow.candidate.version : null);
  if (want && flow.candidate?.version === want) {
    const { nodes, edges, format } = flow.candidate.graph;
    return { kind: "candidate", version: want, edges, nodes: nodes.map(n => ({
      name: n.node, kind: n.kind, status: "proposed",
      markdown: format === "markdown" && { requirements: n.requirements, entryInput: n.entryInput },
      contract: n.inputSchema && { goal: n.prompt, inputSchema: n.inputSchema, fixedInput: n.input, schema: n.schema },
    })) };
  }
  const old = want && want !== flow.version && flow.history?.find((v) => (v.snapshot ?? v.version) === want);
  if (old) return { kind: "history", version: old.version, key: want, at: old.retiredAt, nodes: old.nodes, edges: old.edges };
  if (want) viewing.delete(flow.sessionId);
  return { kind: "active", version: flow.version, nodes: flow.nodes, edges: flow.edges };
}

function diagram(nodes, edges, active, choose) {
  const incoming = new Map(nodes.map((n) => [n.name, []]));
  for (const e of edges) incoming.get(e.to)?.push(e);
  const levels = new Map(),
    widths = [],
    positions = new Map();
  for (const n of nodes) {
    const parents = incoming.get(n.name);
    const level = parents.reduce((max, e) => Math.max(max, (levels.get(e.from) ?? 0) + 1), 0);
    levels.set(n.name, level);
    const column = widths[level] ?? 0;
    widths[level] = column + 1;
    positions.set(n.name, { x: 16 + column * 154, y: 12 + level * 90, choice: n.markdown?.choice });
  }
  const width = 18 + Math.max(1, ...widths) * 154,
    height = 12 + widths.length * 90;
  const surface = h("div", { class: "dag-surface", style: `width:${width}px;height:${height}px` });
  // SVG paths scale with browser zoom without allocating a bitmap for a tall graph.
  const ns = "http://www.w3.org/2000/svg";
  const lines = document.createElementNS(ns, "svg");
  lines.setAttribute("width", width);
  lines.setAttribute("height", height);
  lines.setAttribute("aria-hidden", "true");
  for (const e of edges) {
    const a = positions.get(e.from),
      b = positions.get(e.to);
    const x = a.x + 66,
      endX = b.x + 66,
      y = a.y + 49,
      mid = (y + b.y) / 2;
    const line = document.createElementNS(ns, "path");
    line.setAttribute("d", `M${x} ${y} C${x} ${mid} ${endX} ${mid} ${endX} ${b.y} m-3 -5 l3 5 3 -5`);
    if (e.case !== undefined && a.choice === e.to) line.classList.add("chosen");
    lines.append(line);
    if (e.case) {
      const label = document.createElementNS(ns, "text");
      label.setAttribute("x", (x + endX) / 2 + 4);
      label.setAttribute("y", mid);
      label.textContent = e.case;
      lines.append(label);
    }
  }
  surface.append(lines);
  for (const n of nodes) {
    const { x, y } = positions.get(n.name),
      disabled = !openable(n) && !inspectable(n);
    const deps = incoming
      .get(n.name)
      .map((e) => [e.from, e.case].filter(Boolean).join(" · "))
      .join(", ");
    const label = t("flow." + n.status);
    surface.append(
      h(
        "button",
        {
          class: "dag-node",
          style: `left:${x}px;top:${y}px`,
          disabled,
          "data-agent": n.agentId,
          "data-node": n.name,
          "data-state": n.status,
          "aria-pressed": String(!disabled && active === n.name),
          title: [n.name, label, deps, n.summary, ...(n.additionalResults ?? []).map(r => r.summary)].filter(Boolean).join("\n"),
          "aria-label": [n.name, label, deps].filter(Boolean).join(", "),
          onclick: () => choose(n),
        },
        h("strong", {}, n.name),
        h("small", {}, label),
      ),
    );
  }
  return surface;
}

const when = (iso) => new Date(iso).toLocaleString(language, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function renderWorkflow(flow) {
  const panel = $("#task-conversation");
  if (!flow) {
    // 还没有工作流：标签照样能开，标题栏只有标题，下方说明它从哪来。
    panel.firstElementChild?.saveDraft?.();
    document.querySelector("#side-workflow").classList.remove("flow-folded");
    // 标签已经写着"工作流"，空的时候不再要一条标题栏
    $("#flow-heading").hidden = true;
    fill($("#flow-heading"));
    $("#flow-map").hidden = true;
    fill($("#flow-map"));
    renderContract();
    panel.hidden = false;
    fill(panel, h("div", { class: "catalog-empty flow-none" }, h("span", { class: "launcher-icon", html: ICON.flow }),
      h("strong", {}, t("flow.none")), h("small", {}, t("flow.noneHint"))));
    return;
  }
  const shown = versionOf(flow);
  const folded = !!collapsed.get(flow.sessionId);
  const choice = selected.get(flow.sessionId);
  const versionKey = shown.key ?? shown.version;
  const focused = typeof choice === "object" && choice?.version === versionKey && shown.nodes.find(n => n.name === choice.name);
  const fallback = typeof choice === "string" ? choice : state.referenceAgent;
  const node = focused || shown.nodes.find(n => openable(n) && n.agentId === fallback) ||
    (shown.kind === "candidate" && shown.nodes.find(inspectable));
  const id = node ? node.agentId : fallback;
  const error = h("small", { class: "error", role: "alert" }, flow.error);
  const held = flow.controls?.resume;
  const control = (action, names) => xsb.workflowControl(flow.sessionId, action, names)
    .catch((e) => ($("#flow-heading [role='alert']").textContent = e.message));
  const button = (action, label) => h("button", { class: "btn sm", "data-action": action, onclick: () => control(action) }, label);
  const look = (version) => { viewing.set(flow.sessionId, version === flow.version ? null : version); renderWorkflow(flow); };
  // 活动方案和候选方案并排切换；历史版本（最新的在前）收在下拉里。
  const plans = flow.version && flow.candidate && h("div", { class: "segmented flow-plans", role: "group", "aria-label": t("flow.version.label") },
    ...[["active", flow.version], ["candidate", flow.candidate.version]].map(([kind, version]) =>
      h("button", { "aria-pressed": String(shown.kind === kind), title: version, onclick: () => shown.kind !== kind && look(version) }, t("flow." + kind))));
  const history = !!flow.history?.length && h("select", { "aria-label": t("flow.history"),
    onchange: (e) => { viewing.set(flow.sessionId, e.target.value || null); renderWorkflow(flow); } },
    h("option", { value: "", selected: shown.kind !== "history" }, t("flow.history")),
    ...flow.history.map((v) => h("option", { value: v.snapshot ?? v.version, selected: shown.kind === "history" && (v.snapshot ?? v.version) === versionKey },
      t(v.rollback ? "flow.version.beforeRollback" : "flow.version.history", { version: v.version, time: when(v.retiredAt) }))));
  $("#flow-heading").hidden = false;
  fill($("#flow-heading"),
    h("button", { class: "icon-btn flow-fold", "aria-expanded": String(!folded), title: t(folded ? "flow.expand" : "flow.collapse"), "aria-label": t(folded ? "flow.expand" : "flow.collapse"),
      html: folded ? ICON.forward : ICON.down, onclick: () => { collapsed.set(flow.sessionId, !folded); renderWorkflow(flow); } }),
    h("strong", {}, t("flow.title")),
    plans,
    h("small", { title: shown.version }, shown.version),
    history,
    shown.kind === "history" && h("span", { class: "flow-badge" }, t("flow.version.readonly")),
    // 主会话的插话挡住了整张图（它那一轮失败或被停了）：和暂停一样，给"继续"。
    shown.kind === "active" && flow.state === "completed" && h("span", { class: "flow-badge" }, t("flow.finished")),
    shown.kind === "active" && (held ? flow.controls?.resume : flow.controls?.pause) && button(held ? "resume" : "pause", t(held ? "flow.resume" : "flow.pause")),
    shown.kind === "active" && flow.controls?.rollback && button("rollback", t("flow.rollback")),
    error);
  document.querySelector("#side-workflow").classList.toggle("flow-folded", folded);
  const map = $("#flow-map");
  const focusedNode = map.contains(document.activeElement) && document.activeElement.dataset.node;
  // 折叠：整块图收起，只留标题栏，空间都给下方的节点对话。
  map.hidden = folded;
  if (folded) fill(map); else fill(map, diagram(shown.nodes, shown.edges, node?.name, n => {
    if (openable(n)) showTask(n.agentId);
    else {
      selected.set(flow.sessionId, { version: versionKey, name: n.name });
      renderWorkflow(flow);
    }
  }));
  if (focusedNode)
    map.querySelector(`button[data-node="${CSS.escape(focusedNode)}"]:enabled`)?.focus({ preventScroll: true });

  renderContract(flow, versionKey, node, shown.edges, (href, container) => followContentLink(href, container, id ?? state.open[0]),
    shown.kind === "active" && node?.controls?.rollback && (() => control("rollback", [node.name])));

  // 下方的对话：当前版本里的节点可以对话；已被删掉的节点、历史版本里的节点只能查看。
  const chat = node && openable(node);
  if (focused && chat && shown.kind === "active") {
    selected.set(flow.sessionId, id);
    state.referenceAgent = id;
  }
  const dropped = shown.kind === "active" && !node && agentOf(id)?.retired && agentOf(id)?.workflowOwner === flow.sessionId;
  const readonly = shown.kind === "history" ? "flow.readonly.history" : dropped || agentOf(id)?.retired ? "flow.readonly.dropped" : null;
  const lane = panel.firstElementChild;
  const same = (chat || dropped) && lane?.dataset.agent === id && (lane.dataset.readonly ?? null) === (readonly && t(readonly));
  panel.hidden = inspectable(node) && !chat;
  if (!same) {
    lane?.saveDraft?.();
    fill(panel);
    if (chat || dropped) openTaskLane(id, panel, readonly && t(readonly));
    else if (!panel.hidden) fill(panel, h("p", { class: "empty" }, t(shown.nodes.some(inspectable) ? "flow.inspect" : shown.kind === "candidate" ? "flow.preview" : "flow.pick")));
  }
  placeAgents(panel, shown.nodes.filter(openable), id);
}

/** 输入框上方：这个版本里能打开的智能体，横排，点一下切换到它的对话。 */
function placeAgents(panel, nodes, active) {
  panel.querySelector(".flow-agents")?.remove();
  const lane = panel.querySelector(".lane");
  if (!lane || !nodes.length) return;
  const bar = h("div", { class: "flow-agents", role: "tablist", "aria-label": t("flow.agents") }, ...nodes.map((n) =>
    h("button", { class: "flow-agent", role: "tab", "aria-selected": String(n.agentId === active), title: `${n.name} · ${t("flow." + n.status)}`,
      onclick: () => n.agentId !== active && showTask(n.agentId) },
      avatarImage(agentOf(n.agentId)), h("span", {}, n.name),
      h("i", { class: "state", "data-state": n.status === "running" ? "running" : n.status === "completed" ? "done" : "idle" }))));
  (lane.querySelector(".lane-readonly") ?? lane.querySelector(".composer")).before(bar);
}
