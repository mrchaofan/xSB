import { refreshRail, state } from "./app.js";
import { backendControls, refreshBackendControls } from "./backend.js";
import { ICON, fill, h } from "./dom.js";
import { confirmDialog, field, select } from "./form.js";
import { t } from "./i18n.js";
import { globalPreferences, saveGlobalPreferences } from "./preferences.js";
import { pluginsSection } from "./tools.js";

const GLOBAL_KEYS = ["general", "backends", "tools"];

const settingRow = (title, hint, control) => h("div", { class: "setting-row" },
  h("div", { class: "setting-copy" }, h("strong", {}, title), h("small", {}, hint)), control);
const section = (title, ...rows) => h("section", { class: "settings-card" }, h("h2", {}, title), ...rows);
const toggle = (label, checked, change) => h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": label, checked, onchange: (e) => change(e.target.checked) });

/**
 * 设置是一个模态对话框：开着时窗口其余部分不能点，主布局也不变。分类分属这台设备或打开的工作区。
 * Esc 或关闭按钮关掉它。
 */
const dialog = h("dialog", { class: "settings-dialog form", "aria-labelledby": "settings-title" });
dialog.addEventListener("close", () => { state.settings = null; refreshRail(); });

export function closeSettings() {
  if (dialog.open) dialog.close();
}

function settingsShell(...content) {
  const navItem = (key, icon) => h("button", { class: "settings-nav-item", "aria-current": state.settings === key ? "page" : null,
    onclick: () => showSettings(key) }, h("span", { html: ICON[icon] }), t(`settings.${key}`));
  return [
    h("header", { class: "bar settings-head" },
      h("span", { class: "settings-mark", html: ICON.settings }),
      h("div", { class: "artifact-title" }, h("strong", { id: "settings-title" }, t("settings.title")), h("small", {}, t("settings.subtitle"))),
      h("button", { class: "icon-btn", title: t("settings.close"), "aria-label": t("settings.close"), html: ICON.close, onclick: closeSettings })),
    h("div", { class: "settings-layout" },
      h("nav", { class: "settings-nav", "aria-label": t("settings.navigation") },
        h("h2", {}, t("settings.globalScope")), navItem("general", "appearance"), navItem("backends", "code"), navItem("tools", "plug"),
        h("h2", {}, t("settings.workspaceScope")),
        state.workspace
          ? h("div", { class: "settings-workspace-name", title: state.workspace.path }, state.workspace.name)
          : h("small", { class: "settings-workspace-name" }, t("settings.noWorkspace")),
        state.workspace && navItem("workspace","folder"), state.workspace && navItem("workspaceTools", "plug")),
      h("div", { class: "settings-content" }, ...content))];
}

/** 清理工作区：彻底删掉已删除对话留下的东西（中枢的 Agents.purge），先确认，做完说释放了多少。 */
function cleanupSection() {
  const result = h("small", { class: "settings-saved", role: "status" });
  const button = h("button", { class: "btn", onclick: async () => {
    if (!(await confirmDialog(t("settings.cleanup.confirmTitle"), [h("p", {}, t("settings.cleanup.confirmBody"))], t("settings.cleanup.run")))) return;
    button.disabled = true;
    result.textContent = t("settings.cleanup.running");
    try {
      const { conversations, bytes } = await xsb.cleanUp();
      result.textContent = conversations ? t("settings.cleanup.done", { count: conversations, size: bytesText(bytes) }) : t("settings.cleanup.nothing");
    } catch (e) {
      result.textContent = t("settings.cleanup.failed", { error: e.message });
    } finally { button.disabled = false; }
  } }, t("settings.cleanup.run"));
  return section(t("settings.storage"), h("div", { class: "settings-card-body" },
    settingRow(t("settings.cleanup"), t("settings.cleanupHint"), button)), result);
}

/** 字节数，读起来顺的单位。 */
function bytesText(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
}

/** 工作区的工作语言（.xsb2/config.json）。 */
function languageSection() {
  const body = h("div", { class: "settings-card-body" });
  const failure = h("p", { class: "error", role: "alert" });
  const paint = (current) => fill(body, settingRow(t("settings.language"), t("settings.languageHint"),
    h("select", { "aria-label": t("settings.language"), onchange: (e) => xsb.setProjectLanguage(e.target.value).then(paint, (err) => { failure.textContent = t("settings.saveFailed", { error: err.message }); }) },
      !current && h("option", { value: "", selected: true, disabled: true }, t("settings.languageUnset")),
      ...[["en", "English"], ["zh-CN", "简体中文"]].map(([value, label]) => h("option", { value, selected: current === value }, label)))));
  xsb.projectLanguage().then(paint, (e) => { failure.textContent = e.message; });
  return [failure, section(t("settings.languageSection"), body)];
}

/**
 * 限制都在这台设备上（~/.xsb2_global/config.json），没有工作区或会话单独的设置。表单按中枢给出的表生成（默认值、范围），
 * 留空即用默认值；改动立即保存，下次用到时生效。backend：某个后端的上下文限制；null：中枢的限制。
 */
