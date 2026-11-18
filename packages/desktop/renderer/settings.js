import { closePage, refreshRail, roleOf, roleTitle, showPage, state, STATE_TEXT } from "./app.js";
import { editAgent } from "./agent.js";
import { avatarImage } from "./avatars.js";
import { $, ICON, h } from "./dom.js";
import { field, select } from "./form.js";
import { t } from "./i18n.js";
import { globalPreferences, saveGlobalPreferences, saveWorkspacePreferences, workspacePreferences } from "./preferences.js";
import { showPresets } from "./presets.js";
import { editRole } from "./team.js";

const settingRow = (title, hint, control) => h("div", { class: "setting-row" },
  h("div", { class: "setting-copy" }, h("strong", {}, title), h("small", {}, hint)), control);
const section = (title, ...rows) => h("section", { class: "settings-card" }, h("h2", {}, title), ...rows);
const toggle = (label, checked, change) => h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": label, checked, onchange: (e) => change(e.target.checked) });

/** Keep the settings navigation around the existing role and preset editors. */
export function settingsShell(...content) {
  const navItem = (key, icon) => h("button", { class: "settings-nav-item", "aria-current": state.settings === key ? "page" : null,
    onclick: () => showSettings(key) }, h("span", { html: ICON[icon] }), t(`settings.${key}`));
  return [
    h("header", { class: "bar settings-head" },
      h("span", { class: "settings-mark", html: ICON.settings }),
      h("div", { class: "artifact-title" }, h("strong", {}, t("settings.title")), h("small", {}, t("settings.subtitle"))),
      h("button", { class: "icon-btn", title: t("settings.close"), "aria-label": t("settings.close"), html: ICON.close, onclick: closePage })),
    h("div", { class: "settings-layout" },
      h("nav", { class: "settings-nav", "aria-label": t("settings.navigation") },
        h("h2", {}, t("settings.globalScope")), navItem("general", "appearance"), navItem("backends", "code"),
        h("h2", {}, t("settings.workspaceScope")),
        state.workspace
          ? h("div", { class: "settings-workspace-name", title: state.workspace.path }, state.workspace.name)
          : h("small", { class: "settings-workspace-name" }, t("settings.noWorkspace")),
        ...["workspace", "members", "roles", "teams"].map((key) => state.workspace ? navItem(key, { workspace: "folder", members: "people", roles: "edit", teams: "grid" }[key]) : null)),
      h("div", { class: "settings-content" }, ...content))];
}

let revision = 0;
export function showSettings(key = "general", refresh = true) {
  const current = ++revision;
  if (!state.workspace && !["general", "backends"].includes(key)) key = "general";
  state.settings = key;
  if (key === "teams") {
    showPresets().catch((e) => {
      if (current === revision && state.settings === "teams") showPage("settings", h("div", { class: "settings-body" }, h("p", { class: "error", role: "alert" }, e.message)));
    });
    return;
  }
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
  let content;
  if (key === "general") content = [
    section(t("settings.appearance"),
      settingRow(t("settings.theme"), t("settings.themeHint"), choose("theme", ["light", "dark", "system"])),
      settingRow(t("settings.density"), t("settings.densityHint"), choose("density", ["comfortable", "compact"]))),
    section(t("settings.conversation"), settingRow(t("settings.showTools"), t("settings.showToolsHint"),
      toggle(t("settings.showTools"), global.showTools, (value) => save(() => saveGlobalPreferences({ showTools: value }))))),
  ];
  if (key === "backends") content = [section(t("settings.backends"),
    h("p", { class: "hint" }, t("settings.backendsHint")),
    ...state.backends.map((backend) => settingRow(backend.name, backend.command,
      backend.installed ? h("span", { class: "badge available" }, t("settings.available"))
        : h("button", { class: "btn", disabled: !backend.missing, onclick: async (e) => {
            const button = e.currentTarget;
            button.disabled = true;
            try { if (await xsb.locateProgram(backend.missing)) { state.backends = await xsb.backends(); showSettings("backends"); } }
            catch (error) { failure.textContent = error.message; }
            finally { button.disabled = false; }
          } }, t("common.locate")))),
    !state.backends.length && h("p", { class: "hint" }, t("settings.backendsEmpty")))];
  if (key === "workspace") {
    const prefs = workspacePreferences(state.workspace.path);
    content = [section(t("settings.workspaceInfo"),
      field(t("common.name"), h("div", { class: "readonly" }, state.workspace.name)),
      field(t("settings.folder"), h("div", { class: "readonly path" }, state.workspace.path)),
      h("button", { class: "btn", onclick: () => xsb.newWindow() }, t("settings.openWorkspace"))),
      section(t("settings.taskDisplay"), settingRow(t("settings.showCompleted"), t("settings.showCompletedHint"),
        toggle(t("settings.showCompleted"), prefs.showCompleted, (value) => save(() => {
          saveWorkspacePreferences(state.workspace.path, { showCompleted: value }); refreshRail();
        }))))];
  }
  if (key === "members") content = [section(t("settings.members"),
    h("div", { class: "settings-section-intro" }, h("p", { class: "hint" }, t("settings.membersHint")),
      h("button", { class: "btn primary", onclick: () => editAgent() }, t("agent.new.title"))),
    ...state.agents.map((agent) => h("div", { class: "settings-entity" }, avatarImage(agent, roleOf(agent.role)),
      h("div", { class: "setting-copy" }, h("strong", {}, agent.name), h("small", {}, `${agent.backend} · ${STATE_TEXT[agent.state]}`)),
      h("button", { class: "btn", onclick: () => editAgent(agent) }, t("settings.configure")))),
    !state.agents.length && h("p", { class: "hint" }, t("blank.none")))];
  if (key === "roles") content = [section(t("settings.roles"),
    h("div", { class: "settings-section-intro" }, h("p", { class: "hint" }, t("settings.rolesHint")),
      h("button", { class: "btn primary", onclick: () => editRole() }, t("role.new.title"))),
    ...state.roles.map((role) => h("button", { class: "settings-entity settings-role", onclick: () => editRole(role) }, avatarImage(role),
      h("div", { class: "setting-copy" }, h("strong", {}, roleTitle(role)), h("small", {}, role.description)),
      h("span", { class: "badge" }, t("settings.configure")))),
    !state.roles.length && h("p", { class: "hint" }, t("settings.rolesEmpty")))];
  showPage("settings", h("div", { class: "settings-body" },
    h("div", { class: "settings-heading" }, h("span", { class: "scope-label" }, t(["general", "backends"].includes(key) ? "settings.globalScope" : "settings.workspaceScope")),
      h("h1", { tabindex: "-1" }, t(`settings.${key}`)), h("p", {}, t(["general", "backends"].includes(key) ? "settings.globalHint" : "settings.workspaceHint"))),
    failure, ...content,
    h("small", { class: "settings-saved", role: "status" }, t("settings.autoSave"))));
  $(".settings-heading h1")?.focus({ preventScroll: true });
  if (key === "backends" && refresh) {
    xsb.backends().then((backends) => {
      if (current !== revision || state.settings !== "backends") return;
      state.backends = backends;
      showSettings("backends", false);
    }, (error) => {
      if (current === revision && state.settings === "backends") failure.textContent = error.message;
    });
  }
}

export function settingsBack() {
  if (state.settings) showSettings(state.settings); else closePage();
}

// Update lists behind agent dialogs when hub events arrive, without replacing
// a role editor and discarding the draft the user is working on.
export function refreshSettings() {
  if (state.page === "settings" && ["members", "roles"].includes(state.settings)) showSettings(state.settings);
}
