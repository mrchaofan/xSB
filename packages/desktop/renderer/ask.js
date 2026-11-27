// 每个 ACP 表单保留自己的页码与草稿。提交或跳过回到打开它的请求。
import { ICON, h } from "./dom.js";
import { t } from "./i18n.js";

const OTHER = "\u0000other";

const shown = (answer) => [answer ?? ""].flat().join("、");

/** 对话里的问答记录：还没结束的由输入框上方的面板显示，这里不画。 */
export function questionRecord(base, entry) {
  if (entry.state === "open" && entry.answerable) return h("div", { ...base, hidden: true });
  return h("div", { ...base, "data-state": entry.state },
    h("div", { class: "ask-record-head" }, h("span", { class: "ask-record-icon", html: ICON.info }), h("span", {}, t("ask.title")), h("small", {}, t(`ask.state.${entry.state}`))),
    entry.questions.length > 0 && h("ol", { class: "ask-answers" }, ...entry.questions.map((q, n) =>
      h("li", {}, h("span", {}, q.question), entry.state === "answered" && h("strong", {}, shown(entry.answers?.[n]) || t("ask.unanswered"))))));
}

/** 按请求 ID 增删面板，另一个表单打开或关闭时，正在编辑的草稿、焦点和页码都保留。 */
export function syncAskPanel(lane, entries, send) {
  const open = new Map(entries.filter(e => e.kind === "question" && e.state === "open" && e.answerable).map(e => [e.questionId, e]));
  let stack = lane.querySelector(".ask-stack");
  if (!open.size) { stack?.remove(); return; }
  if (!stack) {
    stack = h("div", { class: "ask-stack" });
    lane.querySelector(".composer").before(stack);
  }
  for (const panel of [...stack.children]) {
    if (!open.delete(panel.dataset.question)) panel.remove();
  }
  for (const entry of open.values()) stack.append(askPanel(entry, send));
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
  const reply = async (answer) => {
    sending = true;
    error = "";
    render();
    try { await send(answer); }
    catch (e) { sending = false; error = e.message; render(); }
  };
  const next = () => {
    if (answerOf(page) === undefined && !questions[page].optional || sending) return;
    if (page < questions.length - 1) { page++; return render(); }
    const answers = questions.map((_, n) => answerOf(n) ?? null);
    void reply({ questionId: entry.questionId, answers });
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
        h("small", {}, [entry.delivery === "async" && t("ask.async"), q.kind === "multi" && t("ask.kind.multi"), questions.length > 1 && `${page + 1}/${questions.length}`].filter(Boolean).join(" · "))),
      q.kind === "text"
        ? h("textarea", { class: "ask-text", rows: 2, placeholder: t("ask.placeholder"), disabled: sending, oninput: typed, onkeydown: enter })
        : h("div", { class: "ask-rows", role: "menu" },
            ...q.options.map((o, i) => row(i + 1, o, h("span", { class: "ask-label" }, o, q.optionDescriptions?.[i] && h("small", {}, q.optionDescriptions[i])))),
            q.other && row(q.options.length + 1, OTHER, h("input", { class: "ask-other-input", type: "text", placeholder: t("ask.otherPlaceholder"), disabled: sending,
              oninput: typed, onkeydown: enter, onfocus: () => { if (!isPicked(page, OTHER)) choose(page, OTHER, true); } }))),
      error && h("p", { class: "error", role: "alert" }, error),
      h("div", { class: "ask-foot" },
        h("small", {}, q.kind === "text" ? "" : t("ask.keys")),
        h("button", { class: "btn", type: "button", disabled: sending, onclick: () => reply({ questionId: entry.questionId, skipped: true }) }, t("ask.skip")),
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
