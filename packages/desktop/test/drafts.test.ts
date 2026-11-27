import assert from "node:assert/strict";
import { test } from "node:test";
import { draftKey, loadDraft, moveDraft, saveDraft } from "../renderer/drafts.js";
import { assetReferenceParts } from "../src/content.ts";
import { assetRefTag } from "@xsb/protocol";

const values = new Map<string, string>();
let failWrites = false;
Object.assign(globalThis, { localStorage: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { if (failWrites) throw new Error("quota"); values.set(key, value); },
  removeItem: (key: string) => { if (failWrites) throw new Error("quota"); values.delete(key); },
} });
const content = [
  { type: "text", text: "  草稿\n\n" },
  { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
  { type: "resource_link", uri: "file:///tmp/a%20b.pdf", name: "a b.pdf" },
];

test("drafts survive reload with whitespace and attachments, isolated by workspace and session", async () => {
  const key = draftKey("/one", { id: "writer", mainSessionId: "session1" });
  saveDraft(key, content);
  const reloaded = await import("../renderer/drafts.js?reload");
  assert.deepEqual(reloaded.loadDraft(key), content);
  assert.deepEqual(loadDraft(draftKey("/two", { id: "writer", mainSessionId: "session1" })), []);
  assert.deepEqual(loadDraft(draftKey("/one", { id: "writer", mainSessionId: "session2" })), []);
  const snapshot = loadDraft(key);
  snapshot[0].text = "changed";
  assert.deepEqual(loadDraft(key), content);
  saveDraft(key, []);
  const afterSend = await import("../renderer/drafts.js?after-send");
  assert.deepEqual(afterSend.loadDraft(key), []);
});

test("a newly created session takes over the agent's provisional draft", () => {
  const from = draftKey("/new", { id: "writer" });
  const to = draftKey("/new", { id: "writer", mainSessionId: "created" });
  saveDraft(from, content);
  moveDraft(from, to);
  assert.deepEqual(loadDraft(to), content);
  assert.deepEqual(loadDraft(from), []);
});

test("drafts and history keep file links, surrounding text and exact current or legacy asset references", () => {
  const old = '<asset>{"name":"draft @ dune","version":"v2"}</asset>';
  const current = assetRefTag({ name: "ink & <paper>", version: "v3" });
  const file = { type: "resource_link", uri: "file:///tmp/draft%20%40%20dune.md", name: "draft @ dune.md" };
  saveDraft("refs", [{ type: "text", text: `edit ${old} / ${current} <asset>unfinished</asset>` }, file]);
  assert.deepEqual(loadDraft("refs").flatMap(assetReferenceParts), [
    { type: "text", text: "edit " },
    { type: "asset_reference", name: "draft @ dune", version: "v2" },
    { type: "text", text: " / " },
    { type: "asset_reference", name: "ink & <paper>", version: "v3" },
    { type: "text", text: " <asset>unfinished</asset>" },
    file,
  ]);
});

test("unavailable storage keeps switching and clearing usable in memory", () => {
  failWrites = true;
  try {
    saveDraft("quota", content);
    assert.deepEqual(loadDraft("quota"), content);
    saveDraft("quota", []);
    assert.deepEqual(loadDraft("quota"), []);
  } finally { failWrites = false; }
  values.set('xsb.draft:corrupt', '{broken');
  assert.deepEqual(loadDraft("corrupt"), []);
  values.set('xsb.draft:invalid', '{"type":"text"}');
  assert.deepEqual(loadDraft("invalid"), []);
});
