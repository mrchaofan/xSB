// 右键菜单：会话行和右栏标签用它。样式与其他下拉菜单相同（styles.css 的 .session-menu）。
// 菜单在右键按下时打开，自动浮层（popover="auto"）会在松开时把它当作"点在外面"关掉，所以用手动浮层：
// Esc 和窗口失去焦点由这里关，点外面由 form.js 的 shieldPopovers 关（那一下不会落到下面）。
import { ICON, h } from "./dom.js";

/**
 * 在指针处打开菜单。items：{ label, run, icon?, disabled?, hint?, danger? }，icon 是 ICON 的键，hint 是不可用的原因；
 * null 画一条分隔线（首尾和连续的分隔线不画）。没有图标的项也留出图标的位置，文字左对齐。
 * 同一时间只有一个右键菜单。
 */
export function openContextMenu(event, items, label) {
  event.preventDefault();
  document.querySelector(".context-menu:popover-open")?.hidePopover();
  const rows = items.filter((item, i) => item || (i > 0 && items[i - 1] && items.slice(i + 1).some(Boolean)));
  const menu = h("div", { class: "session-menu context-menu", popover: "manual", role: "menu", "aria-label": label },
    ...rows.map((item) => item
      ? h("button", { type: "button", role: "menuitem", class: `session-menu-item${item.danger ? " danger" : ""}`, disabled: !!item.disabled,
        onclick: () => { close(); item.run(); } },
        h("span", { class: "menu-icon", "aria-hidden": "true", html: item.icon ? ICON[item.icon] : "" }),
        h("span", { class: "session-menu-name" }, item.label),
        item.disabled && item.hint && h("small", {}, item.hint))
      : h("hr", { role: "separator" })));
  const close = () => menu.hidePopover();
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", close);
  menu.addEventListener("toggle", (e) => {
    if (e.newState !== "closed") return;
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", close);
    menu.remove();
  });
  // 上下键在可用的项之间移动
  menu.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const enabled = [...menu.querySelectorAll("button:not(:disabled)")];
    const at = enabled.indexOf(document.activeElement);
    enabled[(at + (e.key === "ArrowDown" ? 1 : enabled.length - 1)) % enabled.length]?.focus();
  });
  document.body.append(menu);
  menu.showPopover();
  // 贴着指针，放不下就往回让，不出窗口
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(event.clientX, innerWidth - width - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(event.clientY, innerHeight - height - 8)) + "px";
  menu.querySelector("button:not(:disabled)")?.focus();
  return menu;
}

/** 会话行的系统原生菜单；关闭菜单不执行动作。 */
export async function openNativeContextMenu(event, items) {
  event.preventDefault();
  const index = await xsb.contextMenu(items.map(item => item ? { label: item.label, disabled: !!item.disabled, hint: item.hint } : null), event.clientX, event.clientY);
  if (Number.isInteger(index) && items[index] && !items[index].disabled) items[index].run();
}
