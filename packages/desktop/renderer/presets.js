// 预设团队：应用自带的几支团队（软件开发、电影制作），以及用户自己放在 ~/.xsb/presets 里的团队，两处的组织一样。
// 工作区"使用"一支团队，就有了它的全部角色。首次使用会复制模板；副本只在用户确认同步后更新。
// 在工作区里改过的角色才是工作区自己的，可以随时恢复成预设。一支团队可以基于另一支（extends），只放不同的部分。
import { assetName, roleOf, showPage, state } from "./app.js";
import { markdownHtml } from "./content.js";
import { avatarImage } from "./avatars.js";
import { fill, h } from "./dom.js";
import { field, input, openDialog } from "./form.js";
import { language, t } from "./i18n.js";
import { editRole, halted, pageHead } from "./team.js";

const body = h("div", { class: "page-body" });
const opened = new Set();         // 展开着的角色：页面重画后保持展开
let notice = [];                  // 上一次操作的结果，一行一条

export async function showPresets() {
  const category = state.settings;
  const page = state.page;
  const { teams: packs, problems } = await xsb.presets();
  if (state.settings !== category || state.page !== page) return;
  const top = body.scrollTop;
  showPage("presets", pageHead(t("presets.title"), t("presets.hint")), body);
  fill(body,
    notice.length > 0 && h("div", { class: "notice", role: "status" }, h("span", {}, ...notice.map((line) => h("div", {}, line)))),
    h("div", { class: "card-foot" },
      h("small", {}, t("presets.mine.hint")),
      h("button", { class: "btn", onclick: () => xsb.openFolder() }, t("presets.mine.open"))),
    problems.length > 0 && problemList(problems),
    ...packs.map(packSection));
  body.scrollTop = top;
}

/** 做一件事，把结果写在页面顶部，然后按最新的状态重画。 */
const run = (work) => async () => {
  try { notice = await work(); } catch (e) { notice = [e.message]; }
  await showPresets();
};

/** 预设里有问题的地方：错误的那支团队或角色不会被使用，提醒只是提醒。 */
function problemList(problems) {
  return h("div", { class: "notice problems" }, h("span", {},
    ...problems.map((p) => h("div", { "data-severity": p.severity },
      t(p.severity === "error" ? "presets.problem.error" : "presets.problem.warning"), " ", p.detail, " ", h("code", {}, p.path)))));
}

/** 从这支团队派生一支自己的：放在 ~/.xsb/presets 里，只写不同的部分。 */
function derive(pack) {
  const draft = { id: "" };
  openDialog(t("presets.derive.title", { title: pack.title }), [
    h("p", { class: "hint" }, t("presets.derive.hint")),
    field(t("presets.derive.id"), input(draft, "id", { placeholder: `${pack.id}-mine` })),
  ], [
    { label: t("common.cancel") },
    { label: t("presets.derive.confirm"), primary: true, run: async () => {
      const dir = await xsb.deriveTeam(draft.id.trim(), pack.id);
      notice = [t("presets.derive.done", { id: draft.id.trim() })];
      await xsb.openFolder(dir);
      await showPresets();
    } },
  ]);
}

/** Preview first, then explicitly acknowledge losing custom changes. */
async function synchronize(pack) {
  try {
    const plan = await xsb.previewTeamSync(pack.id);
    openDialog(t("presets.sync.title", { title: pack.title }), [
      h("p", { class: "notice" }, t("presets.sync.risk")),
      h("p", {}, t("presets.sync.roles", { roles: plan.roles.join(t("list.separator")) })),
      plan.overwritten.length > 0 && h("p", {}, t("presets.sync.overrides", { roles: plan.overwritten.join(t("list.separator")) })),
      plan.removed.length > 0 && h("p", {}, t("presets.sync.removed", { roles: plan.removed.join(t("list.separator")) })),
    ].filter(Boolean), [
      { label: t("common.cancel") },
      { label: t("presets.sync.confirm"), primary: true, run: async () => {
        await xsb.syncTeam(pack.id, plan.revision);
        notice = [t("presets.sync.done", { title: pack.title })];
        await showPresets();
      } },
    ]);
  } catch (e) { notice = [e.message]; await showPresets(); }
}

function packSection(pack) {
  /** 使用这支团队，并给还没有 Agent 的角色各建一个（id 用角色名）。可以重复执行：只补缺的。 */
  const buildTeam = run(async () => {
    const backend = state.backends.find((b) => b.installed)?.name;
    if (!backend) return [t("presets.build.nobackend")];
    const built = await xsb.buildTeam(pack.id, backend);       // 角色和新建的智能体随事件到达
    return [halted(built) ?? (built.done.length ? t("presets.build.done", { count: built.done.length, backend }) : t("presets.build.complete"))];
  });
  const use = run(async () => { await xsb.useTeam(pack.id); return [t("presets.use.done", { title: pack.title, count: pack.roles.length })]; });
  const drop = run(async () => { await xsb.dropTeam(pack.id); return [t("presets.drop.done", { title: pack.title })]; });

  const errors = pack.problems.filter((p) => p.severity === "error");
  return h("section", {},
    h("h2", {}, pack.title, " ", h("small", { class: "tag" }, t(pack.source === "user" ? "presets.source.user" : "presets.source.builtin"))),
    h("p", { class: "hint" }, pack.description),
    pack.extends && h("p", { class: "hint" }, t("presets.extends", { base: pack.extends })),
    pack.language !== language && pack.source === "user" && h("p", { class: "hint" }, t("presets.language", { language: pack.language })),
    pack.programs.length > 0 && h("p", { class: "hint" }, t("presets.programs", { programs: pack.programs.join(t("list.separator")) })),
    pack.problems.length > 0 && problemList(pack.problems),
    h("div", { class: "card-foot" },
      h("small", {}, pack.used ? t("presets.used") : t("presets.unused")),
      pack.used
        ? h("button", { class: "btn", title: t("presets.drop.title"), onclick: drop }, t("presets.drop"))
        : h("button", { class: "btn", title: t("presets.use.title"), onclick: use }, t("presets.use")),
      h("button", { class: "btn primary", title: t("presets.build.title"), onclick: buildTeam, disabled: errors.length > 0 }, t("presets.build")),
      pack.used && h("button", { class: "btn", disabled: pack.syncAvailable === false, onclick: () => synchronize(pack) }, t("presets.sync")),
      h("button", { class: "btn", title: t("presets.derive.hint"), onclick: () => derive(pack) }, t("presets.derive")),
      pack.source === "user" && (!pack.snapshot || pack.sourceDir) && h("button", { class: "btn", onclick: () => xsb.openFolder(pack.sourceDir ?? pack.dir) }, t("presets.open"))),
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
    h("summary", { class: "preset-role-summary" }, avatarImage(role), h("strong", {}, name), h("small", {}, role.description)),
    ...missing.map(requirement),
    status && h("div", { class: "card-foot" }, ...[status].flat()),
    h("div", { class: "md", html: markdownHtml(role.instructions) }),
    h("h3", {}, t("role.servers.title")),
    ...(role.mcpServers.length ? role.mcpServers.map(server) : [h("p", { class: "hint" }, t("presets.servers.empty"))]),
    h("h3", {}, t("role.skills.title")),
    ...role.skills.map(skill));
}
