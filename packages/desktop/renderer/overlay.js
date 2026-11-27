import "./preferences.js";
// 窗口的覆盖层（overlay.html）：盖在整个窗口、包括网页之上的透明视图（../src/overlay.ts）。
// 网页是原生视图，窗口页面里的元素盖不住它，所以要盖住网页的菜单画在这里。
//
// 它自己关自己：点在所画的东西外面（它和窗口一样大，外面都是它自己的底）、Esc、失去焦点。
// 别的页面不发消息让它关；打开它的页面等它的答复（overlayDone）。
import { ICON, h } from "./dom.js";
import "./i18n.js";

/**
 * 覆盖层能画的东西：kind -> draw(request, done, layer)，把内容放进 layer，用户选定时调 done(答复)。
 * 加一种就是在这里加一项；主进程只转交请求和答复，不认识它们。
 */
const KINDS = { menu };

xsb.on((event) => { if (event.overlay) show(event.overlay); });

function show(request) {
  const { seq, kind } = request;
  const layer = h("div", { class: "overlay-layer" });
  let closed = false;
  const done = (result = null) => {
    if (closed) return;
    closed = true;
    removeEventListener("blur", dismiss);
    removeEventListener("keydown", onKey, true);
    layer.remove();
    void xsb.overlayDone(seq, result);
  };
  const dismiss = () => done(null);
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); dismiss(); } };
  // 点在底上（不在所画的东西里）就是点在外面：只用来关掉，不落到下面。
  layer.addEventListener("pointerdown", (e) => { if (e.target === layer) dismiss(); });
  layer.addEventListener("contextmenu", (e) => e.preventDefault());
  addEventListener("blur", dismiss);
  addEventListener("keydown", onKey, true);
  if (request.provider === "claude") document.documentElement.dataset.provider = "claude";
  else delete document.documentElement.dataset.provider;
  document.body.replaceChildren(layer);
  const draw = KINDS[kind];
  if (!draw) return dismiss();
  draw(request, done, layer);
}

/**
 * 菜单（menu.js 的 openContextMenu）：在 x, y 处，放不下就往回让。items：{ label, icon?, disabled?, hint?, danger? }，
 * icon 是 ICON 的键；null 画一条分隔线（首尾和连续的分隔线不画）。答复是所选项在 items 里的序号。
 */
function menu({ x, y, label, items }, done, layer) {
  const rows = items.map((item, index) => ({ item, index }))
    .filter(({ item }, i) => item || (i > 0 && items[i - 1] && items.slice(i + 1).some(Boolean)));
  const el = h("div", { class: "session-menu context-menu overlay-menu", role: "menu", "aria-label": label },
    ...rows.map(({ item, index }) => item
      ? h("button", { type: "button", role: "menuitem", class: `session-menu-item${item.danger ? " danger" : ""}`, disabled: !!item.disabled,
        onclick: () => done(index) },
        h("span", { class: "menu-icon", "aria-hidden": "true", html: ICON[item.icon] ?? "" }),
        h("span", { class: "session-menu-name" }, item.label),
        item.disabled && item.hint && h("small", {}, item.hint))
      : h("hr", { role: "separator" })));
  // 上下键在可用的项之间移动
  el.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const enabled = [...el.querySelectorAll("button:not(:disabled)")];
    const at = enabled.indexOf(document.activeElement);
    enabled[(at + (e.key === "ArrowDown" ? 1 : enabled.length - 1)) % enabled.length]?.focus();
  });
  layer.append(el);
  const { width, height } = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(x, innerWidth - width - 8)) + "px";
  el.style.top = Math.max(8, Math.min(y, innerHeight - height - 8)) + "px";
  el.querySelector("button:not(:disabled)")?.focus();
}
