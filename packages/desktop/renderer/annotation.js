import "./preferences.js";
// 批注的编辑框（annotation.html）。它是盖在网页上的一个视图，网页碰不到它（../src/page-host.ts）。
// 用户在网页里选中一个元素，主进程就把它摆到元素旁边、交给它键盘焦点，并告诉它选中的是什么（annotationEditor）。
// 这里不认识节点：确认就是把文字交给主进程，嵌进当前选中的那个元素；取消就是放下它。选完一个不退出批注模式。
import { h } from "./dom.js";
import { t } from "./i18n.js";

const textarea = h("textarea", { class: "annotate-text", maxlength: "2000", placeholder: t("web.annotate.placeholder"), "aria-label": t("web.annotate.placeholder") });
const label = h("span", { class: "annotate-label" });
const failure = h("span", { class: "annotate-error", role: "alert" });
const saveButton = h("button", { class: "btn sm primary" }, t("web.annotate.save"));
const editor = h("form", { class: "annotate-editor", onsubmit: (e) => { e.preventDefault(); save(); } },
  label, textarea,
  h("div", { class: "annotate-actions" }, failure,
    h("button", { type: "button", class: "btn sm", onclick: () => discard() }, t("web.annotate.cancel")), saveButton));
document.body.append(editor);

let target;     // { pageId, seq, label, tone }

const settle = (promise) => promise.then(() => { failure.textContent = ""; }, (e) => { failure.textContent = e.message; });

function save() {
  const text = textarea.value.trim();
  if (!text || !target) return textarea.focus();
  saveButton.disabled = true;
  settle(xsb.page(target.pageId, "annotationSave", text).then(() => { textarea.value = ""; })).finally(() => { saveButton.disabled = false; });
}
function discard() {
  textarea.value = "";
  if (target) settle(xsb.page(target.pageId, "annotationDiscard"));
}

textarea.onkeydown = (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Escape") { e.preventDefault(); discard(); }
  else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
};

xsb.on((event) => {
  const next = event.annotationEditor;
  if (!next) return;
  // 新选了一个元素：新的批注
  if (next.pageId !== target?.pageId || next.seq !== target?.seq) {
    textarea.value = "";
    failure.textContent = "";
  }
  target = next;
  document.documentElement.dataset.tone = next.tone;
  label.textContent = next.label;           // 网页给的名字，只当文字
  textarea.focus({ preventScroll: true });
});
