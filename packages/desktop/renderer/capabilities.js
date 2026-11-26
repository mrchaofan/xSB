import { fill, h } from "./dom.js";
import { t } from "./i18n.js";

/** Commands and suggestions edit a draft; execution stays behind Send. */
export function composerCapabilities(agentId, editor, changed) {
  let latest = {}, signature;
  const commands = h("select", { class: "native-commands", "aria-label": t("composer.commands") });
  const suggestions = h("div", { class: "prompt-suggestions", "aria-label": t("composer.suggestions") });
  const el = h("div", { class: "composer-capabilities" }, commands, suggestions);
  commands.onchange = () => {
    if (commands.value === "") return;
    const command = latest.commands?.[Number(commands.value)];
    if (!command) return;
    const prior = editor.snapshot();
    if (command.type === "skill") {
      editor.restore([{ type: "skill", name: command.name }, ...prior.filter(b => latest.skill?.inline || b.type !== "skill")]);
    } else editor.restore([{ type: "text", text: `/${command.name} ` }, ...prior]);
    commands.value = "";
    editor.el.focus(); changed();
  };
  function draw() {
    const empty = !editor.read().length;
    const next = JSON.stringify([latest.commands, latest.suggestions, latest.skill, empty]);
    if (next === signature) return;
    signature = next;
    const list = latest.commands ?? [];
    commands.hidden = !list.length;
    fill(commands, h("option", { value: "" }, t("composer.commands")), ...list.map((c, i) => h("option", { value: String(i), title: c.description }, c.type === "skill" ? t("composer.skillName", { name: c.name }) : `/${c.name}`)));
    const prompts = empty ? latest.suggestions ?? [] : [];
    fill(suggestions, ...prompts.map(s => h("button", { class: "btn sm", type: "button", onclick: () => { editor.insert(s.prompt); changed(); } },
      s.prompt.map(b => b.type === "text" ? b.text : b.name ?? b.uri).join(" "))));
    el.hidden = !list.length && !prompts.length;
  }
  return { el, refresh: draw, update(value) { latest = value; draw(); } };
}
