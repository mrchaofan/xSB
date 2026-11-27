import assert from "node:assert/strict";
import test from "node:test";
import type { View } from "electron";
import { ViewStack, restack } from "../src/view-stack.ts";

test("restack keeps the longest ordered start and re-adds the rest", () => {
  assert.deepEqual(restack([], ["a", "b"]), { remove: [], add: ["a", "b"] });
  assert.deepEqual(restack(["a", "b", "c"], ["a", "b", "c"]), { remove: [], add: [] });
  // c out of place: re-adding c alone puts it on top.
  assert.deepEqual(restack(["a", "c", "b"], ["a", "b", "c"]), { remove: [], add: ["c"] });
  assert.deepEqual(restack(["b", "a"], ["a", "b"]), { remove: [], add: ["b"] });
  assert.deepEqual(restack(["x", "a", "y"], ["a", "z"]), { remove: ["x", "y"], add: ["z"] });
  assert.deepEqual(restack(["c", "b", "a"], ["a", "b", "c"]), { remove: [], add: ["b", "c"] });
});

/** A view's children, as Electron keeps them: re-adding a child moves it on top. */
function fakeRoot() {
  const children: View[] = [];
  const moves: string[] = [];
  const root = {
    get children() { return [...children]; },
    addChildView(view: View) {
      const at = children.indexOf(view);
      if (at >= 0) children.splice(at, 1);
      children.push(view);
      moves.push(`+${(view as any).name}`);
    },
    removeChildView(view: View) {
      const at = children.indexOf(view);
      if (at >= 0) children.splice(at, 1);
      moves.push(`-${(view as any).name}`);
    },
  } as unknown as View;
  const names = () => children.map((view) => (view as any).name);
  return { root, moves, names };
}
const view = (name: string) => ({ name }) as unknown as View;

test("a stack orders views by layer with the fewest moves", () => {
  const { root, moves, names } = fakeRoot();
  const stack = new ViewStack(root);
  const page = view("page"), other = view("other"), shield = view("shield"), editor = view("editor"), overlay = view("overlay");
  stack.put(page, "page");
  stack.put(overlay, "overlay");
  stack.put(shield, "control");
  assert.deepEqual(names(), ["page", "shield", "overlay"]);
  // The shield goes between: page stays, shield and overlay are added on top in order.
  assert.deepEqual(moves.splice(0), ["+page", "+overlay", "+shield", "+overlay"]);
  // Putting a view again in the layer it is in changes nothing.
  stack.put(page, "page");
  assert.deepEqual(moves.splice(0), []);
  // Another page goes in under the shield and the overlay.
  stack.take(page);
  stack.put(other, "page");
  assert.deepEqual(names(), ["other", "shield", "overlay"]);
  moves.splice(0);
  stack.put(editor, "annotation");
  assert.deepEqual(names(), ["other", "shield", "editor", "overlay"]);
  assert.deepEqual(moves.splice(0), ["+editor", "+overlay"]);
  stack.take(overlay);
  assert.deepEqual(moves.splice(0), ["-overlay"]);
  assert.equal(stack.has(overlay), false);
  assert.equal(stack.has(editor), true);
});
