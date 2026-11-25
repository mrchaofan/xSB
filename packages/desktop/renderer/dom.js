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
  info: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 4.5v.5"/></svg>',
  expand: '<svg viewBox="0 0 16 16"><path d="M6 2H2v4M10 2h4v4M2 10v4h4M14 10v4h-4"/></svg>',
  collapse: '<svg viewBox="0 0 16 16"><path d="M2 6h4V2M14 6h-4V2M6 14v-4H2M10 14v-4h4"/></svg>',
  list: '<svg viewBox="0 0 16 16"><path d="M6 4h8M6 8h8M6 12h8M2 4h.5M2 8h.5M2 12h.5"/></svg>',
  filter: '<svg viewBox="0 0 16 16"><path d="M2 4h12M4 8h8M6 12h4"/></svg>',
  copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-3h-8v8h3"/></svg>',
  check: '<svg viewBox="0 0 16 16"><path d="M3 8l3 3 7-7"/></svg>',
  settings: '<svg viewBox="0 0 16 16"><path d="M6 2h4l.5 2 2 .7 1.5 2.6-1.5 1.5.3 2.1-3 1.7L8 12l-1.8.6-3-1.7.3-2.1L2 7.3l1.5-2.6 2-.7z"/><circle cx="8" cy="7.5" r="2"/></svg>',
  appearance: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11"/></svg>',
  code: '<svg viewBox="0 0 16 16"><path d="M5 4L1.5 8 5 12M11 4l3.5 4-3.5 4M9 2L7 14"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M1.5 5V3h5l2 2h6v8h-13z"/></svg>',
  people: '<svg viewBox="0 0 16 16"><circle cx="6" cy="5" r="2.5"/><path d="M1.5 14v-2a4.5 4.5 0 0 1 9 0v2M11 3a2.5 2.5 0 0 1 0 5M12 10a3 3 0 0 1 2.5 3v1"/></svg>',
  grid: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>',
  back: '<svg viewBox="0 0 16 16"><path d="M10 3L5 8l5 5"/></svg>',
  down: '<svg viewBox="0 0 16 16"><path d="M3 6l5 5 5-5"/></svg>',
  forward: '<svg viewBox="0 0 16 16"><path d="M6 3l5 5-5 5"/></svg>',
  play: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M6 5l5 3-5 3z"/></svg>',

  globe: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12"/></svg>',
  flow: '<svg viewBox="0 0 16 16"><rect x="5.5" y="1.5" width="5" height="3.5" rx="1"/><rect x="1.5" y="11" width="5" height="3.5" rx="1"/><rect x="9.5" y="11" width="5" height="3.5" rx="1"/><path d="M8 5v3M4 11V8h8v3"/></svg>',
  plug: '<svg viewBox="0 0 16 16"><path d="M6 1.5v3M10 1.5v3M4 4.5h8v3a4 4 0 0 1-8 0zM8 11.5v3"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  stop: '<svg viewBox="0 0 16 16"><rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" stroke="none"/></svg>',
  send: '<svg viewBox="0 0 16 16"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>',
  file: '<svg viewBox="0 0 16 16"><path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3"/></svg>',
  pin: '<svg viewBox="0 0 16 16"><path d="M9.5 2.5l4 4-2 .5-2.5 2.5v3L6 9.5 3 12.5M6 9.5L3.5 7h3L9 4.5z"/></svg>',
  edit: '<svg viewBox="0 0 16 16"><path d="M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6"/><circle cx="10" cy="5" r="1.5"/><circle cx="6" cy="11" r="1.5"/></svg>',
};
