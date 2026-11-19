/** 拖动分隔线改右栏宽度；捕获丢失或窗口失焦也必须结束本次拖动。 */
export function bindArtifactResize(divider) {
  const doc = divider.ownerDocument;
  const win = doc.defaultView;
  let pointerId = null;

  const stop = (event) => {
    if (pointerId === null || (event?.pointerId !== undefined && event.pointerId !== pointerId)) return;
    const released = pointerId;
    pointerId = null;
    divider.classList.remove("dragging");
    doc.removeEventListener("pointermove", move, true);
    doc.removeEventListener("pointerup", stop, true);
    doc.removeEventListener("pointercancel", stop, true);
    win.removeEventListener("blur", stop);
    if (divider.hasPointerCapture(released)) divider.releasePointerCapture(released);
  };
  const move = (event) => {
    if (event.pointerId !== pointerId) return;
    // 窗口外松手等情况下可能收不到 pointerup；下一次移动不能继续改宽度。
    if (event.pointerType !== "touch" && !(event.buttons & 1)) { stop(event); return; }
    const width = Math.min(Math.max(win.innerWidth - event.clientX, 300), win.innerWidth * 0.6);
    doc.documentElement.style.setProperty("--artifact-w", `${width}px`);
  };
  divider.addEventListener("pointerdown", (event) => {
    if (pointerId !== null || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    pointerId = event.pointerId;
    divider.classList.add("dragging");
    doc.addEventListener("pointermove", move, true);
    doc.addEventListener("pointerup", stop, true);
    doc.addEventListener("pointercancel", stop, true);
    win.addEventListener("blur", stop);
  });
  divider.addEventListener("lostpointercapture", stop);
}
