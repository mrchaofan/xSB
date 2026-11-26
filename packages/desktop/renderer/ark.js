// 火山方舟：设置 → 后端里的一张卡片。arkcli 随应用内置（ark.ts），这里只登录、让 xSB 中的 Claude Code / Codex 接入套餐或解除接入；
// 每一步都由主进程弹框确认后才执行（main.ts），这里只选择和呈现。状态更新只改文字和属性，焦点与展开的详情保留。
import { state } from "./app.js";
import { refreshBackendControls } from "./backend.js";
import { backendIcon } from "./backend-icons.js";
import { h } from "./dom.js";
import { field, openDialog } from "./form.js";
import { t } from "./i18n.js";

/** 官方的套餐概览，其中有购买入口；应用内不下单。 */
const PLAN_GUIDE = "https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-plan-overview";
const ROUTED = "ark-code-latest";
const AGENTS = [["claude", "Claude Code"], ["codex", "Codex"]];

let status = null;
let busy = null;
let error = null;
let notice = null;
let loginUrl = null;
const views = new Set();
// 只忘掉插入过、后来被移走的卡片；打开设置只显示已有结果，检测由用户发起。
const paint = () => { for (const view of views) if (view.isConnected) view.paint(); else if (view.shown) views.delete(view); else view.paint(); };

/** arkcli 打印的登录地址：浏览器没自动打开时，用户可以点它。 */
export function onArkLoginUrl(url) {
  loginUrl = url;
  paint();
}

export const arkModelLabel = (name) => name === ROUTED ? t("ark.model.routed") : name;
const planOf = (profile) => status?.plans.find((p) => p.profile === profile);
const day = (iso) => iso ? new Date(iso).toLocaleDateString() : "";

/** 做一步。run 返回新状态、true（完成）或 null/false（用户在确认框里取消）。 */
async function act(kind, run, done) {
  if (busy) return;
  busy = kind; error = null; notice = null; loginUrl = null;
  paint();
  try {
    const result = await run();
    if (result?.state) status = result;
    else if (result) status = await xsb.arkStatus();
    if (result) {
      if (done) notice = t(done);
      // 接入变了：后端卡片要说明它们现在从哪里来。
      state.backends = await xsb.backends();
      refreshBackendControls();
    }
  } catch (e) {
    error = { kind, message: e.message };
  } finally {
    busy = null; loginUrl = null;
    paint();
  }
}

function presentation() {
  if (busy) return { state: busy, tone: "progress" };
  if (!status) return { state: error ? "broken" : "unchecked", tone: error ? "error" : "attention" };
  const s = status.state;
  return { state: s, tone: s === "ready" ? "success" : s === "broken" ? "error" : "attention" };
}

/** 选择套餐和模型，再交给主进程确认。 */
function bindDialog(cli, name) {
  const plans = status.plans.filter((p) => !p.expired);
  const current = status.bindings[cli];
  const planSelect = h("select", { "aria-label": t("ark.bind.plan") },
    ...plans.map((p) => h("option", { value: p.profile, selected: p.profile === current?.profile }, planText(p))));
  const modelSelect = h("select", { "aria-label": t("ark.bind.model") });
  const hint = h("small", {}, t("ark.bind.modelHint"));
  let dialog;
  const loadModels = async () => {
    const next = dialog?.querySelector(".actions .primary");
    modelSelect.disabled = true;
    next?.setAttribute("aria-disabled", "true");
    modelSelect.replaceChildren(h("option", {}, t("ark.bind.loading")));
    try {
      const models = await xsb.arkModels(planSelect.value);
      const chosen = current?.profile === planSelect.value ? current.model : ROUTED;
      modelSelect.replaceChildren(...models.map((m) => h("option", { value: m.name, selected: m.name === chosen }, arkModelLabel(m.name))));
      modelSelect.disabled = false;
      next?.removeAttribute("aria-disabled");
    } catch (e) {
      modelSelect.replaceChildren(h("option", {}, t("ark.bind.loadFailed")));
      hint.textContent = e.message;
    }
  };
  planSelect.onchange = loadModels;
  dialog = openDialog(t("ark.bind.title", { name }), [
    h("p", { class: "hint" }, t("ark.bind.intro", { name })),
    field(t("ark.bind.plan"), planSelect),
    field(t("ark.bind.model"), modelSelect, hint),
  ], [
    { label: t("common.cancel") },
    { label: t("ark.bind.next"), primary: true, run: async () => {
      if (modelSelect.disabled) return false;
      let changed = false;
      // 主进程的确认框里点了取消：留在这里，可以换个模型或关掉。
      await act("binding", async () => (changed = await xsb.arkBind(cli, planSelect.value, modelSelect.value)), "ark.bind.done");
      if (error) throw new Error(error.message);
      return changed;
    } },
  ]);
  dialog.classList.add("ark-bind");
  void loadModels();
}

