// The trusted renderer describes the viewport; main owns the native input shield.
let active;
export function clearControl() { active?.stop(); }
export function showControl(container, page) {
  // Keep the viewport current while idle too, so main can install the shield
  // synchronously at turn start, before the next injected input command.
  if (active?.container === container && active.id === page.id) return;
  active?.stop();
  let frame, last, stopped = false;
  const notify = (bounds) => {
    const key = JSON.stringify(bounds); if (last === key) return;
    last = key; void xsb.page(page.id, "controlBounds", bounds).catch(() => {});
  };
  const stop = () => {
    if (stopped) return; stopped = true;
    cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect();
    window.removeEventListener("resize", schedule); document.removeEventListener("scroll", schedule, true);
    notify(null); if (active?.id === page.id) active = undefined;
  };
  const update = () => {
    frame = undefined;
    if (!container.isConnected) return stop();
    if (!container.getClientRects().length || document.querySelector("dialog[open], :popover-open")) return notify(null);
    const rect = container.getBoundingClientRect();
    const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
    const width = Math.min(innerWidth, rect.right) - x, height = Math.min(innerHeight, rect.bottom) - y;
    notify(width > 0 && height > 0 ? { x, y, width, height } : null);
  };
  const schedule = () => { if (!stopped && frame === undefined) frame = requestAnimationFrame(update); };
  const resize = new ResizeObserver(schedule), mutations = new MutationObserver(schedule);
  resize.observe(container);
  mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
  window.addEventListener("resize", schedule); document.addEventListener("scroll", schedule, true);
  active = { id: page.id, container, stop }; schedule();
}
