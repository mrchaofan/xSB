// 内容（../src/content.ts：一组有序的 ACP 内容块）在界面上的投影：
//   剪贴板 → 内容      fromClipboard
//   内容 ⇄ 输入框      createEditor 的 insert 和 read
//   内容 → 对话        contentView
import DOMPurify from "dompurify";
import { marked } from "marked";
import { append } from "../src/content.ts";
import { fromClipboard } from "./clipboard.js";
import { openDialog } from "./form.js";
import { ICON, fill, h } from "./dom.js";
import { t } from "./i18n.js";
import { annotationImage, expandAnnotation } from "./web-annotation.js";
export { fromClipboard } from "./clipboard.js";

// 模型和其他 Agent 写的内容不可信。脚本由 DOMPurify 去掉；外链图片也去掉，否则一张图片的地址就能把对话内容带出去。
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "IMG" && !node.getAttribute("src")?.startsWith("data:image/")) node.remove();
});
DOMPurify.addHook("beforeSanitizeAttributes", (node) => {
  // 本地地址不交给浏览器导航；保留给点击处理器，再由主进程解析。
  if (node.tagName === "A" && /^(file:|xsb-artifact:)/i.test(node.getAttribute("href") ?? "")) {
    node.setAttribute("data-file-href", node.getAttribute("href"));
    node.setAttribute("href", "#");
  }
});

/** markdown 文本 → 可以放进页面的 HTML。单个换行就是换行，和聊天里打字的习惯一致。 */
export const markdownHtml = (text) => DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }));

/** 复制源码而非按钮文字或渲染后的排版；失败时在按钮上反馈，允许重试。 */
function copyButton(text, label, className = "") {
  const button = h("button", { type: "button", class: `icon-btn copy ${className}`, title: t(label), "aria-label": t(label), html: ICON.copy });
  let timer;
  button.onclick = async () => {
    try {
      await xsb.copyText(text);
      button.innerHTML = ICON.check;
      button.title = t("content.copied");
    } catch {
      button.title = t("content.copyFailed");
    }
    button.setAttribute("aria-label", button.title);
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.innerHTML = ICON.copy;
      button.title = t(label);
      button.setAttribute("aria-label", button.title);
    }, 2000);
  };
  return button;
}

/** 对话和文档共用：链接交给侧栏，代码块有独立复制按钮。 */
export function markdownView(text, openLink, className = "md") {
  const el = h("div", { class: className, html: markdownHtml(text) });
  const followLink = (container) => (event) => {
    const link = event.target.closest("a");
    if (!link || !container.contains(link)) return;
    const href = link.dataset.fileHref ?? link.getAttribute("href");
    if (!href) return;
    if (href.startsWith("#")) {
      event.preventDefault();
      [...container.querySelectorAll("[id]")].find((node) => node.id === href.slice(1))?.scrollIntoView({ block: "nearest" });
      return;
    }
    event.preventDefault();
    openLink?.(href, container);
  };
  el.onclick = followLink(el);
  el.querySelectorAll("table").forEach((table) => {
    const expand = h("button", { class: "icon-btn", title: t("content.tableExpand"), "aria-label": t("content.tableExpand"), html: ICON.expand, onclick: () => {
      const view = h("div", { class: "md table-expanded" }, table.cloneNode(true));
      view.onclick = followLink(view);
      const dialog = openDialog(t("content.table"), [view], [{ label: t("common.close") }]);
      dialog.classList.add("table-dialog");
    } });
    const wrapper = h("div", { class: "table-block" }, h("div", { class: "table-toolbar" }, h("span", {}, t("content.table")), expand));
    table.replaceWith(wrapper);
    wrapper.append(h("div", { class: "table-scroll" }, table));
  });
  el.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement;
    const toolbar = h("div", { class: "code-toolbar" },
      h("span", {}, [...code.classList].find((c) => c.startsWith("language-"))?.slice(9) ?? ""),
      copyButton(code.textContent, "content.copyCode"));
    const wrapper = h("div", { class: "code-block" }, toolbar);
    pre.replaceWith(wrapper);
    wrapper.append(pre);
  });
  return el;
}

/** 文本以外的一块：图片显示本身，文件显示名字，不认识的类型显示类型名。 */
function partNode(block) {
  if (block.type === "web_annotation") {
    const image = annotationImage(block), note = String(block.note ?? "");
    return h("span", { class: "part chip web-annotation", title: `${block.label ?? ""}\n${block.url ?? ""}\n\n${note}` },
      image ? h("img", { src: `data:image/png;base64,${image.data}`, alt: "" }) : h("span", { html: ICON.file }),
      h("span", { class: "web-annotation-text" }, t("composer.annotation", { index: block.index, note: note.length > 40 ? `${note.slice(0, 40)}…` : note })));
  }
  if (block.type === "image") return h("img", { class: "part", src: block.url || `data:${block.mimeType};base64,${block.data}`, loading: "lazy", decoding: "async", alt: t("content.image.alt") });
  if (block.type === "asset_reference") return h("span", { class: "part chip asset-ref", title: block.name + " · " + block.version, html: ICON.file }, block.name + " · " + block.version);
  return h("span", { class: "part chip", title: block.uri, html: ICON.file }, block.type === "resource_link" ? block.name : block.type);
}

