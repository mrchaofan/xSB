import { t } from "./i18n.js";

/** Suggestions edit a draft; execution stays behind Send. */
export function composerCapabilities(editor) {
  let latest = {}, fallback = "";
  function draw(placeholder = fallback) {
    fallback = placeholder;
    const suggestion = !editor.isReading() && !editor.snapshot().length
      ? latest.suggestions?.find(s => s.prompt.length) : undefined;
    const prompt = suggestion?.prompt.map(b => b.type === "text" ? b.text : b.name ?? b.uri).join(" ");
    editor.setPlaceholder(prompt ? t("composer.suggestionPlaceholder", { prompt }) : fallback, prompt ? suggestion.prompt : []);
  }
  return { refresh: draw, update(value) { latest = value; draw(); } };
}