const planText = (p) => [p.name, p.expiresAt && t(p.expired ? "ark.plan.expired" : "ark.plan.until", { date: day(p.expiresAt) })].filter(Boolean).join(" · ");

/** 一个智能体是否接入、接入了什么，以及接入 / 更换 / 解除。 */
function agentRow(cli, name) {
  const current = h("small", {});
  const bind = h("button", { class: "btn", type: "button", onclick: () => bindDialog(cli, name) });
  const unbind = h("button", { class: "btn backend-quiet", type: "button",
    onclick: () => act("binding", () => xsb.arkBind(cli, null), "ark.unbind.done") }, t("ark.agent.unbind"));
  const row = h("div", { class: "ark-agent" }, backendIcon(cli),
    h("div", { class: "ark-agent-copy" }, h("strong", {}, name), current), h("div", { class: "ark-agent-actions backend-actions" }, bind, unbind));
  row.paint = () => {
    const binding = status?.bindings[cli];
    const plan = binding && planOf(binding.profile);
    current.textContent = binding
      ? t("ark.agent.bound", { plan: plan?.name ?? binding.profile, model: arkModelLabel(binding.model) }) + (plan?.expired ? t("sentence.gap") + t("ark.agent.expired") : "")
      : t("ark.agent.own");
    current.dataset.tone = binding ? (plan?.expired || !plan ? "attention" : "success") : "";
    bind.textContent = t(binding ? "ark.agent.change" : "ark.agent.bind");
    bind.className = `btn${binding ? "" : " primary"}`;
    bind.hidden = status?.state !== "ready";
    unbind.hidden = !binding;
    bind.disabled = unbind.disabled = !!busy;
  };
  return row;
}

