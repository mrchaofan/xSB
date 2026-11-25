// 网页批注的编辑界面。它画在宿主页里、叠在 <webview2> 上面，网页碰不到它（主进程见 ../src/page-annotations.ts）。
// 节点由调试器的节点选择选出，主进程只告诉这里：选中的元素在网页视口中的位置（随网页和其中区域的滚动更新）和一个选择序号。
// 这里不认识节点：确认就是把文字交给主进程，嵌进当前选中的那个元素；取消就是放下它。选完一个不退出批注模式。
import { h } from "./dom.js";
import { t } from "./i18n.js";

const targets = new Map();      // pageId -> { seq, rect, label }
let shown;                      // { page, container }

const textarea = h("textarea", { class: "annotate-text", rows: "3", maxlength: "2000", placeholder: t("web.annotate.placeholder"), "aria-label": t("web.annotate.placeholder") });
const label = h("span", { class: "annotate-label" });
const saveButton = h("button", { class: "btn sm primary", onclick: () => save() }, t("web.annotate.save"));
const editor = h("form", { class: "annotate-editor", onsubmit: (e) => { e.preventDefault(); save(); } },
  label, textarea,
  h("div", { class: "annotate-actions" },
    h("button", { type: "button", class: "btn sm", onclick: () => discard() }, t("web.annotate.cancel")), saveButton));
const box = h("div", { class: "annotate-box" });
const hint = h("span", { class: "annotate-hint" });
const clearButton = h("button", { class: "btn sm", onclick: () => op("annotationsClear") });
const bar = h("div", { class: "annotate-bar", role: "toolbar" }, hint, clearButton,
  h("button", { class: "btn sm primary", onclick: () => op("annotate", false) }, t("web.annotate.done")));
const layer = h("div", { class: "annotate-layer" }, box, editor, bar);
let editingSeq = 0, error = "";

// 失败的原因显示在提示条上，下一次成功的操作清掉它。
const settle = (promise) => promise.then(() => { error = ""; render(); }, (e) => { error = e.message; render(); });
const op = (name, arg) => shown && settle(xsb.page(shown.page.id, name, arg));

function save() {
  const text = textarea.value.trim();
  if (!text || !shown) return textarea.focus();
  saveButton.disabled = true;
  settle(xsb.page(shown.page.id, "annotationSave", text).then(() => { textarea.value = ""; })).finally(() => { saveButton.disabled = false; });
}
function discard() { textarea.value = ""; op("annotationDiscard"); }

textarea.onkeydown = (e) => {
  if (e.key === "Escape") { e.preventDefault(); discard(); }
  else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
};
layer.onkeydown = (e) => { if (e.key === "Escape" && e.target !== textarea) op("annotate", false); };

/** 工具栏上的"批注"开关：智能体正在操作、或是弹出的原生网页时不能用。 */
export function annotateButton(button, page) {
  button.setAttribute("aria-pressed", String(!!page.annotating));
  button.disabled = !page.annotating && (!!page.controlling || !!page.nativeView || !!page.error || page.window && button.dataset.panel === "true");
  button.title = t(page.annotating ? "web.annotate.done" : page.nativeView ? "web.annotate.unavailable" : "web.annotate");
  button.onclick = () => xsb.page(page.id, "annotate", !page.annotating).catch((e) => { error = e.message; render(); });
}

/** 在 container 里给 page 叠上批注界面；网页不在批注时撤掉。showWeb 每次显示网页后调用。 */
export function showAnnotations(container, page) {
  if (!page.annotating || page.nativeView || page.error) return clearAnnotations(page.id);
  shown = { page, container };
  layer.dataset.tone = page.annotationTone ?? "default";
  if (layer.parentElement !== container) container.append(layer);
  render();
}

export function clearAnnotations(id) {
  if (id && shown?.page.id !== id) return;
  if (id) targets.delete(id);
  shown = undefined;
  layer.remove();
}

function render() {
  if (!shown) return;
  const { page } = shown;
  const target = targets.get(page.id);
  const count = page.annotations ?? 0;
  hint.textContent = error || t("web.annotate.hint");
  clearButton.textContent = t("web.annotate.clear", { count });
  clearButton.hidden = !count;
  const selected = !!target?.seq;
  editor.hidden = !selected;
  box.hidden = !target?.rect;
  if (!selected) { editingSeq = 0; return; }
  label.textContent = target.label;           // 网页给的名字，只当文字
  if (target.seq !== editingSeq) {            // 新选了一个元素：新的批注
    editingSeq = target.seq;
    textarea.value = "";
    queueMicrotask(() => textarea.focus({ preventScroll: true }));
  }
  const width = layer.clientWidth, height = layer.clientHeight;
  const editorWidth = Math.min(300, width - 16), editorHeight = editor.offsetHeight || 140;
  editor.style.width = `${editorWidth}px`;
  if (!target.rect) {                         // 选中的元素滚出了视野：编辑框停在底部，文字不丢
    editor.style.left = `${Math.max(8, (width - editorWidth) / 2)}px`;
    editor.style.top = `${Math.max(8, height - editorHeight - 8)}px`;
    return;
  }
  const { x, y, width: w, height: hh } = target.rect;
  Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px` });
  const below = y + hh + 8, above = y - editorHeight - 8;
  const top = below + editorHeight <= height - 8 ? below : above >= 8 ? above : Math.max(8, height - editorHeight - 8);
  editor.style.left = `${Math.max(8, Math.min(x, width - editorWidth - 8))}px`;
  editor.style.top = `${top}px`;
}

xsb.on((event) => {
  const target = event.annotationTarget;
  if (!target || typeof target.pageId !== "string") return;
  targets.set(target.pageId, target);
  if (shown?.page.id === target.pageId) render();
});
new ResizeObserver(() => render()).observe(layer);
