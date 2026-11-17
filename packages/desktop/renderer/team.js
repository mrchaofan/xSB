// 角色的编辑，和团队的产出总览。两者都是占用主区域的页面（showPage）。
import { confirmRestart, previewPrompt } from "./agent.js";
import { assetName, nameOf, onRole, roleOf, roleTitle, showPage, state } from "./app.js";
import { avatarPicker } from "./avatars.js";
import { ICON, fill, h } from "./dom.js";
import { confirmDialog, field, input, select } from "./form.js";
import { t } from "./i18n.js";
import { settingsBack } from "./settings.js";

/** 对几个智能体依次做的事停在了半路：做成了哪些，为什么停。全做成了就是 null。 */
export const halted = ({ done, failed, error }) => (error ? t("progress.stopped", { count: done.length, failed: failed ? nameOf(failed) : "", names: done.map(nameOf).join(t("list.separator")), error }) : null);

export const pageHead = (title, subtitle, ...actions) => h("header", { class: "bar" },
  h("div", { class: "artifact-title" }, h("strong", {}, title), h("small", {}, subtitle)),
  ...actions,
  h("button", { class: "icon-btn", title: t(state.settings ? "settings.back" : "page.close"), "aria-label": t(state.settings ? "settings.back" : "page.close"), html: state.settings ? ICON.back : ICON.close, onclick: settingsBack }));

