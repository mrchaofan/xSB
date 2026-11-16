// 预设团队：应用自带的几支团队（软件开发、电影制作）。工作区"使用"一支团队，就有了它的全部角色。
// 使用不是复制：角色按应用自带的版本生效，应用更新了它们也跟着更新。在工作区里改过的角色才是工作区自己的，
// 可以随时恢复成预设。
import { agentOf, assetName, onAgent, reloadRoles, roleOf, showPage, state } from "./app.js";
import { markdownHtml } from "./content.js";
import { fill, h } from "./dom.js";
import { t } from "./i18n.js";
import { editRole, pageHead } from "./team.js";

const body = h("div", { class: "page-body" });
const opened = new Set();         // 展开着的角色：页面重画后保持展开
let notice = [];                  // 上一次操作的结果，一行一条

export async function showPresets() {
  const packs = await xsb.presets();
  const top = body.scrollTop;
  showPage("presets", pageHead(t("presets.title"), t("presets.hint")), body);
  fill(body,
    notice.length > 0 && h("div", { class: "notice", role: "status" }, h("span", {}, ...notice.map((line) => h("div", {}, line)))),
    ...packs.map(packSection));
  body.scrollTop = top;
}

/** 做一件事，把结果写在页面顶部，然后按最新的状态重画。 */
const run = (work) => async () => {
  try { notice = await work(); } catch (e) { notice = [e.message]; }
  await reloadRoles();
  await showPresets();
};

function packSection(pack) {
  /** 使用这支团队，并给还没有 Agent 的角色各建一个（id 用角色名）。可以重复执行：只补缺的。 */
  const buildTeam = run(async () => {
    const backend = state.backends.find((b) => b.installed)?.name;
    if (!backend) return [t("presets.build.nobackend")];
    await xsb.useTeam(pack.id);
    let created = 0;
    for (const { name, role } of pack.roles) {
      if (agentOf(role.name)) continue;
      onAgent(await xsb.putAgent({ id: role.name, name, description: role.description, backend, role: role.name, workspace: "", instructions: "" }));
      created++;
    }
    return [created ? t("presets.build.done", { count: created, backend }) : t("presets.build.complete")];
  });
  const use = run(async () => { await xsb.useTeam(pack.id); return [t("presets.use.done", { title: pack.title, count: pack.roles.length })]; });
  const drop = run(async () => { await xsb.dropTeam(pack.id); return [t("presets.drop.done", { title: pack.title })]; });

  return h("section", {},
    h("h2", {}, pack.title), h("p", { class: "hint" }, pack.description),
    h("div", { class: "card-foot" },
      h("small", {}, pack.used ? t("presets.used") : t("presets.unused")),
      pack.used
        ? h("button", { class: "btn", title: t("presets.drop.title"), onclick: drop }, t("presets.drop"))
        : h("button", { class: "btn", title: t("presets.use.title"), onclick: use }, t("presets.use")),
      h("button", { class: "btn primary", title: t("presets.build.title"), onclick: buildTeam }, t("presets.build"))),
    ...pack.roles.map((entry) => roleCard(pack, entry)));
}

function roleCard(pack, { name, role, missing }) {
  const key = `${pack.id}/${role.name}`;
  const mine = roleOf(role.name);     // 工作区里这个名字的角色：按预设使用的、自己改过的，或与预设无关的同名角色
  // 这个角色要用到、但这台机器上找不到的程序：请用户指出它在哪（应用不安装）
  const requirement = ({ command, install }) => {
    const row = h("div", { class: "notice requirement" });
    const locate = async () => {
      try { if (await xsb.locateProgram(command)) row.remove(); } catch (e) { text.textContent = e.message; }
    };
    const text = h("span", {}, h("div", {}, t("presets.requirement", { command })), h("pre", {}, install));
    row.append(text, h("button", { class: "btn", onclick: locate }, t("common.locate")));
    return row;
  };
  const restore = run(async () => { await xsb.removeRole(role.name); return [t("presets.restored", { name })]; });
  const status =
    !mine ? null :
    !mine.preset ? h("small", {}, t("presets.role.clash")) :
    mine.preset.own ? [h("small", {}, t("presets.role.own")), h("button", { class: "btn", onclick: restore }, t("role.restore"))] :
    [h("small", {}, t("presets.role.asis")), h("button", { class: "btn", title: t("presets.role.edit.title"), onclick: () => editRole(mine) }, t("presets.role.edit"))];

  const server = (s) => h("div", { class: "spec" },
    h("strong", {}, s.name), h("code", {}, [s.command, ...s.args].join(" ")),
    s.env.length > 0 && h("small", {}, t("presets.server.env", { names: s.env.map((e) => (e.value ? e.name : t("presets.server.env.empty", { name: e.name }))).join(t("list.separator")) })));
  // 资产类型给人看的名字：先用这支团队自己的，再用工作区的
  const asset = (type) => pack.assets[type] ?? assetName(type);
  const assets = (types) => types.split(",").map((type) => type.trim()).filter(Boolean).map(asset).join(t("list.separator"));
  const skill = (s) => h("details", { class: "card" },
    h("summary", {}, h("strong", {}, s.name), h("small", {}, t("presets.skill.summary", {
      mode: s.produces ? t("presets.skill.auto", { type: asset(s.produces), from: assets(s.inputs) }) : t("role.skills.demand"),
      description: s.description }))),
    h("div", { class: "md", html: markdownHtml(s.body) }));
  return h("details", { class: "card", open: opened.has(key), ontoggle: (e) => (e.target.open ? opened.add(key) : opened.delete(key)) },
    h("summary", {}, h("strong", {}, name), h("small", {}, role.description)),
    ...missing.map(requirement),
    status && h("div", { class: "card-foot" }, ...[status].flat()),
    role.workspace === "project" && h("p", { class: "hint" }, t("presets.role.project")),
    h("div", { class: "md", html: markdownHtml(role.instructions) }),
    h("h3", {}, t("role.servers.title")),
    ...(role.mcpServers.length ? role.mcpServers.map(server) : [h("p", { class: "hint" }, t("presets.servers.empty"))]),
    h("h3", {}, t("role.skills.title")),
    ...role.skills.map(skill));
}
