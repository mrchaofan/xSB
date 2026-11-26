// 智能体的提问（ask 工具），仿 Codex：问题贴在输入框上方，一题一页（1/3），选项是带编号的竖向列表，按数字键也能选；
// 单选和多选可以带"其他"，在最后一行直接输入。最后一题提交，或者跳过；不回答、直接在输入框发消息，问题也就结束了。
// 回答就是你发给它的下一条消息（中枢 questions.ts）：提交或跳过时把整理好的文字连同 Answer 一起发出。
// 对话里只留一条问答记录。
import { ICON, h } from "./dom.js";
import { t } from "./i18n.js";

const OTHER = "\u0000other";

/** 发给模型的文字：问题和答案逐条列出（界面上由记录显示）。 */
const replyText = (questions, answers) =>
  questions.map((q, n) => `${n + 1}. ${q.question}\n${[answers[n] ?? ""].flat().join("、")}`).join("\n\n");
const shown = (answer) => [answer ?? ""].flat().join("、");

/** 对话里的问答记录：还没结束的由输入框上方的面板显示，这里不画。 */
export function questionRecord(base, entry) {
  if (entry.state === "open") return h("div", { ...base, hidden: true });
  return h("div", { ...base, "data-state": entry.state },
    h("div", { class: "ask-record-head" }, h("span", { class: "ask-record-icon", html: ICON.info }), h("span", {}, t("ask.title")), h("small", {}, t(`ask.state.${entry.state}`))),
    entry.state === "answered" && h("ol", { class: "ask-answers" }, ...entry.questions.map((q, n) =>
      h("li", {}, h("span", {}, q.question), h("strong", {}, shown(entry.answers?.[n]) || t("ask.unanswered"))))));
}

/** 车道里该有的提问面板：最后一个还没结束的提问。面板跨重画保留，选到一半的不丢。 */
export function syncAskPanel(lane, entries, send) {
  const open = entries.findLast((e) => e.kind === "question" && e.state === "open");
  const current = lane.querySelector(".ask-panel");
  if (current?.dataset.question === open?.questionId) return;
  current?.remove();
  if (open) lane.querySelector(".composer").before(askPanel(open, send));
}