/** role 为空 = 新建。角色是模板：这里的修改影响它的所有 Agent。 */
export function editRole(role) {
  state.settings = "roles";
  const creating = !role;
  const draft = structuredClone(role ?? { name: "", preset: null, description: "", backend: "", instructions: "", mcpServers: [], skills: [] });
  const users = () => (creating ? [] : state.agents.filter((a) => a.role === role.name));
  /** 预设团队的角色：按预设使用（"as-is"），还是工作区自己改过的版本（"own"）。不是预设的角色为 null。 */
  const shipped = () => (creating || !role.preset ? null : role.preset.own ? "own" : "as-is");
  const names = () => users().map((a) => a.name).join(t("list.separator"));
  const opened = new WeakSet();         // 展开着的 skill
  const option = { sync: false, reveal: false };
  let applied = [];                    // 本次保存已重启的实例，失败后只补剩余的
  let notice = null;                    // 保存之后的结果：{ text, apply? }
  const body = h("div", { class: "page-body" });

  const section = (title, hint, ...content) => h("section", {}, h("h2", {}, title), hint && h("p", { class: "hint" }, hint), ...content);
  const check = (key, label) => h("label", { class: "check" },
    h("input", { type: "checkbox", checked: option[key], onchange: (e) => { option[key] = e.target.checked; render(); } }), label);
  const drop = (list, item) => () => { list.splice(list.indexOf(item), 1); render(); };

  function serverCard(server) {
    const saved = !creating && role.mcpServers.some((s) => s.name === server.name);
    const result = h("small", { role: "status" }, saved ? t("server.test.saved") : t("server.test.unsaved"));
    const test = async () => {
      result.textContent = t("server.test.starting");
      const r = await xsb.testMcp(role.name, server.name).catch((e) => ({ error: e.message }));
      result.textContent = r.tools ? t("server.test.ok", { count: r.tools.length, tools: r.tools.join(t("list.separator")) }) : t("server.test.failed", { error: r.error });
    };
    return h("div", { class: "card" },
      h("div", { class: "grid" },
        field(t("common.name"), input(server, "name", { placeholder: "render" })),
        field(t("server.command"), input(server, "command", { placeholder: "npx" })),
        field(t("server.args"), h("input", { value: server.args.join(" "), placeholder: "-y @acme/render-mcp", oninput: (e) => { server.args = e.target.value.split(/\s+/).filter(Boolean); } }))),
      h("div", { class: "field" }, h("span", {}, t("server.env")),
        ...server.env.map((pair) => h("div", { class: "pair" },
          input(pair, "name", { placeholder: "API_KEY", "aria-label": t("server.env.name") }),
          input(pair, "value", { type: option.reveal ? "text" : "password", "aria-label": t("server.env.value") }),
          h("button", { class: "icon-btn", title: t("server.env.remove"), "aria-label": t("server.env.remove"), html: ICON.close, onclick: drop(server.env, pair) }))),
        h("button", { class: "link", onclick: () => { server.env.push({ name: "", value: "" }); render(); } }, t("server.env.add"))),
      h("div", { class: "card-foot" }, result,
        h("button", { class: "btn", disabled: !saved, onclick: test }, t("server.test")),
        h("button", { class: "btn", onclick: drop(draft.mcpServers, server) }, t("common.remove"))));
  }

  function skillCard(skill) {
    const saved = !creating && role.skills.some((s) => s.name === skill.name);
    const auto = skill.produces != null;
    const use = h("select", { onchange: (e) => { skill.produces = e.target.value === "auto" ? "" : null; render(); } },
      h("option", { value: "auto", selected: auto }, t("skill.use.auto")),
      h("option", { value: "demand", selected: !auto }, t("skill.use.demand")));
    return h("details", { class: "card", open: opened.has(skill), ontoggle: (e) => (e.target.open ? opened.add(skill) : opened.delete(skill)) },
      h("summary", {}, h("strong", {}, skill.name || t("skill.unnamed")), h("small", {}, skill.description)),
      h("div", { class: "grid" },
        field(t("skill.use"), use),
        auto && field(t("skill.produces"), input(skill, "produces", { placeholder: "shot_list" }), t("skill.produces.hint")),
        auto && field(t("skill.inputs"), input(skill, "inputs", { placeholder: "script, character" }), t("skill.inputs.hint"))),
      h("div", { class: "grid" },
        field(t("common.name"), input(skill, "name", { placeholder: "shots" })),
        field(t("skill.description"), input(skill, "description"), t("skill.description.hint"))),
      field(t("skill.body"), input(skill, "body", { rows: 8 }), t("skill.body.hint")),
      h("div", { class: "card-foot" },
        h("small", {}, saved ? t("skill.folder.saved") : t("skill.folder.unsaved")),
        h("button", { class: "btn", disabled: !saved, onclick: () => xsb.revealSkill(role.name, skill.name) }, t("skill.folder.open")),
        h("button", { class: "btn", onclick: drop(draft.skills, skill) }, t("common.remove"))));
  }

  const skillGroup = (auto, title, hint) => h("div", { class: "group" },
    h("h3", {}, title), h("p", { class: "hint" }, hint),
    ...draft.skills.filter((s) => (s.produces != null) === auto).map(skillCard),
    h("button", { class: "link", onclick: () => { const skill = { name: "", produces: auto ? "" : null, inputs: "", description: "", body: "" }; opened.add(skill); draft.skills.push(skill); render(); } }, t("skill.add")));

  const save = async () => {
    const synced = option.sync ? users() : [];
    if (!await confirmRestart(synced.filter((a) => draft.backend && a.backend !== draft.backend), t("restart.action.sync"))) return;
    onRole(await xsb.putRole(draft));
    applied = [];
    if (creating) return editRole(roleOf(draft.name));

    role = roleOf(draft.name);
    const stopped = synced.length ? halted(await xsb.syncRole(role.name)) : null;      // 智能体的变化随事件到达
    notice = stopped ? { text: stopped }
      : users().length ? { text: t("role.saved.pending", { names: names() }), apply: true }
      : { text: t("role.saved") };
    render();
  };

  /** 做一件事；做不成就把原因写在页面顶部。 */
  const shown = (work) => () => work().catch((e) => { notice = { text: e.message }; render(); });

  const apply = async () => {
    if (!await confirmRestart(users().filter((a) => !applied.includes(a.id)), t("restart.action.apply"))) return;
    const result = await xsb.applyRole(role.name, applied);
    applied = result.done;
    notice = { text: halted(result) ?? t("role.applied", { names: names() }), apply: !!result.error };
    render();
  };

  const restore = async () => {
    if (!await confirmDialog(t("role.restore.title", { name: roleTitle(role) }), [h("p", {}, t("role.restore.body", { role: role.name, team: role.preset.teamTitle }))], t("role.restore"))) return;
    await xsb.removeRole(role.name);           // 恢复成的预设版本随事件先到
    editRole(roleOf(role.name));
  };

  const remove = async () => {
    if (!await confirmDialog(t("role.delete.title", { name: roleTitle(role) }), [h("p", {}, t("role.delete.body", { role: role.name }))], t("role.delete"))) return;
    await xsb.removeRole(role.name);
    settingsBack();
  };

  function render() {
    const count = users().length;
    const top = body.scrollTop;       // 重绘会把 body 重新接到页面上，滚动位置随之归零：记下来，画完放回去
    showPage(creating ? "+" : role.name,
      pageHead(creating ? t("role.new.title") : t("role.page.title", { name: roleTitle(role) }),
        creating ? t("role.new.hint") : [
          roleTitle(role) !== role.name && t("role.page.id", { role: role.name }),      // 显示名不是目录名时，目录名写在这里
          shipped() === "as-is" && t("role.page.preset.asis", { team: role.preset.teamTitle }),
          shipped() === "own" && t("role.page.preset.own", { team: role.preset.teamTitle }),
          t("role.page.users", { count, names: names() }),
        ].filter(Boolean).join(t("sentence.gap")),
        !creating && h("button", { class: "btn", disabled: !count, title: count ? null : t("role.preview.disabled"), onclick: () => previewPrompt(users()) }, t("prompt.preview")),
        shipped() === "own" && h("button", { class: "btn", onclick: shown(restore) }, t("role.restore")),
        !creating && !shipped() && h("button", { class: "btn", disabled: count > 0, title: count ? t("role.delete.disabled") : null, onclick: shown(remove) }, t("role.delete")),
        h("button", { class: "btn primary", onclick: shown(save) }, creating ? t("role.create") : t("common.save"))),
      body);

    fill(body,
      notice && h("div", { class: "notice", role: "status" }, h("span", {}, notice.text),
        notice.apply && h("button", { class: "btn", onclick: shown(apply) }, t("role.apply"))),

      section(t("role.defaults.title"), creating ? null : t("role.defaults.hint"),
        creating && field(t("common.name"), input(draft, "name", { placeholder: "gaffer" }), t("common.id.hint")),
        field(t("avatar.title"), avatarPicker(draft), t("avatar.role.hint")),
        field(t("agent.description"), input(draft, "description")),
        field(t("role.backend"), select(draft, "backend", [["", t("role.backend.none")], ...state.backends.map((b) => [b.name, b.installed ? b.name : t("role.backend.missing", { name: b.name })])])),
        count > 0 && check("sync", t("role.sync", { names: names() }))),

      section(t("role.instructions.title"), t("role.instructions.hint"),
        input(draft, "instructions", { rows: 7, "aria-label": t("role.instructions.title") })),

      section(t("role.servers.title"), t("role.servers.hint", { role: draft.name || t("role.servers.unnamed") }),
        ...draft.mcpServers.map(serverCard),
        h("div", { class: "card-foot" },
          draft.mcpServers.some((s) => s.env.length) && check("reveal", t("role.servers.reveal")),
          h("button", { class: "link", onclick: () => { draft.mcpServers.push({ name: "", command: "", args: [], env: [] }); render(); } }, t("role.servers.add")))),

      section(t("role.skills.title"), null,
        skillGroup(true, t("role.skills.auto"), t("role.skills.auto.hint")),
        skillGroup(false, t("role.skills.demand"), t("role.skills.demand.hint"))),
    );
    body.scrollTop = top;
  }
  render();
}