export function arkCard() {
  const badge = h("span", { class: "backend-badge" });
  const version = h("small", { class: "backend-version" });
  const status_ = h("div", { class: "backend-status", role: "status", "aria-live": "polite", "aria-atomic": "true" }, badge, version);
  const description = h("p", { class: "backend-description" });
  const plans = h("ul", { class: "ark-plans" });
  const loginLink = h("a", { class: "backend-guide", target: "_blank", rel: "noopener" }, t("ark.login.open"));
  const cancelLogin = h("button", { class: "btn", type: "button", onclick: () => xsb.arkCancelLogin() }, t("ark.login.cancel"));
  const waiting = h("div", { class: "ark-waiting" }, h("p", { class: "hint" }, t("ark.login.waiting")), h("div", { class: "backend-actions" }, loginLink, cancelLogin));
  const primary = h("button", { type: "button" });
  const recheck = h("button", { class: "btn", type: "button", onclick: () => act("checking", () => xsb.arkStatus()) }, t("backend.action.recheck"));
  const buy = h("a", { class: "btn primary", href: PLAN_GUIDE, target: "_blank", rel: "noopener" }, t("ark.plan.buy"));
  const where = h("code", { class: "backend-path" });
  const menu = h("div", { class: "backend-options", popover: "auto", id: "ark-options", style: "position-anchor: --ark-options" },
    h("small", {}, t("ark.path")), where,
    h("a", { class: "backend-guide", href: PLAN_GUIDE, target: "_blank", rel: "noopener" }, t("ark.plan.guide")));
  const more = h("button", { class: "btn backend-more-trigger", type: "button", popovertarget: "ark-options", "aria-label": t("backend.more.label", { name: t("ark.name") }),
    style: "anchor-name: --ark-options" }, t("backend.more"), h("span", { "aria-hidden": "true" }, "⋯"));
  const actions = h("div", { class: "backend-actions" }, primary, buy, recheck, more);
  const agents = AGENTS.map(([cli, name]) => agentRow(cli, name));
  const agentList = h("div", { class: "ark-agents" }, h("small", { class: "ark-agents-title" }, t("ark.agents")), ...agents);
  const noticeLine = h("p", { class: "backend-notice", role: "status", "aria-live": "polite" });
  const errorText = h("p", {});
  const errorDetails = h("details", { class: "backend-error-details" }, h("summary", {}, t("backend.error.details")), errorText);
  const root = h("section", { class: "backend-card ark-card", "aria-label": t("ark.name") },
    h("div", { class: "backend-card-head" }, backendIcon("ark", "lg"),
      h("div", { class: "backend-identity" }, h("h2", {}, t("ark.name")), h("small", {}, t("ark.vendor"))), status_),
    description, plans, waiting, actions, agentList, noticeLine, errorDetails, menu);
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.matches(":popover-open")) { event.preventDefault(); event.stopPropagation(); menu.hidePopover(); more.focus(); }
  });

  root.paint = () => {
    root.shown ||= root.isConnected;
    const p = presentation();
    const s = status?.state;
    root.dataset.tone = p.tone;
    root.setAttribute("aria-busy", busy ? "true" : "false");
    badge.textContent = t(`ark.status.${p.state}`);
    badge.dataset.tone = p.tone;
    version.textContent = status?.version && !busy ? `v${status.version}` : "";
    description.textContent = error ? t(`ark.failure.${error.kind}`) : t(`ark.detail.${p.state}`);
    description.hidden = !error && ["unchecked", "checking", "binding", "ready"].includes(p.state);
    // 程序无法运行时说明里已经讲了怎么办；内置程序的路径不能由用户指定，通用的“检查路径”提示不适用。
    if (status?.issue && status.issue !== "execution" && !busy && !error) description.textContent += t("sentence.gap") + t(`backend.issue.${status.issue}`);
    plans.replaceChildren(...(s === "ready" || s === "noPlan" ? status.plans : []).map((plan) => h("li", { "data-expired": plan.expired ? "true" : "false" }, planText(plan))));
    plans.hidden = !plans.children.length || !!busy;
    waiting.hidden = busy !== "login";
    loginLink.hidden = !loginUrl;
    if (loginUrl) loginLink.href = loginUrl;
    const next = busy ? null : error ? { unauthenticated: "login" }[s] ?? "check"
      : { unchecked: "check", broken: "check", unauthenticated: "login" }[p.state];
    primary.hidden = !next && !(busy && busy !== "login");
    primary.className = `btn primary${busy ? " backend-working" : ""}`;
    primary.setAttribute("aria-disabled", busy ? "true" : "false");
    primary.textContent = busy ? t(`ark.action.${busy}`) : next ? t(p.state === "unchecked" ? "backend.check" : `ark.action.${next}`) : "";
    primary.onclick = () => {
      if (busy || !next) return;
      if (next === "login") act("login", () => xsb.arkLogin(), "ark.login.done");
      else act("checking", () => xsb.arkStatus());
    };
    buy.hidden = !!busy || s !== "noPlan";
    recheck.hidden = !!busy || !["noPlan", "ready", "unauthenticated"].includes(s);
    more.hidden = !status;
    where.textContent = status?.path ?? t("ark.path.none");
    const bound = Object.keys(status?.bindings ?? {}).length > 0;
    agentList.hidden = !(s === "ready" || bound);
    for (const row of agents) row.paint();
    noticeLine.hidden = !notice;
    noticeLine.textContent = notice ?? "";
    errorDetails.hidden = !error;
    errorText.textContent = error?.message ?? "";
  };
  views.add(root);
  root.paint();
  return root;
}
