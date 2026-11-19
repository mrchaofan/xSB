import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Paths } from "@xsb/hub";
import { imagesFromPaths } from "../src/clipboard-image.ts";
import { imageMimeType } from "../src/image.ts";
import { Workspace } from "../src/workspace.ts";

Object.assign(globalThis, {
  window: { xsb: { language: "zh-CN" } },
  document: { documentElement: {}, querySelectorAll: () => [] },
  xsb: { pathOf: (file: File) => `/tmp/${file.name}` },
});
const { fromClipboard } = await import("../renderer/clipboard.js");
const png = fs.readFileSync(new URL("../renderer/avatars/animal-cat.png", import.meta.url));
const clipboard = (files: File[] = [], text = "") => ({ files, getData: () => text });

test("file manager images with missing or wrong MIME types become actual base64 images", async () => {
  for (const [name, type] of [["照片.PNG", ""], ["photo.png", "application/octet-stream"], ["clipboard", ""]]) {
    const [block] = await fromClipboard(clipboard([new File([png], name, { type })]));
    assert.equal(block.type, "image");
    assert.equal(block.mimeType, "image/png");
    assert.deepEqual(Buffer.from(block.data, "base64"), png);
    assert.equal("uri" in block, false);
  }
});

test("screenshots stay inline, while ordinary files and text retain their original meaning", async () => {
  const image = { type: "image", mimeType: "image/png", data: png.toString("base64") };
  let reads = 0;
  (globalThis as any).xsb.readClipboardImages = async () => { reads++; return [image]; };
  assert.deepEqual(await fromClipboard(clipboard([], "/tmp/photo.png"), true), [image]);
  assert.equal(reads, 1);
  assert.deepEqual(await fromClipboard(clipboard([], "普通文字")), [{ type: "text", text: "普通文字" }]);
  assert.equal(reads, 1, "drag/drop must not read an unrelated system clipboard");
  const [file] = await fromClipboard(clipboard([new File(["notes"], "笔记.txt", { type: "text/plain" })]), true);
  assert.equal(file.type, "resource_link");
  assert.equal(file.uri, "file:///tmp/%E7%AC%94%E8%AE%B0.txt");
  assert.equal(reads, 1);
  (globalThis as any).xsb.readClipboardImages = async () => null;
  assert.deepEqual(await fromClipboard(clipboard([], "普通文字"), true), [{ type: "text", text: "普通文字" }]);
});

test("path-only image copies read the file bytes, including spaces and file URLs", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-clipboard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "照片 a.png");
  fs.writeFileSync(file, png);
  const convert = () => { throw new Error("PNG must not need conversion"); };
  for (const input of [file, `"${file}"`, pathToFileURL(file).href]) {
    const blocks = imagesFromPaths(input, convert)!;
    assert.equal(blocks[0].type, "image");
    assert.deepEqual(Buffer.from(blocks[0].data as string, "base64"), png);
  }
  assert.equal(imagesFromPaths(`请看一下 ${file}`, convert), null);
  assert.equal(imagesFromPaths("https://example.com/photo.png", convert), null);
  assert.equal(imagesFromPaths(path.join(dir, "notes.txt"), convert), null);
  assert.throws(() => imagesFromPaths(path.join(dir, "missing.png"), convert), /not found/);
  assert.equal(imagesFromPaths(`${file}\n${file}`, convert)!.length, 2);
});

test("image content reaches session/prompt as bytes rather than a disk path", async (t) => {
  const [image] = await fromClipboard(clipboard([new File([png], "photo.png")]));
  let received: any;
  const peer = {
    onNotification() {}, onRequest() {}, closed: new Promise(() => {}), close() {},
    async request(method: string, params: unknown) { if (method === "session/prompt") received = params; return { messageId: "sent" }; },
  };
  const ws = new Workspace(new Paths("/tmp/xsb-image-send"), peer as any, String, () => {});
  t.after(() => ws.close());
  ws.agents.set("writer", { id: "writer" } as any);
  ws["mains"].set("writer", Promise.resolve("main"));
  await ws.send("writer", [{ type: "text", text: "描述这张图" }, image]);
  assert.equal(received.sessionId, "main");
  assert.equal(received.prompt[1].type, "image");
  assert.equal(received.prompt[1].mimeType, "image/png");
  assert.deepEqual(Buffer.from(received.prompt[1].data, "base64"), png);
});

test("image format detection accepts vision formats and rejects mislabeled data", async () => {
  assert.equal(imageMimeType(Buffer.from([255, 216, 255, 0])), "image/jpeg");
  assert.equal(imageMimeType(Buffer.from("GIF89a")), "image/gif");
  assert.equal(imageMimeType(Buffer.from("RIFF0000WEBP")), "image/webp");
  assert.equal(imageMimeType(Buffer.from("not an image")), undefined);
  await assert.rejects(fromClipboard(clipboard([new File(["not an image"], "photo.png", { type: "image/png" })])), /图片格式/);
});