/** 内容 → 对话里的样子：文本按 markdown 渲染，其余各占一块。 */
export function contentView(content, openLink, { streaming = false, lookupAsset } = {}) {
  const parts = lookupAsset ? content.flatMap(block => {
    if (block.type !== "text") return [block];
    const parts = [];
    let offset = 0;
    for (const match of block.text.matchAll(/<asset>(.*?)<\/asset>/gs)) {
      let ref;
      try { ref = JSON.parse(match[1]); } catch { continue; }
      if (typeof ref?.name !== "string" || !/^v[1-9]\d*$/.test(ref?.version)) continue;
      if (offset < match.index) parts.push({ type: "text", text: block.text.slice(offset, match.index) });
      parts.push({ type: "asset_reference", name: ref.name, version: ref.version });
      offset = match.index + match[0].length;
    }
    if (offset === 0) return [block];
    if (offset < block.text.length) parts.push({ type: "text", text: block.text.slice(offset) });
    return parts;
  }) : content;
  const el = h("div", { class: "content" }, ...parts.map((block) => {
    if (block.type === "asset_reference") {
      const preview = lookupAsset?.(block);
      return h(preview ? "button" : "span", { class: "part chip", html: ICON.file, onclick: preview }, block.name + " · " + block.version);
    }
    if (block.type === "text") return markdownView(block.text, openLink);
    if (block.type === "resource_link") return h("button", { type: "button", class: "part chip", title: block.uri, html: ICON.file, onclick: () => openLink?.(block.uri, el) }, block.name);
    return partNode(block);
  }));
  if (!streaming && content.some((block) => block.type === "text")) el.append(h("div", { class: "content-actions" },
    copyButton(content.map((block) => block.type === "text" ? block.text : block.uri ?? "").filter(Boolean).join("\n\n"), "content.copyMessage")));
  return el;
}

/**
 * 输入框：内容的编辑形态。文本就是文本（markdown 源码），其余的块是一个不可编辑的小方块，
 * 可以像一个字符那样被光标越过和删除。onEnter() 在按下回车时调用；⇧↩ 换行。
 * onChange 在内容变了之后调用：输入、粘贴、清空。
 */
/**
 * 输入框。网页批注（web-annotation.js）不进文字里，放在输入框上方的附件栏：每条都是确认时的完整快照，
 * 发送时接在用户的文字后面一起发出。onAnnotationsRemoved：用户从附件栏删掉了批注（网页里的那条随之撤下）。
 */