function limitRows(items, backend, failure) {
  return items.map((item) => {
    const input = h("input", { type: "number", class: "limit-input", min: item.min, max: item.max, step: 1, placeholder: String(item.default),
      value: item.value ?? "", "aria-label": t(`limits.${item.name}`) });
    const error = h("small", { class: "limit-error", role: "alert" });
    input.onchange = () => {
      const text = input.value.trim();
      const value = text === "" ? null : Number(text);
      if (value !== null && (!Number.isInteger(value) || value < item.min || value > item.max)) {
        error.textContent = t("limits.range", { min: item.min.toLocaleString(), max: item.max.toLocaleString() });
        return;
      }
      error.textContent = "";
      if (value === (item.value ?? null)) return;
      xsb.setLimit(backend, item.name, value).then(() => { item.value = value ?? undefined; },
        (e) => { failure.textContent = t("settings.saveFailed", { error: e.message }); });
    };
    input.onkeydown = (e) => { if (e.key === "Enter") input.blur(); };
    return h("div", { class: "setting-row" },
      h("div", { class: "setting-copy" }, h("strong", {}, t(`limits.${item.name}`)),
        h("small", {}, t(`limits.${item.name}.hint`), " ", t("limits.default", { value: item.default.toLocaleString() })), error),
      input);
  });
}

let revision = 0;
export function showSettings(key = "general", refresh = true) {
  const current = ++revision;
  if (!state.workspace && !GLOBAL_KEYS.includes(key)) key = "general";
  state.settings = key;
  const failure = h("p", { class: "error", role: "alert" });
  const save = (work) => {
    try { work(); failure.textContent = ""; } catch (e) { failure.textContent = t("settings.saveFailed", { error: e.message }); }
  };
  const global = globalPreferences();
  const choose = (name, choices) => {
    const control = select(global, name, choices.map((value) => [value, t(`settings.${value}`)]), () => save(() => saveGlobalPreferences({ [name]: global[name] })));
    control.setAttribute("aria-label", t(`settings.${name}`));
    return control;
  };
  let content, backendList;
  // 每个后端卡片下可展开它自己的上下文限制（按后端设置，因为取决于它的模型）。
  const limitsFailure = h("p", { class: "error", role: "alert" });
  const limits = key === "backends" ? xsb.limitSettings() : null;
  const backendCards = () => state.backends.map((backend) => {
    const card = backendControls(backend, undefined, { card: true });
    const body = h("div", { class: "settings-card-body" });
    limits.then((all) => fill(body, ...limitRows(all.backends[backend.name] ?? [], backend.name, limitsFailure)), (e) => { limitsFailure.textContent = e.message; });
    card.append(h("details", { class: "backend-limits" }, h("summary", {}, t("limits.backend")), h("p", { class: "hint" }, t("limits.intro")), body));
    return card;
  });
  const hubLimits = h("div", { class: "settings-card-body" });
  limits?.then((all) => fill(hubLimits, ...limitRows(all.hub, null, limitsFailure)), () => {});
  if (key === "general") content = [
    section(t("settings.appearance"),
      settingRow(t("settings.theme"), t("settings.themeHint"), choose("theme", ["light", "dark", "system"])),
      settingRow(t("settings.density"), t("settings.densityHint"), choose("density", ["comfortable", "compact"]))),
    section(t("settings.conversation"), settingRow(t("settings.showTools"), t("settings.showToolsHint"),
      toggle(t("settings.showTools"), global.showTools, (value) => save(() => saveGlobalPreferences({ showTools: value }))))),
  ];
  if (key === "backends") content = [
    h("p", { class: "hint" }, t("settings.backendsHint")),
    limitsFailure,
    backendList = h("div", { class: "backend-list" }, ...backendCards()),
    h("div", { class: "backend-check" },
      h("div", { class: "backend-assurance" }, h("span", { "aria-hidden": "true", html: ICON.check }), h("span", {}, t("backend.check.free"))),
      h("details", { class: "backend-explanation" }, h("summary", {}, t("backend.check.scope")), h("p", { class: "hint" }, t("backend.check.hint")))),
    section(t("limits.hub"), h("p", { class: "hint" }, t("limits.hubIntro")), hubLimits)];
  if (key === "tools") content = pluginsSection("global");
  if (key === "workspaceTools") content = pluginsSection("project");
  if (key === "workspace") {
    content = [section(t("settings.workspaceInfo"),
      field(t("common.name"), h("div", { class: "readonly" }, state.workspace.name)),
      field(t("settings.folder"), h("div", { class: "readonly path" }, state.workspace.path))),
      ...languageSection(), cleanupSection()];
  }
  fill(dialog, ...settingsShell(h("div", { class: "settings-body" },
    h("div", { class: "settings-heading" }, h("span", { class: "scope-label" }, t(GLOBAL_KEYS.includes(key) ? "settings.globalScope" : "settings.workspaceScope")),
      h("h1", { tabindex: "-1" }, t(`settings.${key}`)), h("p", {}, t(GLOBAL_KEYS.includes(key) ? "settings.globalHint" : "settings.workspaceHint"))),
    failure, ...content,
    ["general", "workspace"].includes(key) && h("small", { class: "settings-saved", role: "status" }, t("settings.autoSave")))));
  if (!dialog.isConnected) document.body.append(dialog);
  if (!dialog.open) dialog.showModal();
  refreshRail();
  dialog.querySelector(".settings-heading h1")?.focus({ preventScroll: true });
  if (key === "backends" && refresh) {
    xsb.backends().then((backends) => {
      if (current !== revision || state.settings !== "backends") return;
      const sameNames = state.backends.map((b) => b.name).join("\0") === backends.map((b) => b.name).join("\0");
      state.backends = backends;
      if (sameNames) refreshBackendControls(); else backendList.replaceChildren(...backendCards());
      if (!backends.length) backendList.replaceChildren(h("p", { class: "hint" }, t("settings.backendsEmpty")));
    }, (error) => {
      if (current === revision && state.settings === "backends") failure.textContent = error.message;
    });
  }
}

export function settingsBack() {
  if (state.settings) showSettings(state.settings); else closeSettings();
}
