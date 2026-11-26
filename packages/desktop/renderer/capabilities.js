import { fill, h } from "./dom.js";
import { t } from "./i18n.js";

/** Suggestions edit a draft; execution stays behind Send. */
export function composerCapabilities(agentId, editor, changed) {
  let latest = {}, signature;
  const suggestions = h("div", { class: "prompt-suggestions", "aria-label": t("composer.suggestions") });
  const el = h("div", { class: "composer-capabilities" }, suggestions);
  function draw() {
    const empty = !editor.read().length;
    const next = JSON.stringify([latest.suggestions, empty]);
    if (next === signature) return;
    signature = next;
    const prompts = empty ? latest.suggestions ?? [] : [];
    fill(suggestions, ...prompts.map(s => h("button", { class: "btn sm", type: "button", onclick: () => { editor.insert(s.prompt); changed(); } },
      s.prompt.map(b => b.type === "text" ? b.text : b.name ?? b.uri).join(" "))));
    el.hidden = !prompts.length;
  }
  return { el, refresh: draw, update(value) { latest = value; draw(); } };
}
