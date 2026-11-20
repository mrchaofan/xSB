// Chromium popup guests retain their opener and POST state. They are mounted in
// the selected tab's viewport; no BrowserWindow is created by a website popup.
let active;

export function clearNative() {
  active?.stop();
}

export function showNative(container, page) {
  if (active?.element === container.firstElementChild && active.id === page.id) return;
  clearNative();
  const element = document.createElement("div");
  element.style.cssText = "width:100%;height:100%;flex:1;min-height:0";
  element.dataset.nativePage = page.id;
  container.replaceChildren(element);
  let frame;
  let last;
  let stopped = false;
  const notify = (bounds) => {
    const key = JSON.stringify(bounds);
    if (key === last) return;
    last = key;
    // A page may have been closed or moved since this layout was scheduled.
    void xsb.page(page.id, "bounds", bounds).catch(() => {});
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    window.removeEventListener("resize", schedule);
    document.removeEventListener("scroll", schedule, true);
    notify(null);
    if (active?.element === element) active = undefined;
  };
  const update = () => {
    frame = undefined;
    if (!element.isConnected) return stop();
    // Native views sit above DOM content: hide them for dialogs/popovers, and
    // when this tab is removed, collapsed or scrolled out of view.
    if (document.querySelector("dialog[open], :popover-open") || !element.getClientRects().length) return notify(null);
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    if (right <= x || bottom <= y) return notify(null);
    notify({ x, y, width: right - x, height: bottom - y });
  };
  const schedule = () => { if (!stopped && frame === undefined) frame = requestAnimationFrame(update); };
  const resize = new ResizeObserver(schedule);
  const mutations = new MutationObserver(schedule);
  resize.observe(element);
  mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
  window.addEventListener("resize", schedule);
  document.addEventListener("scroll", schedule, true);
  active = { element, id: page.id, stop };
  schedule();
}
