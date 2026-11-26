import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "@xsb/store";
import { Discarded, History } from "@xsb/protocol";
import { Paths } from "../src/paths.ts";
import { Workspace } from "../../desktop/src/workspace.ts";
import { Hub } from "../src/hub.ts";
import { initProject } from "../src/config.ts";
import { historyPage, historyImage } from "../src/history.ts";

test("history pages keep multi-block messages intact and fetch normal and discarded images on demand", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-history-"));
  try {
    const store = new Store(dir), file = Paths.transcript("a", "s");
    const updates: any[] = [];
    const image = { type: "image", mimeType: "image/png", data: Buffer.from("large image ".repeat(10000)).toString("base64") };
    for (let i = 0; i < 25; i++) {
      updates.push({ sessionUpdate: "user_message_chunk", messageId: `m${i}`, content: { type: "text", text: `你好 ${i}` } });
      updates.push({ sessionUpdate: "user_message_chunk", messageId: `m${i}`, content: image });
      updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `reply ${i}` } });
    }
    updates.push({ sessionUpdate: "session_info_update", _meta: { [Discarded.key]: { messageId: "d", origin: { kind: "user" }, content: [image] } } });
    updates.forEach((update) => store.append(file, { update }, false));
    fs.appendFileSync(path.join(dir, file), '{"torn":');
    const all: any[] = [];
    let before: number | undefined;
    do {
      const page = historyPage(store, "a", "s", before);
      assert.ok(JSON.stringify(page).length < 15000);
      all.unshift(...page.updates);
      if (page.cursor === null) break;
      assert.ok(before === undefined || page.cursor < before);
      before = page.cursor;
    } while (true);
    assert.equal(all.length, updates.length);
    assert.deepEqual(all.filter(u => u.sessionUpdate === "user_message_chunk" && u.content.type === "text").map(u => u.content.text), updates.filter(u => u.sessionUpdate === "user_message_chunk" && u.content.type === "text").map(u => u.content.text));
    const ref = all.find(u => u.content?.type === "image").content._meta[History.imageKey];
    assert.deepEqual(historyImage(store, "a", ref), image);
    const discarded = all.at(-1)._meta[Discarded.key].content[0]._meta[History.imageKey];
    assert.deepEqual(historyImage(store, "a", discarded), image);
    assert.throws(() => historyImage(store, "a", { ...ref, offset: -1 }));
    assert.throws(() => historyImage(store, "a", { ...ref, offset: 0 }));
    const records = [...store.readBackwardEntries(file, undefined, 7)];
    assert.equal(records.length, updates.length);
    assert.deepEqual(records.map(r => store.readAt(file, r.offset)), records.map(r => r.record));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("desktop loads pages over a real hub connection and receives live images as references", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xsb-history-wire-")));
  const previousHome = process.env.XSB_HOME;
  process.env.XSB_HOME = path.join(dir, "home");
  const paths = new Paths(dir);
  initProject(paths);
  const hub = new Hub(dir);
  let ws: Workspace | undefined;
  try {
    const session = hub.createConversation("codex");
    session.save({ backend: "codex", backendSessionId: "existing-backend-session" });
    for (let i = 0; i < 15; i++) {
      session.emit({ sessionUpdate: "user_message_chunk", messageId: `m${i}`, content: { type: "text", text: `input ${i}` } });
      session.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `output ${i}` } });
    }
    await hub.start();
    const transcriptFile = path.join(paths.dir, Paths.transcript(session.agentId, session.id));
    const originalTranscript = fs.readFileSync(transcriptFile);
    const originalSession = JSON.stringify(session.rec);
    ws = await Workspace.open(paths, process.env, "en", String, () => {}, () => {});
    const loaded = await ws.load();
    assert.equal(loaded.transcripts[session.agentId].filter(e => e.kind === "input").length, 10);
    assert.notEqual(loaded.history[session.agentId], null);
    const older = await ws.history(session.agentId);
    assert.equal(older.entries.filter(e => e.kind === "input").length, 15);
    assert.equal(older.cursor, null);
    assert.deepEqual(fs.readFileSync(transcriptFile), originalTranscript, "display paging never rewrites the model's transcript");
    assert.equal(JSON.stringify(session.rec), originalSession, "display paging never resumes or renews the backend session");
    assert.equal(session.rec.backendSessionId, "existing-backend-session");
    assert.equal("spend" in loaded, false);
    const image = { type: "image", mimeType: "image/png", data: Buffer.from("image bytes").toString("base64") };
    session.emit({ sessionUpdate: "user_message_chunk", messageId: "image", content: image });
    // A request/response on the same connection follows the live notification.
    await ws.backends();
    const page = await ws.history(session.agentId);
    const entry = page.entries.find(e => e.kind === "input" && e.content[0].type === "image");
    assert.ok(entry?.kind === "input");
    assert.equal(entry.content[0].data, "");
    const url = new URL(entry.content[0].url as string);
    const fetched = await ws.historyImage(url.searchParams.get("ref")!);
    assert.equal(fetched.data, image.data);
    await assert.rejects(ws.historyImage('{"offset":0}'), /unknown history image/);
  } finally {
    ws?.close();
    await hub.shutdown();
    if (previousHome === undefined) delete process.env.XSB_HOME;
    else process.env.XSB_HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a conversation an earlier version named after xsb's own words is named after the user's again", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xsb-titles-")));
  const previousHome = process.env.XSB_HOME;
  process.env.XSB_HOME = path.join(dir, "home");
  try {
    initProject(new Paths(dir));
    const before = new Hub(dir);
    const session = before.createConversation("codex"), kept = before.createConversation("codex", "分镜"), silent = before.createConversation("codex"), renamed = before.createConversation("codex");
    session.emit({ sessionUpdate: "user_message_chunk", messageId: "m1", content: { type: "text", text: "做一支短片" } });
    session.emit({ sessionUpdate: "user_message_chunk", messageId: "m2", content: { type: "text", text: "继续" } });
    for (const s of [session, silent]) s.save({ title: "[xsb] This conversation had grown long, and goes on in a new session" });
    renamed.save({ title: "[xsb] 用户设置的标题", titleEdited: true });
    const names = (hub: Hub) => [session, kept, silent].map((s) => hub.session(s.id).rec.title);
    assert.deepEqual(names(new Hub(dir)), ["做一支短片", "分镜", undefined]);
    assert.equal(new Hub(dir).session(renamed.id).rec.title, "[xsb] 用户设置的标题", "startup title repair respects a user rename");
  } finally {
    if (previousHome === undefined) delete process.env.XSB_HOME; else process.env.XSB_HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
