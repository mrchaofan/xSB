import assert from "node:assert/strict";
import test from "node:test";
import type { View } from "electron";
import { ViewStack } from "../src/view-stack.ts";

/** Electron inserts or reorders the child at the given index. */
function fakeRoot() {
  const children: View[] = [];
  const moves: string[] = [];
  const root = {
    get children() { return [...children]; },
    addChildView(view: View, index: number) {
      const at = children.indexOf(view);
      if (at >= 0) children.splice(at, 1);
      children.splice(index, 0, view);
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
  // The open menu retains keyboard focus even as the shield is added below it.
  assert.deepEqual(moves.splice(0), ["+page", "+overlay", "+shield"]);
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
  assert.deepEqual(moves.splice(0), ["+editor"]);
  stack.take(overlay);
  assert.deepEqual(moves.splice(0), ["-overlay"]);
  assert.equal(stack.has(overlay), false);
  assert.equal(stack.has(editor), true);
});
