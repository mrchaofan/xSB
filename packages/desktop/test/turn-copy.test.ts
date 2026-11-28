import assert from "node:assert/strict";
import { test } from "node:test";

Object.assign(globalThis, { window: { xsb: { language: "en" } }, document: { documentElement: {}, querySelectorAll: () => [] } });
const { turnCopyText } = await import("../renderer/turn-copy.js");

test("copy retains source blocks, tool details and question answers in transcript order", async () => {
  const markdown = "**First**\n\n```js\nconst value = 2;\n```";
  const copy = await turnCopyText([
    { kind: "input", origin: { kind: "system" }, content: [
      { type: "text", text: "Start" }, { type: "resource_link", name: "draft [v2]", uri: "file:///work/draft%20(v2)" },
    ] },
    { kind: "output", content: [{ type: "text", text: markdown }] },
    { kind: "tool", title: "Rename file", status: "done", input: { file: "draft" }, terminalOutput: "finished", output: "unused",
      changes: [{ operation: "move", oldPath: "draft", path: "final" }], savedFile: { path: "final" } },
    { kind: "question", questions: [{ question: "Which colors?" }], state: "answered", answers: [["Red", "Green"]] },
    { kind: "input", origin: { kind: "user" }, reply: true, content: [{ type: "text", text: "internal answer envelope" }] },
    { kind: "permission", detail: "Read file", outcome: "allowed" },
    { kind: "error", text: "Command exited" },
  ]);
  assert.equal(copy, [
    "From xSB\nStart\n\n[draft \\[v2\\]](<file:///work/draft%20(v2)>)", markdown,
    'Rename file\nCompleted\nInput\n{\n  "file": "draft"\n}\nOutput\nfinished\nMoved draft → final',
    "The agent’s questions\nAnswered\nWhich colors?\nRed\nGreen", "Read file\nAllowed", "Command exited",
  ].join("\n\n"));
});

test("copy embeds recorded image bytes, retries a failed read and leaves external links alone", async (t) => {
  const url = "xsb-artifact://history/image?ref=example";
  const external = "https://example.com/image";
  const content = [{ type: "text", text: "Before" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    { type: "image", mimeType: "image/jpeg", data: "", url }, { type: "image", url: external }, { type: "text", text: "After" }];
  let missing = true;
  const fetch = t.mock.method(globalThis, "fetch", (address: string) => {
    assert.equal(address, url);
    return Promise.resolve(missing ? new Response(null, { status: 404 })
      : new Response(Uint8Array.of(255, 216, 255), { headers: { "Content-Type": "image/jpeg" } }));
  });
  // Node supplies Blob but does not expose the renderer's FileReader.
  class Reader {
    result = "";
    onload = () => {};
    async readAsDataURL(blob: Blob) {
      this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`;
      this.onload();
    }
  }
  Object.assign(globalThis, { FileReader: Reader });
  t.after(() => Reflect.deleteProperty(globalThis, "FileReader"));
  const copy = () => turnCopyText([{ kind: "output", content }]);
  await assert.rejects(copy, /404/);
  missing = false;
  assert.equal(await copy(), [
    "Before", "![Image](<data:image/png;base64,aGVsbG8=>)", "![Image](<data:image/jpeg;base64,/9j/>)", `![Image](<${external}>)`, "After",
  ].join("\n\n"));
  assert.equal(fetch.mock.callCount(), 2);
});
