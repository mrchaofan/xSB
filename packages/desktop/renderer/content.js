// 内容（../src/content.ts：一组有序的 ACP 内容块）在界面上的投影：
//   剪贴板 → 内容      fromClipboard
//   内容 ⇄ 输入框      createEditor 的 insert 和 read
//   内容 → 对话        contentView
import DOMPurify from "dompurify";
import { marked } from "marked";
import { append } from "../src/content.ts";
import { ICON, h } from "./dom.js";
import { t } from "./i18n.js";

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
  el.onclick = (event) => {
    const link = event.target.closest("a");
    if (!link || !el.contains(link)) return;
    const href = link.dataset.fileHref ?? link.getAttribute("href");
    if (!href) return;
    if (href.startsWith("#")) {
      event.preventDefault();
      [...el.querySelectorAll("[id]")].find((node) => node.id === href.slice(1))?.scrollIntoView({ block: "nearest" });
      return;
    }
    event.preventDefault();
    openLink?.(href, el);
  };
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
  if (block.type === "image") return h("img", { class: "part", src: `data:${block.mimeType};base64,${block.data}`, alt: t("content.image.alt") });
  return h("span", { class: "part chip", title: block.uri, html: ICON.file }, block.type === "resource_link" ? block.name : block.type);
}

/** 内容 → 对话里的样子：文本按 markdown 渲染，其余各占一块。 */
export function contentView(content, openLink, { streaming = false } = {}) {
  const el = h("div", { class: "content" }, ...content.map((block) => {
    if (block.type === "text") return markdownView(block.text, openLink);
    if (block.type === "resource_link") return h("button", { type: "button", class: "part chip", title: block.uri, html: ICON.file, onclick: () => openLink?.(block.uri, el) }, block.name);
    return partNode(block);
  }));
  if (!streaming && content.some((block) => block.type === "text")) el.append(h("div", { class: "content-actions" },
    copyButton(content.map((block) => block.type === "text" ? block.text : block.uri ?? "").filter(Boolean).join("\n\n"), "content.copyMessage")));
  return el;
}

const base64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(",") + 1));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

/**
 * 剪贴板或拖放的数据 → 内容。图片成为 image 块（带上字节），其他文件成为 resource_link（只带路径），
 * 没有文件时取纯文本。data 在事件结束后就不能读了，所以先同步取出文件和文本。
 */
export function fromClipboard(data) {
  const files = [...data.files];
  const text = data.getData("text/plain");
  if (!files.length) return Promise.resolve(text ? [{ type: "text", text }] : []);
  return Promise.all(files.map(async (file) => {
    if (file.type.startsWith("image/")) return { type: "image", mimeType: file.type, data: await base64(file) };
    const path = xsb.pathOf(file);
    return { type: "resource_link", uri: path ? `file://${path.split("/").map(encodeURIComponent).join("/")}` : file.name, name: file.name, size: file.size, ...(file.type ? { mimeType: file.type } : {}) };
  }));
}

/**
 * 输入框：内容的编辑形态。文本就是文本（markdown 源码），其余的块是一个不可编辑的小方块，
 * 可以像一个字符那样被光标越过和删除。onEnter(interject) 在按下回车时调用；⇧↩ 换行。
 * onChange 在内容变了之后调用：输入、粘贴、清空。
 */
export function createEditor(onEnter, onChange = () => {}) {
  const el = h("div", { class: "editor", contenteditable: "plaintext-only", role: "textbox", "aria-multiline": "true" });
  const blocks = new WeakMap();      // 小方块的节点 → 它代表的块

  /** 内容 → 输入框：插到光标处。 */
  function insert(content) {
    el.focus();
    const selection = getSelection();
    const range = selection.getRangeAt(0);
    range.deleteContents();
    for (const block of content) {
      const node = block.type === "text" ? document.createTextNode(block.text) : partNode(block);
      if (block.type !== "text") {
        node.contentEditable = "false";
        blocks.set(node, block);
      }
      range.insertNode(node);
      range.setStartAfter(node);
    }
    range.collapse(true);
    onChange();
  }

  /** 输入框 → 内容：按节点顺序读出，首尾的空白不算。 */
  function read() {
    let content = [];
    for (const node of el.childNodes) {
      content = append(content, blocks.get(node) ?? { type: "text", text: node.nodeName === "BR" ? "\n" : node.textContent });
    }
    const trimmed = content.map((block, i) => (block.type !== "text" ? block
      : { ...block, text: block.text.slice(i === 0 ? block.text.search(/\S|$/) : 0).replace(i === content.length - 1 ? /\s+$/ : /$^/, "") }));
    return trimmed.filter((block) => block.type !== "text" || block.text);
  }

  const take = (data) => fromClipboard(data).then(insert);
  el.onpaste = (e) => { e.preventDefault(); take(e.clipboardData); };
  el.ondragover = (e) => e.preventDefault();
  el.ondrop = (e) => { e.preventDefault(); take(e.dataTransfer); };
  el.onkeydown = (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    onEnter(e.metaKey || e.ctrlKey);
  };
  // 删空之后浏览器会留下一个换行，清掉它，占位文字才会回来
  el.oninput = () => { if (!read().length) el.replaceChildren(); onChange(); };

  return { el, insert, read, clear: () => { el.replaceChildren(); onChange(); } };
}
