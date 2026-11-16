// 造 DOM 的小工具和图标，界面的每个文件都用。

export const $ = (selector) => document.querySelector(selector);

/** h("button", { class: "x", onclick: fn, html: "<svg…>" }, child, …)。值为 false 或 null 的属性和子节点会被略过。 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "html") el.innerHTML = value;
    else if (key.startsWith("on")) el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...present(children));
  return el;
}

/** 把 el 的内容换成 children。界面里换内容都走这里，不直接调 replaceChildren。 */
export function fill(el, ...children) {
  el.replaceChildren(...present(children));
}

// `条件 && 节点` 在条件不成立时得到 false 或 null；它们表示"这里没有东西"，不能当成文字放进页面。
const present = (children) => children.filter((c) => c != null && c !== false);

/** 界面用到的几个图标。 */
export const ICON = {
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  stop: '<svg viewBox="0 0 16 16"><rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" stroke="none"/></svg>',
  send: '<svg viewBox="0 0 16 16"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>',
  file: '<svg viewBox="0 0 16 16"><path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3"/></svg>',
  pin: '<svg viewBox="0 0 16 16"><path d="M9.5 2.5l4 4-2 .5-2.5 2.5v3L6 9.5 3 12.5M6 9.5L3.5 7h3L9 4.5z"/></svg>',
  edit: '<svg viewBox="0 0 16 16"><path d="M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6"/><circle cx="10" cy="5" r="1.5"/><circle cx="6" cy="11" r="1.5"/></svg>',
};
