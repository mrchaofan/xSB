import assert from "node:assert/strict";
import { test } from "node:test";
import { bindArtifactResize } from "../renderer/resize.js";

function setup() {
  const win = Object.assign(new EventTarget(), { innerWidth: 1200 });
  const styles = new Map<string, string>();
  const doc = Object.assign(new EventTarget(), {
    defaultView: win,
    documentElement: { style: { setProperty: (key: string, value: string) => styles.set(key, value) } },
  });
  const classes = new Set<string>();
  const captured = new Set<number>();
  const divider = Object.assign(new EventTarget(), {
    ownerDocument: doc,
    classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => {
      captured.delete(id);
      send(divider, "lostpointercapture", { pointerId: id });
    },
  });
  bindArtifactResize(divider);
  return { win, doc, divider, captured, styles, classes };
}

function send(target: EventTarget, type: string, values = {}) {
  const event = Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, clientX: 750,
  }, values);
  target.dispatchEvent(event);
  return event;
}

test("drag resizes within bounds and release outside the divider stops it", () => {
  const { doc, divider, captured, styles, classes } = setup();
  assert.equal(send(divider, "pointerdown").defaultPrevented, true);
  send(doc, "pointermove");
  assert.equal(styles.get("--artifact-w"), "450px");
  send(doc, "pointermove", { clientX: 1190 });
  assert.equal(styles.get("--artifact-w"), "300px");
  send(doc, "pointermove", { clientX: 0 });
  assert.equal(styles.get("--artifact-w"), "720px");
  send(doc, "pointerup", { buttons: 0 });
  send(doc, "pointermove");
  assert.equal(styles.get("--artifact-w"), "720px");
  assert.equal(classes.has("dragging"), false);
  assert.equal(captured.size, 0);
});

for (const end of ["pointercancel", "lostpointercapture", "blur", "released-move"]) {
  test(`${end} ends resizing and allows a new drag`, () => {
    const { win, doc, divider, captured, styles, classes } = setup();
    send(divider, "pointerdown");
    send(doc, "pointermove");
    if (end === "blur") win.dispatchEvent(new Event("blur"));
    else if (end === "lostpointercapture") {
      captured.clear();
      send(divider, end);
    } else if (end === "released-move") send(doc, "pointermove", { buttons: 0, clientX: 900 });
    else send(doc, end);
    assert.equal(classes.has("dragging"), false);
    assert.equal(captured.size, 0);
    send(doc, "pointermove", { clientX: 900 });
    assert.equal(styles.get("--artifact-w"), "450px");
    send(divider, "pointerdown", { pointerId: 2 });
    send(doc, "pointermove", { pointerId: 2, clientX: 900 });
    assert.equal(styles.get("--artifact-w"), "300px");
    send(doc, "pointerup", { pointerId: 2 });
  });
}

test("only the primary pointer and left button can control the drag", () => {
  const { doc, divider, styles, classes } = setup();
  send(divider, "pointerdown", { button: 2, buttons: 2 });
  send(divider, "pointerdown", { isPrimary: false });
  assert.equal(classes.has("dragging"), false);
  send(divider, "pointerdown");
  send(divider, "pointerdown", { pointerId: 2 });
  send(doc, "pointermove", { pointerId: 2 });
  send(doc, "pointerup", { pointerId: 2 });
  assert.equal(styles.size, 0);
  assert.equal(classes.has("dragging"), true);
  send(doc, "pointermove");
  assert.equal(styles.get("--artifact-w"), "450px");
  send(doc, "pointerup");
});

test("touch dragging ends on cancellation", () => {
  const { doc, divider, styles, classes } = setup();
  send(divider, "pointerdown", { pointerType: "touch" });
  send(doc, "pointermove", { pointerType: "touch", buttons: 0 });
  assert.equal(styles.get("--artifact-w"), "450px");
  send(doc, "pointercancel", { pointerType: "touch" });
  assert.equal(classes.has("dragging"), false);
});
