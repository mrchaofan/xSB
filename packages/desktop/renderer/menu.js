// 右键菜单：右栏标签用它。样式与其他下拉菜单相同（styles.css 的 .session-menu）。
// 菜单画在窗口的覆盖层里（overlay.js、../src/overlay.ts）：它要能盖住网页，而网页是盖在这个页面上面的原生视图。
// 覆盖层自己关：点外面、Esc、失去焦点；这里只等它的答复。

/**
 * 在指针处打开菜单。items：{ label, run, icon?, disabled?, hint?, danger? }，icon 是 ICON 的键，hint 是不可用的原因；
 * null 画一条分隔线（首尾和连续的分隔线不画）。没有图标的项也留出图标的位置，文字左对齐。
 * 同一时间只有一个菜单：再开一个，前一个就关了。
 */
export async function openContextMenu(event, items, label) {
  event.preventDefault();
  const index = await xsb.overlay({
    kind: "menu", x: event.clientX, y: event.clientY, label, provider: document.documentElement.dataset.provider ?? null,
    items: items.map((item) => item && { label: item.label, icon: item.icon, disabled: !!item.disabled, hint: item.hint, danger: !!item.danger }),
  }).catch(() => null);
  if (Number.isInteger(index) && items[index] && !items[index].disabled) items[index].run();
}

/** 会话行的系统原生菜单；关闭菜单不执行动作。 */
export async function openNativeContextMenu(event, items) {
  event.preventDefault();
  const index = await xsb.contextMenu(items.map(item => item ? { label: item.label, disabled: !!item.disabled, hint: item.hint } : null), event.clientX, event.clientY);
  if (Number.isInteger(index) && items[index] && !items[index].disabled) items[index].run();
}
