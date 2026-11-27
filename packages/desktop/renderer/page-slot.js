// 网页在窗口里的位置。网页是主进程持有的原生视图（../src/pages.ts），盖在这个页面的上面，
// 这里只给它留出地方：按 DOM 布局量出那块区域，告诉主进程把网页放过去（../src/page-host.ts），
// 并把这块区域在页面里设成透明（mask-image 挖空），网页没跟上布局的那一帧也不会透出底下的界面。
// 显示网页的地方有三处：右栏（pages.js）、HTML 制品的预览（app.js）、网页自己的窗口（page-window.js），同一时刻只有一处。
//
// 原生视图总在页面之上：模态对话框打开时，或页面里的浮层压到了这块区域，网页先让开（菜单在主进程的覆盖层里，见 menu.js）。
import { fill, h } from "./dom.js";
import { t } from "./i18n.js";

let active;     // { id, element, focus(), stop() }

/** container 里显示 page；page 打不开时显示原因。focus：用户打开的网页，摆好后把键盘交给它。container 换成别的内容，就是不再显示它。 */
export function showWeb(container, page, focus = false) {
  if (page.error) {
    active?.stop();
    return fill(container, h("div", { class: "web-note" },
      h("p", {}, t("web.error", { error: page.error })),
      h("button", { class: "btn", onclick: () => xsb.page(page.id, "reload") }, t("web.reload"))));
  }
  if (active?.id === page.id && active.element.parentElement === container) {
    if (focus) active.focus();
    return;
  }
  active?.stop();
  const element = h("div", { class: "page-slot" });
  fill(container, element);
  active = slot(page.id, element, focus);
}

function slot(id, element, focus) {
  let last, lastRatio, queued = false, stopped = false, wantsFocus = focus;
  const tell = (bounds) => {
    const key = JSON.stringify(bounds);
    if (key !== last || devicePixelRatio !== lastRatio) {
      last = key;
      lastRatio = devicePixelRatio;
      // 只在变了时改：这些改动本身也会被下面的观察者看到。
      document.body.classList.toggle("page-hole", !!bounds);
      if (bounds) for (const [name, value] of Object.entries(bounds)) document.body.style.setProperty(`--page-${name}`, `${value}px`);
      // 网页可能已经关了或移走了：那就没什么可摆的。
      void xsb.page(id, "bounds", bounds).catch(() => {});
    }
    if (bounds && wantsFocus) {
      wantsFocus = false;
      void xsb.page(id, "focus").catch(() => {});
    }
  };
  const covered = (rect) => !!document.querySelector("dialog[open]") || [...document.querySelectorAll("[popover]")].some((p) => {
    if (!p.matches(":popover-open")) return false;
    const r = p.getBoundingClientRect();
    return r.right > rect.left && r.left < rect.right && r.bottom > rect.top && r.top < rect.bottom;
  });
  const update = () => {
    if (!queued) return;
    queued = false;
    if (!element.isConnected) return stop();
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    if (right <= x || bottom <= y || !element.getClientRects().length || covered(rect)) return tell(null);
    tell({ x, y, width: right - x, height: bottom - y });
  };
  // 下一帧量；隐藏的窗口没有帧，再加一个定时器。
  const schedule = () => {
    if (stopped || queued) return;
    queued = true;
    requestAnimationFrame(update);
    setTimeout(update, 100);
  };
  const resize = new ResizeObserver(schedule);
  const mutations = new MutationObserver(schedule);
  resize.observe(element);
  resize.observe(document.documentElement);
  mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
  addEventListener("resize", schedule);
  document.addEventListener("scroll", schedule, true);
  document.addEventListener("toggle", schedule, true);    // 浮层开关不改属性
  function stop() {
    if (stopped) return;
    stopped = true;
    queued = false;
    resize.disconnect();
    mutations.disconnect();
    removeEventListener("resize", schedule);
    document.removeEventListener("scroll", schedule, true);
    document.removeEventListener("toggle", schedule, true);
    tell(null);
    if (active?.element === element) active = undefined;
  }
  schedule();
  return { id, element, stop, focus: () => { wantsFocus = true; if (last && last !== "null") tell(JSON.parse(last)); } };
}
