// Agent 的创建、编辑、删除，以及它与角色页共用的两个对话框：重启确认、系统说明预览。
import { OVER, STATE_TEXT, TASK_TEXT, agentOf, focusLane, nameOf, onAgent, roleOf, roleTitle, state } from "./app.js";
import { fill, h } from "./dom.js";
import { confirmDialog, field, input, openDialog, select } from "./form.js";
import { t } from "./i18n.js";

/** 重启后端进程会让正在进行的那一轮失败，所以先看状态再问。agents 都空闲时直接通过。 */
export async function confirmRestart(agents, action) {
  const busy = agents.filter((a) => a.state !== "idle");
  if (!busy.length) return true;
  return confirmDialog(t("restart.title", { action }), [
    h("p", {}, t("restart.body", { action })),
    h("ul", {}, ...busy.map((a) => h("li", {}, t("restart.item", { name: a.name, state: STATE_TEXT[a.state] })))),
  ], t("restart.confirm"));
}

/** 模型实际看到的系统说明全文，用来调试角色行为。 */
export function previewPrompt(agents) {
  const body = h("pre", { class: "prompt" });
  const show = async (agentId) => { body.textContent = (await xsb.inspectAgent(agentId)).systemPrompt; };
  const pick = h("select", { onchange: (e) => show(e.target.value) }, ...agents.map((a) => h("option", { value: a.id }, a.name)));
  openDialog(t("prompt.title"), [
    agents.length > 1 && field(t("prompt.pick"), pick),
    h("p", { class: "hint" }, t("prompt.hint")),
    body,
  ], [{ label: t("common.close"), primary: true }]);
  show(agents[0].id);
}

const ID_HINT = t("common.id.hint");
const RESTARTS = t("agent.restarts");

/** agent 为空 = 新建。补充说明不在 Agent 的状态里，打开编辑时才取。 */
export async function editAgent(agent) {
  const creating = !agent;
  const draft = creating
    ? { id: "", name: "", description: "", role: "", backend: state.backends.find((b) => b.installed)?.name ?? "", workspace: "", instructions: "" }
    : { id: agent.id, name: agent.name, description: agent.description, role: agent.role ?? "", backend: agent.backend, workspace: agent.workspace, instructions: (await xsb.inspectAgent(agent.id)).instructions };
  const edited = new Set();             // 用户亲手改过的字段，选角色时不覆盖
  const fields = h("div", { class: "fields" });
  const idHint = h("small", {}, ID_HINT);
  const error = h("p", { class: "error", role: "alert" });

  const idError = () =>
    !draft.id ? t("agent.id.missing") :
    agentOf(draft.id) ? t("agent.id.taken", { agent: draft.id }) : "";

  // 选定角色：把它的描述和默认后端填进还没动过的字段
  const pickRole = () => {
    const role = roleOf(draft.role);
    if (creating && role) for (const key of ["description", "backend"]) if (!edited.has(key) && role[key]) draft[key] = role[key];
    render();
  };

  // 应用不安装任何东西：程序不在 PATH 上时，请用户指出它在哪。
  const locate = async (b, status) => {
    try {
      if (!await xsb.locateProgram(b.missing)) return;
      state.backends = await xsb.backends();
      if (!edited.has("backend")) draft.backend = b.name;
      render();
    } catch (e) {
      status.textContent = e.message;
    }
  };
  const backends = () => h("div", { class: "choices" }, ...state.backends.map((b) => {
    // 后端就叫它自己的名字。启动命令只在它说明了名字说明不了的东西时才显示：用户自己登记的后端。
    const named = b.command.split(" ")[0].startsWith(b.name);
    const status = h("small", {}, b.installed ? (named ? "" : b.command) : t("backend.missing", { command: b.missing ?? b.command.split(" ")[0] }));
    return h("label", { class: "choice" },
      h("input", { type: "radio", name: "backend", checked: draft.backend === b.name, disabled: !b.installed,
        onchange: () => { draft.backend = b.name; edited.add("backend"); } }),
      h("strong", {}, b.name), status,
      b.missing && h("button", { class: "btn", type: "button", onclick: (e) => { e.preventDefault(); locate(b, status); } }, t("common.locate")));
  }));

  const render = () => fill(fields,
    field(t("agent.role"), select(draft, "role", [["", t("agent.role.none")], ...state.roles.map((r) => [r.name, roleTitle(r)])], pickRole),
      creating ? t("agent.role.hint") : RESTARTS),
    creating && field(t("agent.id"), input(draft, "id", { placeholder: "gaffer1", oninput: () => { idHint.textContent = (draft.id && idError()) || ID_HINT; } }), idHint),
    field(t("agent.name"), input(draft, "name", { placeholder: t("agent.name.placeholder") })),
    field(t("agent.description"), input(draft, "description", { rows: 2, oninput: () => edited.add("description") }),
      creating ? t("agent.description.hint") : t("agent.description.hint") + t("sentence.gap") + t("agent.description.effect")),
    field(t("agent.backend"), backends(), !creating && RESTARTS),
    field(t("agent.instructions"), input(draft, "instructions", { rows: 4, placeholder: t("agent.instructions.placeholder") }), !creating && t("agent.instructions.effect")),
    h("details", {}, h("summary", {}, t("agent.advanced")),
      field(t("agent.workspace"), input(draft, "workspace", { placeholder: t("agent.workspace.placeholder") }), !creating && RESTARTS)),
  );

  const save = async () => {
    error.textContent = (creating && idError())
      || (!draft.name.trim() && t("agent.name.missing"))
      || (!state.backends.find((b) => b.name === draft.backend)?.installed && t("agent.backend.missing"))
      || "";
    if (error.textContent) return false;
    const restarts = !creating && ["role", "backend", "workspace"].some((key) => draft[key] !== (agent[key] ?? ""));
    if (restarts && !await confirmRestart([agent], t("restart.action.edit"))) return false;
    onAgent(await xsb.putAgent(draft));
    if (creating) focusLane(draft.id);
  };

  const remove = async () => {
    const pending = state.tasks.filter((task) => task.to.agentId === agent.id && !OVER.includes(task.status));
    const sure = await confirmDialog(t("agent.delete.title", { name: agent.name }), [
      agent.state !== "idle" && h("p", {}, t("agent.delete.busy", { name: agent.name, state: agent.state })),
      pending.length > 0 && h("p", {}, t("agent.delete.pending", { count: pending.length })),
      pending.length > 0 && h("ul", {}, ...pending.map((task) => h("li", {}, t("agent.delete.task", { title: task.title, from: nameOf(task.from.agentId), status: TASK_TEXT[task.status] })))),
      h("p", {}, t("agent.delete.kept", { agent: agent.id })),
    ], t("agent.delete"));
    if (!sure) return false;
    await xsb.removeAgent(agent.id);
  };

  render();
  openDialog(creating ? t("agent.new.title") : t("agent.edit.title", { name: agent.name, agent: agent.id }), [fields, error], creating
    ? [{ label: t("common.cancel") }, { label: t("agent.create"), primary: true, run: save }]
    : [{ label: t("agent.delete"), side: true, run: remove },
       { label: t("prompt.preview"), run: () => { previewPrompt([agent]); return false; } },
       { label: t("common.cancel") }, { label: t("common.save"), primary: true, run: save }]);
}
