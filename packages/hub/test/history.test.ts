import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "@xsb/store";
import { Accepted, Connection, Discarded, History, OriginExt, PROTOCOL_VERSION, assistantOnly, text } from "@xsb/protocol";
import type { HistoryPage, SessionUpdate } from "@xsb/protocol";
import { Paths } from "../src/paths.ts";
import { Workspace } from "../../desktop/src/workspace.ts";
import { Hub } from "../src/hub.ts";
import { initProject } from "../src/config.ts";
import { ops } from "../src/state.ts";
import { historyPage, historyImage, historyFiles, historyUpdate } from "../src/history.ts";
import { adopt, empty } from "../src/workflow-state.ts";

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
    const privateImage = assistantOnly({ ...image, data: Buffer.from("private image").toString("base64") });
    updates.push({ sessionUpdate: "session_info_update", _meta: { [Discarded.key]: { messageId: "d", origin: { kind: "user" }, content: [privateImage, image] } } });
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
    const visibleImages = all.at(-1)._meta[Discarded.key].content;
    assert.equal(visibleImages.length, 1);
    const discarded = visibleImages[0]._meta[History.imageKey];
    assert.equal(discarded.index, 1, "references address the original stored block");
    assert.deepEqual(historyImage(store, "a", discarded), image);
    assert.throws(() => historyImage(store, "a", { ...discarded, index: 0 }), /history image/);
    assert.throws(() => historyImage(store, "a", { ...ref, offset: -1 }));
    assert.throws(() => historyImage(store, "a", { ...ref, offset: 0 }));
    const records = [...store.readBackwardEntries(file, undefined, 7)];
    assert.equal(records.length, updates.length);
    assert.deepEqual(records.map(r => store.readAt(file, r.offset)), records.map(r => r.record));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("history pagination counts visible inputs across runs of model-only deliveries", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-history-audience-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir), file = Paths.transcript("a", "s");
  const append = (messageId: string, body: string, hidden = false) =>
    store.append(file, { update: { sessionUpdate: "user_message_chunk", messageId, content: hidden ? assistantOnly(text(body)) : text(body) } }, false);
  append("old", "older user input");
  for (let i = 0; i < 4; i++) append("internal-" + i, "first hidden run", true);
  append("recent", "first block");
  append("recent", "mixed in hidden block", true);
  append("recent", "second block");
  for (let i = 0; i < 4; i++) append("tail-" + i, "second hidden run", true);
  const page = historyPage(store, "a", "s", undefined, 1);
  assert.deepEqual(page.updates.map(u => u.content.text), ["first block", "second block"]);
  assert.notEqual(page.cursor, null);
  const older = historyPage(store, "a", "s", page.cursor!, 1);
  assert.deepEqual(older.updates.map(u => u.content.text), ["older user input"]);
  assert.equal(older.cursor, null);
});