/** 团队层面的契约：每类资产由哪个角色、哪些 Agent 产出、依据什么，哪里有缺口。 */
export function showOverview() {
  const produced = (r) => r.skills.map((s) => s.produces).filter(Boolean);
  const madeFrom = (type) => [...new Set(state.roles.flatMap((r) => r.skills.filter((s) => s.produces === type).flatMap((s) => s.inputs.split(",").map((input) => input.trim()).filter(Boolean))))];
  const used = [...state.tasks.map((task) => task.produces), ...state.artifacts.map((a) => a.assetType)].filter(Boolean);
  const types = [...new Set([...state.roles.flatMap(produced), ...used])].sort();
  const idle = state.roles.filter((r) => !produced(r).length);
  const gap = (text) => h("span", { class: "gap" }, h("i", { class: "state", "data-state": "requires_action" }), text);

  const rows = types.map((type) => {
    const roles = state.roles.filter((r) => produced(r).includes(type));
    const agents = state.agents.filter((a) => roles.some((r) => r.name === a.role));
    return h("tr", {},
      h("td", {}, h("code", {}, assetName(type))),
      h("td", {}, ...(roles.length
        ? roles.map((r) => h("button", { class: "link", onclick: () => editRole(r) }, roleTitle(r)))
        : [gap(t("overview.gap.norole"))])),
      h("td", {}, roles.length === 0 ? "" : agents.length ? agents.map((a) => a.name).join(t("list.separator")) : gap(t("overview.gap.noagent"))),
      h("td", {}, ...madeFrom(type).map((from) => (state.roles.some((r) => produced(r).includes(from)) ? h("code", {}, assetName(from)) : gap(t("overview.gap.input", { type: assetName(from) }))))));
  });

  showPage("overview",
    pageHead(t("overview.title"), t("overview.hint")),
    h("div", { class: "page-body" },
      types.length
        ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, t("overview.col.type")), h("th", {}, t("overview.col.roles")), h("th", {}, t("overview.col.agents")), h("th", {}, t("overview.col.inputs")))), h("tbody", {}, ...rows))
        : h("p", { class: "hint" }, t("overview.empty")),
      idle.length > 0 && h("p", { class: "hint" }, t("overview.idle"),
        ...idle.map((r) => h("button", { class: "link", onclick: () => editRole(r) }, roleTitle(r))))));
}
