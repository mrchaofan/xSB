// 取词：界面的文字都在 text.js 的表里，这里按当前语言取出来。
// xsb 是全局对象（见 app.js），language 由它给出："zh-CN" 或 "en"。
import { TEXT } from "./text.js";

export const language = window.xsb.language;

/** 键对应的文字。值是函数就用 vars 调用，是字符串就替换 {占位符}。键不存在时返回键本身：漏翻一眼能看到。 */
export function t(key, vars = {}) {
  const value = TEXT[language][key];
  if (value == null) return key;
  if (typeof value === "function") return value(vars);
  return value.replace(/\{(\w+)\}/g, (whole, name) => vars[name] ?? whole);
}

/** 时刻（几点几分），按当前语言的习惯。 */
export const clock = (iso) => new Date(iso).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });

/** 静态 HTML 里的文字：data-t="键" 是元素的文字，data-t-title 等是同名的属性。 */
export function localize(root) {
  for (const el of root.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
  for (const attr of ["title", "aria-label", "placeholder", "alt"]) {
    for (const el of root.querySelectorAll(`[data-t-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-t-${attr}`)));
  }
}

// 启动：两个页面（index.html、page.html）的入口都会加载到这里。
document.documentElement.lang = language;
localize(document);
