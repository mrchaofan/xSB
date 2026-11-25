// 网页批注在对话内容里的样子（../src/page-annotations.ts 的 WebAnnotation）：输入框里是一个小块，发送时展开。
import { t } from "./i18n.js";

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** 网页批注的截图；只认主进程给的 PNG。 */
export const annotationImage = (block) => block.image?.mimeType === "image/png" && typeof block.image.data === "string" && BASE64.test(block.image.data) ? block.image : null;

/**
 * 网页批注（../src/page-annotations.ts 的 WebAnnotation）发送时展开成后端都认的内容：
 * 一段文字（用户的话、元素、网页和元素的 HTML），再加元素的截图。网页给的 HTML 只放进代码块，当作文字。
 */
export function expandAnnotation(block) {
  const html = String(block.html ?? "");
  const fence = "`".repeat(Math.max(3, ...[...html.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const text = t("composer.annotationPrompt", { index: block.index, note: String(block.note ?? ""), label: String(block.label ?? ""),
    title: String(block.title ?? ""), url: String(block.url ?? ""), html: `${fence}html\n${html}\n${fence}` });
  const image = annotationImage(block);
  return [{ type: "text", text }, ...(image ? [{ type: "image", mimeType: image.mimeType, data: image.data }] : [])];
}