function askPanel(entry, send) {
  const { questions } = entry;
  // 每题的答案：单选是一项，多选是一组，"其他"和填空写的文字另存。
  const picked = questions.map((q) => q.kind === "multi" ? (Array.isArray(q.default) ? q.default.filter((v) => q.options.includes(v)) : [])
    : q.kind === "single" && typeof q.default === "string" ? q.options.includes(q.default) ? q.default : q.other ? OTHER : undefined : undefined);
  const written = questions.map((q) => typeof q.default === "string" && (q.kind === "text" || !q.options?.includes(q.default)) ? q.default : "");
  let page = 0, sending = false, error = "";
  const panel = h("div", { class: "ask-panel", "data-question": entry.questionId, role: "group", "aria-label": t("ask.title"), tabindex: "-1" });

  const answerOf = (n) => {
    const q = questions[n];
    if (q.kind === "text") return written[n].trim() || undefined;
    if (q.kind === "single") return picked[n] === OTHER ? written[n].trim() || undefined : picked[n];
    const list = picked[n].map((v) => (v === OTHER ? written[n].trim() : v));
    return list.length && list.every(Boolean) ? list : undefined;
  };
  const isPicked = (n, value) => (questions[n].kind === "multi" ? picked[n].includes(value) : picked[n] === value);
  const choose = (n, value, keep = false) => {
    if (questions[n].kind === "single") picked[n] = value;
    else if (!keep || !isPicked(n, value)) picked[n] = isPicked(n, value) ? picked[n].filter((v) => v !== value) : [...picked[n], value];
    render();
    if (value === OTHER && isPicked(n, OTHER)) panel.querySelector(".ask-other-input")?.focus();
  };
  const reply = async (content, answer) => {
    sending = true;
    error = "";
    render();
    try { await send([{ type: "text", text: content }], answer); }
    catch (e) { sending = false; error = e.message; render(); }
  };
  const next = () => {
    if (answerOf(page) === undefined && !questions[page].optional || sending) return;
    if (page < questions.length - 1) { page++; return render(); }
    const answers = questions.map((_, n) => answerOf(n) ?? null);
    void reply(replyText(questions, answers), { questionId: entry.questionId, answers });
  };
  const typed = (e) => {
    written[page] = e.target.value;
    panel.querySelector(".ask-next").disabled = sending || answerOf(page) === undefined && !questions[page].optional;
  };
  const enter = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); next(); } };

  function render() {
    // 重画后焦点留在面板里，数字键接着能用。
    const focused = panel.contains(document.activeElement) ? document.activeElement.dataset.key ?? "panel" : null;
    const q = questions[page], last = page === questions.length - 1;
    const row = (n, value, body) => h("div", { class: "ask-row", role: q.kind === "multi" ? "menuitemcheckbox" : "menuitemradio", tabindex: "0",
      "aria-checked": String(isPicked(page, value)), "aria-disabled": String(sending), "data-key": String(n),
      onclick: () => !sending && choose(page, value, value === OTHER) },
      h("span", { class: "ask-key" }, String(n)), body,
      q.kind === "multi" && isPicked(page, value) && h("span", { class: "ask-check", html: ICON.check }));
    panel.replaceChildren(
      h("div", { class: "ask-head" },
        h("strong", {}, q.question),
        h("small", {}, [q.kind === "multi" && t("ask.kind.multi"), questions.length > 1 && `${page + 1}/${questions.length}`].filter(Boolean).join(" · "))),
      q.kind === "text"
        ? h("textarea", { class: "ask-text", rows: 2, placeholder: t("ask.placeholder"), disabled: sending, oninput: typed, onkeydown: enter })
        : h("div", { class: "ask-rows", role: "menu" },
            ...q.options.map((o, i) => row(i + 1, o, h("span", { class: "ask-label" }, o, q.optionDescriptions?.[i] && h("small", {}, q.optionDescriptions[i])))),
            q.other && row(q.options.length + 1, OTHER, h("input", { class: "ask-other-input", type: "text", placeholder: t("ask.otherPlaceholder"), disabled: sending,
              oninput: typed, onkeydown: enter, onfocus: () => { if (!isPicked(page, OTHER)) choose(page, OTHER, true); } }))),
      error && h("p", { class: "error", role: "alert" }, error),
      h("div", { class: "ask-foot" },
        h("small", {}, q.kind === "text" ? "" : t("ask.keys")),
        h("button", { class: "btn", type: "button", disabled: sending, onclick: () => reply(t("ask.skipText"), { questionId: entry.questionId, skipped: true }) }, t("ask.skip")),
        page > 0 && h("button", { class: "btn", type: "button", disabled: sending, onclick: () => { page--; render(); } }, t("ask.previous")),
        h("button", { class: "btn primary ask-next", type: "button", disabled: sending || answerOf(page) === undefined && !q.optional, onclick: next }, t(last ? "ask.submit" : "ask.next"))));
    const field = panel.querySelector(".ask-text, .ask-other-input");
    if (field) field.value = written[page];
    if (focused) (panel.querySelector(`[data-key="${focused}"]`) ?? panel).focus();
  }
  // 数字键选第几项（不在输入框里时），回车到下一题。
  panel.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    const q = questions[page], n = Number(e.key);
    if (q.kind !== "text" && n >= 1 && n <= q.options.length + (q.other ? 1 : 0)) { e.preventDefault(); choose(page, n > q.options.length ? OTHER : q.options[n - 1]); }
    else if (e.key === "Enter") { e.preventDefault(); next(); }
  });
  render();
  return panel;
}