export function createEditor(onEnter, onChange = () => {}, onAnnotationsRemoved = () => {}) {
  const el = h("div", { class: "editor", contenteditable: "plaintext-only", role: "textbox", "aria-multiline": "true" });
  const error = h("div", { class: "content-error", role: "status", hidden: true });
  let pending = Promise.resolve();
  let reading = 0;
  const blocks = new WeakMap();      // 小方块的节点 → 它代表的块
  const isNote = (block) => block.type === "web_annotation";
  let notes = [];
  const tray = h("div", { class: "annotation-tray", hidden: true });
  function renderTray() {
    tray.hidden = !notes.length;
    fill(tray, ...notes.map((block) => {
      const card = partNode(block);
      card.append(h("button", { class: "remove-ref", type: "button", "aria-label": t("composer.remove"), title: t("composer.remove"), html: ICON.close,
        onclick: () => { notes = notes.filter((b) => b !== block); renderTray(); onAnnotationsRemoved([block]); onChange(); } }));
      return card;
    }));
  }
  /** 批注进附件栏；同一条（同一个 id）不会出现两次。 */
  function attach(content) {
    const added = content.filter((b) => isNote(b) && !notes.some((n) => n.id && n.id === b.id));
    if (added.length) { notes = [...notes, ...added]; renderTray(); }
    return content.filter((b) => !isNote(b));
  }

  let caret;
  el.addEventListener("focusout", () => {
    const selection = getSelection();
    if (selection.rangeCount && el.contains(selection.anchorNode)) caret = selection.getRangeAt(0).cloneRange();
  });
  function token(block) {
    const node = partNode(block);
    node.contentEditable = "false";
    blocks.set(node, block);
    if (block.type === "asset_reference" || block.type === "resource_link") node.append(h("button", { class: "remove-ref", tabindex: "-1", type: "button", "aria-label": t("composer.remove"), title: t("composer.remove"), html: ICON.close, onclick: () => { node.remove(); el.focus(); onChange(); } }));
    return node;
  }

  /** 内容 → 输入框：插到光标处。 */
  function insert(content, background = false) {
    const before = notes.length;
    content = attach(content);
    if (!content.length) { if (notes.length !== before) onChange(); return; }
    // 图片读取可能晚于对话切换；离开后只更新原对话草稿。
    if (!el.isConnected || (background && document.activeElement !== el)) {
      restore([...read(false), ...content]);
      onChange();
      return;
    }
    const focused = document.activeElement === el;
    const previous = !focused && caret && el.contains(caret.commonAncestorContainer) ? caret : null;
    el.focus();
    const selection = getSelection();
    let range = previous ?? (focused && selection.rangeCount ? selection.getRangeAt(0) : null);
    if (!range || !el.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    range.deleteContents();
    for (const block of content) {
      const node = block.type === "text" ? document.createTextNode(block.text) : token(block);
      range.insertNode(node);
      range.setStartAfter(node);
    }
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    caret = range.cloneRange();
    onChange();
  }

  /** 输入框 → 内容：按节点顺序读出，首尾的空白不算。 */
  function read(trim = true) {
    const content = readText(trim);
    // 批注接在用户的文字之后；发送时展开成文字和截图。
    return trim ? [...content, ...notes.flatMap(expandAnnotation)] : [...content, ...notes];
  }

  function readText(trim) {
    let content = [];
    const addText = text => { if (text) content = append(content, { type: "text", text }); };
    function walk(parent) {
      for (const node of parent.childNodes) {
        const block = blocks.get(node);
        if (block) content = append(content, block);
        else if (node.nodeType === Node.TEXT_NODE) addText(node.textContent);
        else if (node.nodeName === "BR") { if (parent.childNodes.length > 1) addText("\n"); }
        else {
          if (node.previousSibling && /^(DIV|P)$/.test(node.nodeName)) addText("\n");
          walk(node);
        }
      }
    }
    walk(el);
    if (!trim) return content;
    const trimmed = content.map((block, i) => (block.type !== "text" ? block
      : { ...block, text: block.text.slice(i === 0 ? block.text.search(/\S|$/) : 0).replace(i === content.length - 1 ? /\s+$/ : /$^/, "") }));
    return trimmed.filter(block => block.type !== "text" || block.text).flatMap(block => block.type === "asset_reference"
      ? [{ type: "text", text: "<asset>" + JSON.stringify({ name: block.name, version: block.version }) + "</asset>" }]
      : [block]);
  }

  const take = (data, native = false) => {
    error.hidden = true;
    reading++;
    onChange();
    // Start reading immediately, then insert in paste order even if image decoding finishes out of order.
    const content = fromClipboard(data, native);
    content.catch(() => {});
    pending = pending.catch(() => {}).then(() => content).then(blocks => insert(blocks, true)).catch((e) => {
      error.textContent = t("content.pasteFailed", { error: e.message });
      error.hidden = false;
      throw e;
    }).finally(() => { reading--; onChange(); });
    pending.catch(() => {});
  };
  el.onpaste = (e) => { e.preventDefault(); take(e.clipboardData, true); };
  el.ondragover = (e) => e.preventDefault();
  el.ondrop = (e) => { e.preventDefault(); take(e.dataTransfer); };
  el.onkeydown = (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    if (e.shiftKey) insert([{ type: "text", text: "\n" }]);
    else onEnter();
  };
  // 删空之后浏览器会留下一个换行，清掉它，占位文字才会回来
  el.oninput = () => { error.hidden = true; if (!reading) pending = pending.catch(() => {}); if (!readText(false).length) el.replaceChildren(); onChange(); };

  // 恢复草稿不抢焦点；附件重新关联到 WeakMap，仍可正常编辑和发送。
  function restore(content) {
    caret = null;
    notes = [];
    content = attach(content);
    renderTray();
    el.replaceChildren(...content.map((block) => {
      if (block.type === "text") return document.createTextNode(block.text);
      return token(block);
    }));
  }

  async function ready() {
    let task;
    do { task = pending; await task; } while (task !== pending);
  }

  /** 网页那边撤下了这些批注（清除批注）：附件栏跟着去掉。 */
  function removeAnnotations(ids) {
    const left = notes.filter((n) => !ids.includes(n.id));
    if (left.length === notes.length) return;
    notes = left;
    renderTray();
    onChange();
  }

  return { el, error, tray, isReading: () => reading > 0, ready, insert, read, snapshot: () => read(false), restore, removeAnnotations,
    clear: () => { el.replaceChildren(); notes = []; renderTray(); onChange(); } };
}
