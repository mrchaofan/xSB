import assert from "node:assert/strict";
import { test } from "node:test";

Object.assign(globalThis, { window: { xsb: { language: "zh-CN" } }, document: { documentElement: {}, querySelectorAll: () => [] } });
const { dropPageAnnotations, expandAnnotation } = await import("../renderer/web-annotation.js");

const note = { type: "web_annotation", index: 2, note: "按钮太浅", label: "button#buy", url: "https://shop.example/", title: "Shop",
  html: '<button id="buy">```买```</button>', image: { mimeType: "image/png", data: "aW1hZ2U=" } };

test("a web annotation is sent as the user's words, the element's HTML in a code block, and its picture", () => {
  const [text, image] = expandAnnotation(note);
  assert.equal(text.type, "text");
  assert.match(text.text, /网页批注 2：按钮太浅/);
  assert.match(text.text, /button#buy/);
  assert.match(text.text, /https:\/\/shop\.example\//);
  // The page's own backticks cannot close the block early: the fence is longer than any of them.
  assert.ok(text.text.includes('````html\n<button id="buy">```买```</button>\n````'));
  assert.deepEqual(image, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" });
});

test("only a PNG in base64 becomes a picture", () => {
  for (const bad of [{ mimeType: "image/svg+xml", data: "aW1hZ2U=" }, { mimeType: "image/png", data: "x\"onerror=1" }, undefined]) {
    const blocks = expandAnnotation({ ...note, image: bad });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "text");
  }
});

test("cleanup after a send addresses each annotation on its own page, including large drafts", async () => {
  const calls: unknown[][] = [];
  Object.assign(globalThis, { xsb: { page: async (...args: unknown[]) => { calls.push(args); } } });
  const notes = Array.from({ length: 202 }, (_, i) => ({ pageId: "p1", id: String(i) }));
  await dropPageAnnotations([...notes, notes[0], { pageId: "p2", id: "other" }]);
  assert.deepEqual(calls, [
    ["p1", "annotationsRemove", notes.slice(0, 200).map(note => note.id)],
    ["p1", "annotationsRemove", ["200", "201"]],
    ["p2", "annotationsRemove", ["other"]],
  ]);
});