test("a plain ACP subscriber sees only the workflow assignment title live, on replay and in paged history", async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xsb-acp-audience-")));
  const home = process.env.XSB_HOME;
  process.env.XSB_HOME = path.join(dir, "home");
  const hub = new Hub(dir);
  let client: Connection | undefined;
  t.after(async () => {
    client?.close();
    await hub.shutdown();
    if (home === undefined) delete process.env.XSB_HOME; else process.env.XSB_HOME = home;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await hub.start();
  const owner = hub.createConversation(), node = "整理剧本";
  const flow = empty(owner.id);
  adopt(flow, { graphJsonl: [{ node, requirements: "整理人物表" }, { node: "交付", kind: "end" },
    { from: node, to: "交付" }].map(row => JSON.stringify(row)).join("\n") }, false);
  const worker = hub.createConversation("codex", node, { owner: owner.id, node, bind(agentId, sessionId) {
    Object.assign(flow.instances[node], { agentId, sessionId });
    return ops.workflow(flow);
  } });
  const socket = net.connect(hub.paths.socket("acp"));
  await once(socket, "connect");
  client = new Connection(socket, socket, "ACP audience");
  const updates: SessionUpdate[] = [];
  client.onNotification("session/update", p => { if (p.sessionId === worker.id) updates.push(p.update); });
  await client.request("initialize", { protocolVersion: PROTOCOL_VERSION, info: { name: "subscriber", version: "1" }, capabilities: {} });
  await client.request("session/resume", { sessionId: worker.id });
  updates.length = 0;

  const messageId = "assignment-1", origin = { kind: "system" as const, messageId };
  const title = "开始 " + node;
  const blocks = [{ ...text(title), annotations: { audience: ["user", "assistant"] } }, assistantOnly(text("PRIVATE assignment body"))];
  worker.accept(messageId, origin, blocks);
  for (const content of blocks) worker.emit({ sessionUpdate: "user_message_chunk", messageId, content, _meta: { [OriginExt.key]: origin } });
  // Old workers saved peer inputs without audience annotations and audited model context in transcript metadata.
  worker.emit({ sessionUpdate: "user_message_chunk", messageId: "old-peer", content: text("PRIVATE peer input"),
    _meta: { [OriginExt.key]: { kind: "agent", agentId: owner.agentId, sessionId: owner.id, role: "message" } } });
  worker.emit({ sessionUpdate: "session_info_update", _meta: { "dev.xsb/workflow-log": { context: "PRIVATE older scope" }, "example/status": "ready" } });
  worker.emit({ sessionUpdate: "agent_message_chunk", messageId: "reply", content: text("人物表已整理") });
  const assertView = (view: SessionUpdate[]) => {
    assert.doesNotMatch(JSON.stringify(view), /PRIVATE|dev\.xsb\/workflow-log/);
    const accepted = view.map(u => u._meta?.[Accepted.key] as Accepted | undefined).filter(a => a?.messageId === messageId);
    assert.deepEqual(accepted.map(a => a!.content.map(b => b.text)), [[title]]);
    const input = view.filter(u => u.sessionUpdate === "user_message_chunk");
    assert.deepEqual(input.map(u => [u.messageId, u.content.text]), [[messageId, title]]);
    assert.ok(view.some(u => u._meta?.["example/status"] === "ready"));
    assert.ok(view.some(u => u.sessionUpdate === "agent_message_chunk" && u.content.text === "人物表已整理"));
  };
  const page = await client.request<HistoryPage>(History.page, { sessionId: worker.id });
  assertView(updates);
  assertView(page.updates);
  updates.length = 0;
  await client.request("session/resume", { sessionId: worker.id, replayFrom: { type: "start" } });
  assertView(updates);
  assert.equal(worker.rec.backendSessionId, undefined);

  const oldNotice = JSON.stringify({ escalate: node, message: "PRIVATE controller input", paused: true });
  const oldSystemMessage = { kind: "system", role: "message" };
  const historicalInput = (messageId: string, body: string, from: object) => owner.emit({
    sessionUpdate: "user_message_chunk", messageId, content: text(body), _meta: { [OriginExt.key]: from },
  });
  historicalInput("old-notice", oldNotice, oldSystemMessage);
  historicalInput("old-excerpt", JSON.stringify({ excerpt: oldNotice, context_ref: "ref" }), oldSystemMessage);
  historicalInput("user", oldNotice, { kind: "user" });
  historicalInput("ordinary", "Ordinary system mail", oldSystemMessage);
  const mainHistory = await client.request<HistoryPage>(History.page, { sessionId: owner.id });
  assert.deepEqual(mainHistory.updates.filter(u => u.sessionUpdate === "user_message_chunk").map(u => u.messageId), ["user", "ordinary"]);
});

test("successful native file changes across a conversation survive paging, rename, deletion and retries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-file-history-"));
  try {
    const hub = new Hub(dir);
    const main = hub.createConversation(), worker = hub.createConversation(), other = hub.createConversation();
    const workspace = path.join(dir, "work");
    hub.state.commit([ops.putAgent({ ...hub.agent(worker.agentId), workspace, workflowOwner: main.id, workflowNode: "Write" })]);
    const report = path.join(workspace, "report.md"), final = path.join(workspace, "final.md"), cover = path.join(dir, "cover.png");
    const event = (id: string, fields: object) => ({ sessionUpdate: "tool_call_update", toolCallId: id, ...fields });
    const diff = (changes: object[]) => [{ type: "diff", changes, patch: { format: "git_patch", text: "private patch text" } }];
    const files = () => historyFiles(hub, main.id).files;
    const start = event("write", { name: "Write", kind: "edit", status: "in_progress", content: diff([{ operation: "add", path: report }]) });
    assert.deepEqual(historyUpdate(start, main.id, 0)?.content, [{ type: "diff", changes: [{ operation: "add", path: report }] }]);
    main.emit(start);
    other.emit(event("outside", { status: "completed", content: diff([{ operation: "add", path: cover }]) }));
    worker.emit(event("read", { status: "completed", locations: [{ path: cover }] }));
    worker.emit(event("failed", { status: "failed", content: diff([{ operation: "modify", path: cover }]) }));
    assert.deepEqual(files(), []);
    main.emit(event("write", { status: "completed" }));
    assert.deepEqual(files(), [{ path: report, agentId: main.agentId }]);
    for (const id of ["edit", "edit-again"]) {
      worker.emit(event(id, { name: "Edit", status: "completed", content: diff([{ operation: "modify", path: "report.md" }]) }));
      assert.deepEqual(files(), [{ path: report, agentId: worker.agentId }]);
    }

    worker.emit(event("rename", { status: "completed", content: diff([{ operation: "move", oldPath: "report.md", path: "final.md" }]) }));
    main.emit(event("write", { status: "completed" })); // A repeated terminal update must not resurrect the old path.
    for (let i = 0; i < 14; i++)
      main.emit({ sessionUpdate: "user_message_chunk", messageId: "m" + i, content: { type: "text", text: "later message" } });
    assert.deepEqual(files(), [{ path: final, agentId: worker.agentId }]);
    worker.emit(event("delete", { status: "completed", content: diff([{ operation: "delete", path: final }]) }));
    assert.deepEqual(files(), []);

    const image = event("image", { status: "completed", rawOutput: { status: "completed", savedPath: cover, result: "base64" } });
    main.emit(image);
    assert.deepEqual(historyUpdate(image, main.id, 0)?.rawOutput, { savedPath: cover });
    main.emit(event("inline-image", { status: "completed", rawOutput: { status: "completed", result: "base64" } }));
    main.emit(event("preview", { content: diff([{ operation: "add", path: final }]) }));
    main.emit(event("preview", { status: "completed", content: null }));
    assert.deepEqual(files(), [{ path: cover, agentId: main.agentId }]);

    const notebook = path.join(dir, "work.ipynb");
    main.emit(event("notebook", { name: "NotebookEdit", status: "in_progress" }));
    main.emit(event("notebook", { rawInput: { notebook_path: notebook, new_source: "private cell" } }));
    main.emit(event("notebook", { status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] }));
    const fill = event("fill", { rawInput: { file_path: final, old_string: "", new_string: "private text" } });
    assert.deepEqual(historyUpdate(fill, main.id, 0)?.rawInput, { file_path: final, old_string: "" });
    main.emit(fill);
    main.emit(event("fill", { name: "Edit", status: "completed" }));
    main.emit(event("unchanged", { name: "Write", status: "completed", rawInput: { file_path: report } }));
    main.emit(event("read-notebook", { name: "Read", status: "completed", rawInput: { notebook_path: report } }));
    assert.deepEqual(files(), [cover, notebook, final].map(path => ({ path, agentId: main.agentId })));
    assert.deepEqual(historyFiles(new Hub(dir), main.id).files, files());
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
