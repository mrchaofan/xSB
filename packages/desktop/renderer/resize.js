/** 捕获丢失或窗口失焦时，两种分隔线都要结束本次拖动。 */
function bindDividerDrag(divider, resize, start) {
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
    // 窗口外松手等情况下可能收不到 pointerup。
    if (event.pointerType !== "touch" && !(event.buttons & 1)) { stop(event); return; }
    resize(event);
  };
  divider.addEventListener("pointerdown", (event) => {
    if (pointerId !== null || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    if (divider.tabIndex === 0) divider.focus({ preventScroll: true });
    divider.setPointerCapture(event.pointerId);
    pointerId = event.pointerId;
    start?.(event);
    divider.classList.add("dragging");
    doc.addEventListener("pointermove", move, true);
    doc.addEventListener("pointerup", stop, true);
    doc.addEventListener("pointercancel", stop, true);
    win.addEventListener("blur", stop);
  });
  divider.addEventListener("lostpointercapture", stop);
}

export function bindArtifactResize(divider) {
  const doc = divider.ownerDocument;
  bindDividerDrag(divider, (event) => {
    const windowWidth = doc.defaultView.innerWidth;
    const width = Math.min(Math.max(windowWidth - event.clientX, 300), windowWidth * 0.6);
    doc.documentElement.style.setProperty("--artifact-w", `${width}px`);
  });
}

export function bindWorkflowResize(divider, map) {
  const panel = map.parentElement;
  let preferredHeight;

  function fit(requested) {
    if (!divider.offsetHeight) return;
    const available = Math.max(0, Math.floor(panel.getBoundingClientRect().bottom - map.getBoundingClientRect().top - divider.offsetHeight));
    // 图下方为详情和聊天留出 300px；更矮时留 60%，使图和下方内容都可操作。
    const reserved = Math.min(300, Math.ceil(available * 0.6));
    const max = Math.min(600, available - reserved);
    const min = Math.min(96, max);
    const height = Math.max(min, Math.min(max, Math.round(requested ?? preferredHeight ?? panel.clientHeight * 0.4)));
    if (requested !== undefined) preferredHeight = height;
    map.style.height = `${height}px`;
    divider.setAttribute("aria-valuemin", min);
    divider.setAttribute("aria-valuemax", max);
    divider.setAttribute("aria-valuenow", height);
    divider.setAttribute("aria-valuetext", `${height}px`);
  }

  // 从当前图高加上拖动距离；在分隔线热区边缘按下也不会跳动。
  let dragOriginY;
  bindDividerDrag(divider, (event) => fit(event.clientY - dragOriginY), (down) => {
    dragOriginY = down.clientY - map.offsetHeight;
  });
  divider.addEventListener("keydown", (event) => {
    const heights = { ArrowUp: map.offsetHeight - 16, ArrowDown: map.offsetHeight + 16, Home: 0, End: Infinity };
    if (!Object.hasOwn(heights, event.key)) return;
    event.preventDefault();
    fit(heights[event.key]);
  });
  const observer = new ResizeObserver(() => fit());
  observer.observe(panel);
  observer.observe(divider); // 折叠后再展开，或空工作流首次有图。
}
