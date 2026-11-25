// 设置里的"插件"：工具服务以文件夹的形式放在三个地方（hub 的 plugins.ts），结构相同。每个文件夹是一个 npm 包，
// 运行的文件是 package.json 的 main：
//   应用自带  <应用>/plugins/<名称>/package.json
//   这台设备  ~/.xsb2_global/plugins/<名称>/package.json
//   本工作区  <工作区>/.xsb2/plugins/<名称>/package.json
// 添加插件 = 把文件夹放进去，重启桌面端或点"重新加载"。这里只看、启停、确认工作区插件，不编辑插件本身。
import { ICON, fill, h } from "./dom.js";
import { t } from "./i18n.js";

/** 每个设置页列出哪些地方的插件。 */
const PLACES = { global: ["builtin", "global"], project: ["project", "global", "builtin"] };

/** 一个插件的状态徽标：有问题、待确认、被覆盖、已停用、生效中。 */
function status(view) {
  if (view.problem) return ["error", t("plugins.status.problem")];
  if (view.scope === "project" && !view.approved) return ["attention", t("plugins.status.unapproved")];
  if (view.replaced) return ["", t("plugins.status.replaced")];
  if (!view.enabled) return ["", t("plugins.status.off")];
  return ["success", t("plugins.status.active")];
}

/** 设置分类的内容。page："global"（应用自带和这台设备）或 "project"（本工作区；也可在这里停用其他插件）。 */
export function pluginsSection(page) {
  const list = h("div", { class: "tool-list" });
  const note = h("p", { class: "tool-note", role: "status", hidden: true });
  const failure = h("p", { class: "error", role: "alert" });
  let views = [];
  const act = (work, message) => {
    failure.textContent = "";
    work.then((next) => { views = next; if (message) { note.textContent = message; note.hidden = false; } render(); },
      (e) => { failure.textContent = t("plugins.error", { error: e.message }); });
  };
  // 开关写进哪个配置：工作区页写工作区配置（只影响本工作区），设备页写设备配置。
  const settingScope = page === "project" ? "project" : "global";

  const card = (view) => {
    const [tone, label] = status(view);
    const usable = !view.problem && !view.replaced && (view.scope !== "project" || view.approved);
    return h("section", { class: "tool-card", "data-scope": view.scope },
      h("div", { class: "tool-card-head" },
        h("span", { class: "tool-mark", "aria-hidden": "true", html: ICON.plug }),
        h("div", { class: "tool-identity" }, h("strong", {}, view.name), h("small", { title: view.dir }, t(`plugins.scope.${view.scope}`))),
        h("span", { class: "backend-badge", "data-tone": tone || null }, label),
        usable && h("input", { type: "checkbox", class: "switch", role: "switch", checked: view.enabled, "aria-label": t("plugins.enable", { name: view.name }),
          onchange: (e) => act(xsb.setPluginEnabled(settingScope, view.name, e.target.checked), t("plugins.applied")) })),
      view.description && h("p", { class: "tool-about" }, view.description),
      view.runs && h("code", { class: "tool-command" }, view.runs),
      view.problem && h("p", { class: "tool-problem" }, t(`plugins.problem.${view.problem}`)),
      view.scope === "project" && !view.problem && !view.approved && h("div", { class: "tool-approve" },
        h("p", {}, t("plugins.unapproved")),
        h("button", { class: "btn primary", onclick: () => act(xsb.approvePlugin(view.name), t("plugins.applied")) }, t("plugins.approve"))));
  };

  const group = (scope) => {
    const items = views.filter((v) => v.scope === scope);
    return h("section", { class: "tool-group" },
      h("div", { class: "tool-group-head" }, h("h3", { class: "tool-subhead" }, t(`plugins.group.${scope}`)),
        scope !== "builtin" && h("button", { class: "btn sm", onclick: () => xsb.revealPlugins(scope).catch((e) => (failure.textContent = e.message)) }, t("plugins.reveal"))),
      items.length ? h("div", { class: "tool-group" }, ...items.map(card))
        : h("p", { class: "tool-empty-line" }, t("plugins.none", { path: t(`plugins.path.${scope}`) })));
  };

  function render() {
    fill(list, ...PLACES[page].filter((scope) => scope !== "builtin" || views.some((v) => v.scope === "builtin")).map(group));
  }
  act(xsb.plugins());
  return [
    h("div", { class: "settings-section-intro" },
      h("p", { class: "hint" }, t(page === "project" ? "plugins.introProject" : "plugins.introGlobal")),
      h("button", { class: "btn", onclick: () => act(xsb.reloadPlugins(), t("plugins.reloaded")) }, t("plugins.reload"))),
    note, failure, list,
  ];
}
