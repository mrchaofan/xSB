import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { Paths } from "@xsb/hub";
import { Workflow, Agents, Connection, ConversationEvent, History, Question, RunExt, Tasks } from "@xsb/protocol";
import { address } from "../src/address.ts";
import { Driven } from "../src/browser.ts";
import { Workspace } from "../src/workspace.ts";
import type { Notice } from "../src/workspace.ts";

const agent = (id: string) => ({ id, name: id, workspace: "/tmp", backend: "mock", description: "old", state: "idle" });
class Peer {
  notifications = new Map();
  requests = new Map();
  isClosed = false;
  closed = new Promise(() => {});
  onNotification(name: string, fn: Function) {
    this.notifications.set(name, fn);
  }
  onRequest(name: string, fn: Function) {
    this.requests.set(name, fn);
  }
  emit(name: string, params: object) {
    this.notifications.get(name)?.(params);
  }
  async request(name: string, params?: any) {
    return this.requests.get(name)?.(params) ?? {};
  }
  close() {
    this.isClosed = true;
  }
}
function workspace(peer: Peer, notify: (notice: Notice) => void = () => {}) {
  return new Workspace(
    new Paths("/tmp/xsb-desktop-review"),
    peer,
    (e) => e.message,
    () => {},
    notify,
  );
}
function snapshot(peer: Peer, agents = []) {
  peer.requests.set(Workflow.list, () => ({ workflows: [] }));
  peer.requests.set(Agents.list, () => ({ agents }));
  peer.requests.set(Tasks.list, () => ({ tasks: [] }));
}

test("node controls carry the workflow session and selected node names", async () => {
  const peer = new Peer(), ws = workspace(peer);
  const calls = [];
  peer.requests.set(Workflow.pause, params => calls.push(params));
  peer.requests.set(Workflow.rollback, params => calls.push(params));
  await ws.workflowControl("main",true,["A"]);
  await ws.workflowControl("main","rollback",["B"]);
  await ws.workflowControl("main","rollback");
  assert.deepEqual(calls,[{sessionId:"main",nodes:["A"]}, {sessionId:"main",nodes:["B"]}, {sessionId:"main",nodes:undefined}]);
  ws.close();
});

test("tool status patches retain input/output and the original tool description", async () => {
  const peer = new Peer(); snapshot(peer, [agent("a")]);
  const ws = workspace(peer); await ws.load(); ws["sessionAgent"].set("s", "a");
  const emit = (update: object) => peer.emit("session/update", { sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "c", ...update } });
  emit({ title: "Read files\nFull command", name: "read", status: "in_progress", rawInput: { paths: ["a.ts"] } });
  emit({ status: "completed", rawOutput: { count: 1 } });
  const tool = ws["transcripts"].get("a").find(e => e.kind === "tool");
  assert.equal(tool.title, "Read files\nFull command");
  assert.equal(tool.name, "read");
  assert.equal(tool.status, "done");
  assert.deepEqual(tool.input, { paths: ["a.ts"] });
  assert.deepEqual(tool.output, { count: 1 });
  ws.close();
});

test("successful backend file operations and saved images are linked by call ID without treating reads as edits", async () => {
  const peer = new Peer();
  snapshot(peer, [{ ...agent("a"), mainSessionId: "main" }]);
  peer.requests.set(History.page, () => ({ updates: [], cursor: null, agent: { ...agent("a"), mainSessionId: "main" } }));
  const events = [];
  const ws = new Workspace(new Paths("/tmp/xsb-file-events"), peer, String, event => events.push(event), () => {});
  await ws.load();
  const emit = (toolCallId, fields) => peer.emit("session/update", { sessionId: "main", update: { sessionUpdate: "tool_call_update", toolCallId, ...fields } });
  const refreshes = () => events.filter(event => event.filesChanged === "main").length;
  const file = "/tmp/海报 #1.png", next = "/tmp/final.png";
  emit("r", { title: "Read", kind: "read", status: "completed", locations: [{ path: file }] });
  emit("edit", { title: "Edit", status: "in_progress", content: [{ type: "diff", changes: [
    { operation: "add", path: file }, { operation: "move", oldPath: file, path: next }, { operation: "delete", path: "/tmp/old.txt" },
  ] }] });
  emit("no", { status: "failed", content: [{ type: "diff", changes: [{ operation: "modify", path: next }] }] });
  assert.equal(refreshes(), 0);
  emit("edit", { status: "completed" });
  const edit = ws["transcripts"].get("a").find(entry => entry.id === "main:edit");
  assert.equal(edit.status, "done");
  assert.deepEqual(edit.changes.map(change => change.operation), ["add", "move", "delete"]);
  assert.ok(edit.changes[0].uri.includes("%231.png"));
  assert.equal(edit.changes[1].oldPath, file);
  assert.equal(refreshes(), 1);
  emit("edit", { status: "completed" });
  assert.equal(refreshes(), 1);
  emit("image", { status: "in_progress", rawOutput: { savedPath: next } });
  emit("image", { status: "completed" });
  assert.equal(ws["transcripts"].get("a").find(entry => entry.id === "main:image").savedFile.path, next);
  assert.equal(refreshes(), 2);
  emit("empty", { status: "completed", rawOutput: { result: "aW1hZ2U=" } });
  assert.equal(refreshes(), 2);
  emit("edit", { content: null });
  assert.equal(refreshes(), 3);
  emit("notebook", { name: "NotebookEdit", kind: "other", rawInput: { notebook_path: file } });
  emit("notebook", { status: "completed" });
  assert.equal(refreshes(), 4);
  assert.equal(ws["transcripts"].get("a").find(entry => entry.id === "main:notebook").savedFile.path, file);
  emit("notebook", { status: "completed" });
  assert.equal(refreshes(), 4);
  ws["rebuildHistory"]("a");
  assert.equal(refreshes(), 4);
  ws.close();
});

test("Files refreshes for edits completed before a task attached or started before its first history page", async () => {
  const peer = new Peer(), main = { ...agent("main"), mainSessionId: "owner" };
  const worker = { ...agent("worker"), mainSessionId: "task-session", workflowOwner: "owner", state: "running" };
  snapshot(peer, [main]);
  const taskPage = Promise.withResolvers();
  const start = (id, path) => ({ sessionUpdate: "tool_call_update", toolCallId: id, kind: "edit", status: "in_progress",
    content: [{ type: "diff", changes: [{ operation: "add", path }] }] });
  const done = id => ({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
  peer.requests.set(History.page, ({ sessionId, before }) => {
    if (sessionId === "owner") return { updates: [], cursor: null, agent: main };
    if (before === undefined) return taskPage.promise;
    return { updates: [start("earlier", "/tmp/earlier.md")], cursor: null, agent: worker };
  });
  const events = [];
  const ws = new Workspace(new Paths("/tmp/xsb-file-events"), peer, String, event => events.push(event), () => {});
  await ws.load();
  const refreshes = () => events.filter(event => event.filesChanged === "owner").length;
  peer.emit(Agents.update, { agent: worker });
  taskPage.resolve({ updates: [start("attached", "/tmp/one.md"), done("attached")], cursor: 10, agent: worker });
  await ws["mains"].get("worker");
  assert.equal(refreshes(), 1, "one owner refresh covers the whole initial replay");
  const emit = update => peer.emit("session/update", { sessionId: worker.mainSessionId, update });
  emit({ sessionUpdate: "tool_call_update", toolCallId: "read", kind: "read", status: "in_progress" });
  emit(done("read"));
  assert.equal(refreshes(), 1, "a known read has no file operation");
  emit(done("earlier"));
  emit(done("earlier"));
  assert.equal(refreshes(), 2, "a completion without its older diff refreshes once");
  const entry = () => ws["transcripts"].get(worker.id).find(entry => entry.id === "task-session:earlier");
  assert.equal(entry().changes, undefined, "the transcript does not invent a file change");
  await ws.history(worker.id);
  assert.equal(entry().changes[0].path, "/tmp/earlier.md");
  assert.equal(refreshes(), 2, "pagination replays the diff without another file-list refresh");
  ws.close();
});

test("a native form arriving before the first snapshot waits for session mapping and answers via its request", async () => {
  const peer = new Peer(); snapshot(peer, [{ ...agent("a"), mainSessionId: "s" }]);
  const ws = workspace(peer), abort = new AbortController();
  const request = { sessionId: "s", mode: "form", message: "Choose", requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["A", "B"] } } }, _meta: { [Question.key]: { id: "native" } } };
  const response = peer.requests.get("elicitation/create")(request, { signal: abort.signal });
  await ws.load();
  peer.emit("session/update", { sessionId: "s", update: { sessionUpdate: "session_info_update", _meta: { [Question.key]: { id: "native", source: "acp", state: "open", questions: [{ question: "Choose", kind: "single", options: ["A", "B"] }] } } } });
  ws.answerQuestion("a", { questionId: "native", answers: ["B"] });
  assert.deepEqual(await response, { action: "accept", content: { choice: "B" } });
  ws.close();
});

test("parallel native forms retain independent callbacks across idle and ordinary chat; stale replies cannot enter the outbox", async t => {
  const { peer, open } = sending(t);
  const ws = open(), sent: string[] = [];
  await ws.load();
  peer.requests.set("session/prompt", p => { sent.push(p.prompt[0].text); return { messageId: "u" }; });
  const request = (id: string, abort: AbortController) => peer.requests.get("elicitation/create")({
    sessionId: "s", mode: "form", message: id, _meta: { [Question.key]: { id }, codex: { delivery: "async" } },
    requestedSchema: { type: "object", properties: { answer: { type: "string" } } },
  }, { signal: abort.signal });
  const first = new AbortController();
  const a = request("q1", first), b = request("q2", new AbortController());
  await ws.send("a", [{ type: "text", text: "Independent input" }]);
  peer.emit("session/update", { sessionId: "s", update: { sessionUpdate: "state_update", state: "idle" } });
  ws["rebuildHistory"]("a");
  assert.equal(ws["transcripts"].get("a")!.filter(e => e.kind === "question" && e.answerable).length, 2);
  assert.throws(() => ws.answerQuestion("wrong", { questionId: "q2", skipped: true }), /expired/);
  ws.answerQuestion("a", { questionId: "q2", answers: ["B"] });
  assert.deepEqual(await b, { action: "accept", content: { answer: "B" } });
  first.abort();
  assert.deepEqual(await a, { action: "cancel" });
  assert.throws(() => ws.answerQuestion("a", { questionId: "q1", skipped: true }), /expired/);
  assert.deepEqual(sent, ["Independent input"]);
  assert.equal(Object.keys(ws["readOutbox"]()).length, 1, "only the ordinary input went to the outbox");
  ws.close();
});

test("terminal async records and historical ask cards replay without creating answer callbacks", async t => {
  const { peer, open } = sending(t);
  const questions = [{ question: "Which database?", kind: "single", options: ["SQLite"] }];
  const update = (record: object) => ({ sessionUpdate: "session_info_update", _meta: { [Question.key]: record } });
  peer.requests.set(History.page, () => ({ agent: { ...agent("a"), mainSessionId: "s" }, updates: [
    update({ id: "legacy", state: "open", questions }),
    update({ id: "legacy", state: "answered", answers: ["SQLite"] }),
    update({ id: "async", source: "acp", delivery: "async", state: "answered", answers: ["SQLite"], questions }),
  ] }));
  const ws = open();
  const entries = (await ws.load()).transcripts.a.filter(e => e.kind === "question");
  assert.deepEqual(entries.map(e => [e.questionId, e.questions[0].question, e.answers, e.answerable]), [
    ["legacy", "Which database?", ["SQLite"], false], ["async", "Which database?", ["SQLite"], false],
  ]);
  for (const entry of entries) assert.throws(() => ws.answerQuestion("a", { questionId: entry.questionId, skipped: true }), /expired/);
  ws.close();
});

test("both address entry points share web and local-file normalization", () => {
  assert.equal(address(" example.com "), "https://example.com/");
  assert.equal(address("localhost:3000/a"), "http://localhost:3000/a");
  assert.equal(address("example.com:8080/a"), "https://example.com:8080/a");
  assert.equal(address("localhost:3000?q=a"), "http://localhost:3000/?q=a");
  assert.equal(address("[::1]:8080"), "http://[::1]:8080/");
  assert.equal(address("file:///tmp/a%20b.html"), "file:///tmp/a%20b.html");
  assert.equal(address("/tmp/a b.html"), "file:///tmp/a%20b.html");
  for (const url of ["", "javascript:alert(1)", "data:text/plain,a", "ftp://example.com", "https://", "a b"]) assert.throws(() => address(url));
});

test("agent idle and removal events during loading win over the earlier list", async () => {
  const peer = new Peer();
  snapshot(peer, [{ ...agent("a"), state: "running" }, agent("b")]);
  peer.requests.set(Workflow.list, async () => {
    await new Promise((resolve) => setTimeout(resolve));
    peer.emit(Agents.update, { agent: agent("a") });
    peer.emit(Agents.removed, { id: "b" });
    return { workflows: [] };
  });
  const ws = workspace(peer);
  const loaded = await ws.load();
  assert.deepEqual(loaded.agents.map(a => [a.id, a.state]), [["a", "idle"]]);
  assert.deepEqual(ws.working(), []);
  ws.close();
});

test("reloading replaces missing agents and tasks instead of retaining phantom work", async () => {
  const peer = new Peer();
  snapshot(peer, [agent("a"), { ...agent("b"), state: "running" }]);
  peer.requests.set(Tasks.list, () => ({ tasks: [{ id: "job", status: "running", tool: { name: "render" }, to: { agentId: "a" } }] }));
  const ws = workspace(peer);
  await ws.load();
  assert.deepEqual(ws.working().sort(), ["a", "b"]);
  snapshot(peer, [agent("a")]);
  const loaded = await ws.load();
  assert.deepEqual(loaded.agents.map(a => a.id), ["a"]);
  assert.deepEqual(loaded.tasks, []);
  assert.deepEqual(ws.working(), []);
  ws.close();
});

test("coalesced RPC responses and later notifications cannot restore busy snapshots", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const conn = new Connection(input, output);
  const responses = [];
  const task = { id: "t", status: "running", to: { agentId: "a" } };
  const lists = {
    [Workflow.list]: { workflows: [] },
    [Agents.list]: { agents: [{ ...agent("a"), state: "running" }, agent("b")] },
    [Tasks.list]: { tasks: [task] },
  };
  output.on("data", chunk => {
    const request = JSON.parse(chunk.toString());
    responses.push({ jsonrpc: "2.0", id: request.id, result: lists[request.method] });
  });
  const ws = workspace(conn);
  const loaded = ws.load();
  input.write([...responses,
    { jsonrpc: "2.0", method: Agents.update, params: { agent: agent("a") } },
    { jsonrpc: "2.0", method: Agents.removed, params: { id: "b" } },
    { jsonrpc: "2.0", method: Tasks.update, params: { task: { ...task, status: "completed" } } },
  ].map(message => JSON.stringify(message) + "\n").join(""));
  const snapshot = await loaded;
  assert.deepEqual(snapshot.agents.map(a => [a.id, a.state]), [["a", "idle"]]);
  assert.equal(snapshot.tasks[0].status, "completed");
  assert.deepEqual(ws.working(), []);
  ws.close();
});

test("history failures are visible in the agent transcript", async () => {
  const peer = new Peer();
  snapshot(peer, [{ ...agent("a"), mainSessionId: "main-a" }]);
  peer.requests.set(History.page, () => {
    throw new Error("history unavailable");
  });
  const ws = workspace(peer);
  assert.equal((await ws.load()).transcripts.a[0].text, "history unavailable");
  ws.close();
});

test("idle after an abnormal end clears waiting, streaming output and unfinished tools", async () => {
  const peer = new Peer();
  snapshot(peer, [agent("a")]);
  const ws = workspace(peer);
  await ws.load();
  ws["sessionAgent"].set("s", "a");
  peer.emit("session/update", { sessionId: "s", update: { sessionUpdate: "state_update", state: "running" } });
  peer.emit("session/update", { sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "c", status: "in_progress" } });
  peer.emit("session/update", { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } } });
  peer.emit("session/update", { sessionId: "s", update: { sessionUpdate: "state_update", state: "idle", stopReason: "error" } });
  assert.deepEqual(ws.working(), []);
  assert.equal(ws["activities"].has("a"), false);
  assert.equal(ws["agents"].get("a").state, "idle");
  assert.equal(ws["transcripts"].get("a").find(e => e.kind === "output").streaming, false);
  assert.equal(ws["transcripts"].get("a").find(e => e.kind === "tool").status, "failed");
  ws.close();
});

test("execution outside a turn streams and settles without changing activity, agent state or notifications", async () => {
  const peer = new Peer(), notices: Notice[] = [];
  snapshot(peer, [agent("a")]);
  const ws = workspace(peer, notice => notices.push(notice));
  await ws.load();
  ws["sessionAgent"].set("s", "a");
  const run = { id: "background", turnId: null, state: "running" };
  const update = (sessionUpdate: string, data = {}, meta = run) => peer.emit("session/update", { sessionId: "s", update: { sessionUpdate, ...data, _meta: { [RunExt.key]: meta } } });
  update("session_info_update");
  update("agent_thought_chunk");
  update("tool_call_update", { toolCallId: "bg", status: "completed" });
  update("agent_message_chunk", { content: { type: "text", text: "background " } });
  update("agent_message_chunk", { content: { type: "text", text: "result" } });
  assert.deepEqual(ws.working(), []);
  assert.equal(ws["activities"].has("a"), false);
  assert.equal(ws["transcripts"].get("a").find(e => e.kind === "output").streaming, true);
  const end = { ...run, state: "idle", stopReason: "end_turn", origin: { kind: "task-notification" } };
  update("session_info_update", {}, end);
  const output = ws["transcripts"].get("a").find(e => e.kind === "output");
  assert.equal(output.streaming, false);
  assert.equal(output.content[0].text, "background result");
  assert.equal(output.stopReason, "end_turn");
  assert.deepEqual(output.runOrigin, end.origin);
  // A final chunk flushed after idle is settled immediately, too.
  update("agent_message_chunk", { content: { type: "text", text: "tail" } }, end);
  assert.ok(ws["transcripts"].get("a").filter(e => e.kind === "output").every(e => !e.streaming));
  assert.deepEqual(notices, []);
  assert.equal(ws["agents"].get("a").state, "idle");
  ws.close();
});

test("claiming a backend run keeps earlier output separate and its end settles all owner segments", async () => {
  const peer = new Peer();
  snapshot(peer, [agent("a")]);
  const ws = workspace(peer);
  await ws.load();
  ws["sessionAgent"].set("s", "a");
  const update = (run, text?: string) => peer.emit("session/update", { sessionId: "s", update: {
    sessionUpdate: text ? "agent_message_chunk" : "session_info_update", ...(text ? { content: { type: "text", text } } : {}), _meta: { [RunExt.key]: run },
  } });
  const unowned = { id: "run", turnId: null, state: "running" }, owned = { ...unowned, turnId: "turn" };
  update(unowned); update(unowned, "earlier output");
  update(owned); update(owned, "owned answer");
  assert.equal(ws["activities"].get("a").kind, "writing");
  const entries = ws["transcripts"].get("a").filter(e => e.kind === "output");
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => e.run.turnId), [null, "turn"]);
  assert.equal(entries[0].streaming, false);
  update({ ...owned, state: "idle", stopReason: "end_turn" });
  assert.ok(ws["transcripts"].get("a").filter(e => e.kind === "output").every(e => !e.streaming));
  ws.close();
});

test("history replays autonomous run ownership and endings identically to live output", async () => {
  const peer = new Peer(), a = { ...agent("a"), mainSessionId: "s" };
  snapshot(peer, [a]);
  const run = { id: "historic-run", turnId: null, state: "running" };
  peer.requests.set(History.page, () => ({ updates: [
    { sessionUpdate: "session_info_update", _meta: { [RunExt.key]: run } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "background history" }, _meta: { [RunExt.key]: run } },
    { sessionUpdate: "session_info_update", _meta: { [RunExt.key]: { ...run, state: "idle", stopReason: "end_turn" } } },
  ], cursor: null, state: "idle", agent: a }));
  const ws = workspace(peer), loaded = await ws.load();
  assert.deepEqual(loaded.transcripts.a[0].run, { id: "historic-run", turnId: null });
  assert.equal(loaded.transcripts.a[0].streaming, false);
  assert.equal(loaded.transcripts.a[0].stopReason, "end_turn");
  assert.deepEqual(loaded.activities, {});
  ws.close();
});

test("older pages preserve live updates and do not restore historical waiting", async () => {
  const peer = new Peer();
  const a = { ...agent("a"), mainSessionId: "s" };
  snapshot(peer, [a]);
  let resolvePage;
  const input = (id, text) => ({ sessionUpdate: "user_message_chunk", messageId: id, content: { type: "text", text } });
  peer.requests.set(History.page, ({ before }) => before === undefined
    ? { updates: [input("new", "new")], cursor: 10, state: "idle", agent: a }
    : new Promise(resolve => resolvePage = resolve));
  const ws = workspace(peer);
  const loaded = await ws.load();
  assert.equal(loaded.history.a, 10);
  assert.deepEqual(loaded.activities, {});
  const older = ws.history("a");
  assert.equal(ws.history("a"), older);
  peer.emit("session/update", { sessionId: "s", update: { sessionUpdate: "state_update", state: "running" } });
  peer.emit("session/update", { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "live" } } });
  resolvePage({ updates: [input("old", "old"), { sessionUpdate: "state_update", state: "idle" }], cursor: null, agent: a, state: "idle" });
  const page = await older;
  assert.deepEqual(page.entries.filter(e => e.kind === "input").map(e => e.content[0].text), ["old", "new"]);
  assert.equal(page.entries.find(e => e.kind === "output").content[0].text, "live");
  assert.equal(ws["agents"].get("a").state, "running");
  assert.equal(ws["activities"].get("a").kind, "writing");
  peer.emit("session/update", { sessionId: "s", update: { sessionUpdate: "state_update", state: "idle" } });
  assert.deepEqual(ws.working(), []);
  ws.close();
});

test("published entries project by source and stable ID in ledger order without waking the agent", async () => {
  const peer = new Peer(), a = { ...agent("a"), mainSessionId: "s" };
  snapshot(peer, [a]);
  const event = { schemaVersion: 1, source: { kind: "plugin", id: "example", label: "Example" }, id: "posted", sessionId: "s",
    markdown: "complete".repeat(3000) };
  const info = (value: unknown) => ({ sessionUpdate: "session_info_update", _meta: { [ConversationEvent.key]: value } });
  const output = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const legacy = { sessionUpdate: "user_message_chunk", messageId: "earlier", _meta: { [OriginExt.key]: { kind: "system" } },
    content: { type: "text", text: JSON.stringify({ completed: "End", version: "plan-1", predecessors: [] }) } };
  peer.requests.set(History.page, ({ before }) => before === undefined ? { updates: [], cursor: 50, agent: a }
    : { updates: [legacy, output("historical answer")], cursor: null, agent: a });
  const ws = workspace(peer);
  await ws.load();
  const emit = update => peer.emit("session/update", { sessionId: "s", update });
  for (const change of [{ schemaVersion: 2 }, { source: "agent" }, { sessionId: "other" }]) emit(info({ ...event, ...change }));
  emit(info(event));
  assert.deepEqual(ws["transcripts"].get("a").map(e => e.kind), ["publication"]);
  assert.deepEqual(ws.working(), []);
  assert.equal(ws["activities"].size, 0);

  // A result arriving during an unrelated reply occupies its own position without affecting the run.
  emit(output("before"));
  const second = { ...event, source: { ...event.source, id: "other", label: "Other" } };
  emit(info(second));
  emit(output("after"));
  emit(info(second));
  const withdrawal = { ...event, withdrawn: true, markdown: "Result withdrawn\n\n" + event.markdown };
  emit(info(withdrawal));
  emit(info(event));
  emit(output("!"));
  const page = await ws.history("a");
  assert.deepEqual(page.entries.map(e => e.kind === "publication" ? e.source.id : e.content[0].text),
    ["historical answer", event.source.id, "before", second.source.id, "after!"]);
  assert.equal(page.entries[1].markdown, withdrawal.markdown, "withdrawal replaces the original in place and survives replay");
  assert.equal(page.entries[1].withdrawn, true);
  assert.deepEqual(page.entries[1].source, event.source);
  ws.close();
});

test("live work arriving with the first page wins over that page's idle snapshot", async () => {
  const peer = new Peer();
  const a = { ...agent("a"), mainSessionId: "s" };
  snapshot(peer, [a]);
  peer.requests.set(History.page, () => {
    peer.emit("session/update", { sessionId: "s", update: { sessionUpdate: "state_update", state: "running" } });
    peer.emit("session/update", { sessionId: "s", update: { sessionUpdate: "user_message_chunk", messageId: "live", content: { type: "text", text: "live input" } } });
    return { updates: [], cursor: null, agent: a, state: "idle" };
  });
  const ws = workspace(peer);
  const loaded = await ws.load();
  assert.equal(loaded.agents[0].state, "running");
  assert.equal(loaded.transcripts.a[0].content[0].text, "live input");
  ws.close();
});

test("long snapshot parts retain their content and all element refs despite page changes", async () => {
  let captures = 0;
  const clicked = [];
  const contents = {
    debugger: {
      attach() {},
      isAttached: () => false,
      async sendCommand(method, params) {
        if (method === "Accessibility.getFullAXTree") {
          captures++;
          return {
            nodes: [
              { nodeId: "root", childIds: ["first", "text", "last"] },
              { nodeId: "first", role: { value: "button" }, name: { value: captures === 1 ? "First" : "Changed" }, backendDOMNodeId: captures === 1 ? 10 : 30 },
              { nodeId: "text", role: { value: "StaticText" }, name: { value: "x".repeat(21000) } },
              { nodeId: "last", role: { value: "button" }, name: { value: "Last" }, backendDOMNodeId: 20 },
            ],
          };
        }
        if (method === "DOM.scrollIntoViewIfNeeded") clicked.push(params.backendNodeId);
        if (method === "DOM.getContentQuads") return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] };
        return {};
      },
    },
    getTitle: () => "Long page",
    getURL: () => "https://example.com/",
    isLoading: () => false,
  };
  const driven = new Driven(contents, () => {});
  assert.match(await driven.snapshot(), /"from": 20000/);
  assert.match(await driven.snapshot(20000), /\[2\] button "Last"/);
  assert.equal(captures, 1);
  await driven.click(1);
  await driven.click(2);
  assert.deepEqual(clicked, [10, 20]);
  assert.match(await driven.snapshot(0), /Changed/);
  assert.equal(captures, 2);
  await assert.rejects(driven.snapshot(-1), /non-negative/);
});

test("awaited jobs count as work even between idle agent turns", async () => {
  const peer = new Peer();
  snapshot(peer, [agent("a")]);
  peer.requests.set(Tasks.list, () => ({ tasks: [{ id: "job", status: "running", tool: { name: "render" }, from: { agentId: "a" }, to: { agentId: "a" } }] }));
  const ws = workspace(peer);
  await ws.load();
  ws.setShown(false);
  assert.deepEqual(ws.working(), ["a"]);
  peer.isClosed = true;
  assert.deepEqual(ws.working(), []);
  ws.close();
});

test("task history of a removed agent does not count as current work", async () => {
  const peer = new Peer();
  snapshot(peer, [agent("a")]);
  peer.requests.set(Tasks.list, () => ({ tasks: [{ id: "task", status: "running", to: { agentId: "a" } }] }));
  const ws = workspace(peer);
  await ws.load();
  assert.deepEqual(ws.working(), ["a"]);
  peer.emit(Agents.removed, { id: "a" });
  assert.deepEqual(ws.working(), []);
  assert.equal(ws["tasks"].has("task"), true);
  ws.close();
});

test("the user is told when the work is done, failed, or waits for them", async () => {
  const peer = new Peer();
  snapshot(peer, [agent("a"), agent("b")]);
  const notices: string[] = [];
  const ws = workspace(peer, (n) => notices.push(`${n.kind} ${n.name} ${n.detail}`.trim()));
  await ws.load();
  const task = { id: "t1", title: "draw", from: { agentId: "a" }, to: { agentId: "b" }, status: "running" };

  // The work goes through two agents; it is done when the last of them stops and no task is open.
  peer.emit(Agents.update, { agent: { ...agent("a"), state: "running" } });
  peer.emit(Tasks.update, { task });
  peer.emit(Agents.update, { agent: agent("a") });
  assert.deepEqual(notices, []);
  peer.emit(Tasks.update, { task: { ...task, status: "failed" } });
  peer.emit(Tasks.update, { task: { ...task, status: "failed", result: "again" } });
  assert.deepEqual(notices, ["failed b draw", "done b"]);

  // An agent that asks the user, or one the user stopped, going quiet is no news of its own.
  notices.length = 0;
  peer.emit(Agents.update, { agent: { ...agent("a"), state: "running" } });
  peer.emit(Agents.asks, { agentId: "a", question: "Which cast?" });
  peer.emit(Agents.update, { agent: agent("a") });
  peer.emit(Agents.update, { agent: { ...agent("a"), state: "running" } });
  await ws.cancel("a");
  peer.emit(Agents.update, { agent: agent("a") });
  assert.deepEqual(notices, ["confirm a Which cast?"]);

  // A permission request is asked of the user.
  notices.length = 0;
  ws["sessionAgent"].set("s-a", "a");
  void peer.requests.get("session/request_permission")({ sessionId: "s-a", title: "rm -rf build", subject: { type: "tool_call", toolCall: { toolCallId: "c", title: "rm -rf build" } }, options: [] });
  assert.deepEqual(notices, ["permission a rm -rf build"]);
  ws.close();
});

// ---- what the user sees of a message is what became of it ---------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Accepted, Discarded, Ledger, MessageDelivery, OriginExt, Redelivered } from "@xsb/protocol";

function sending(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-outbox-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const peer = new Peer();
  snapshot(peer, [{ ...agent("a"), mainSessionId: "s" }] as any);
  peer.requests.set(History.page, () => ({ updates: [], cursor: null, state: "idle", agent: { ...agent("a"), mainSessionId: "s" } }));
  const open = () => new Workspace(new Paths(dir), peer as any, (e) => e.message, () => {}, () => {});
  return { dir, peer, open };
}
const inputs = (snap: any) => snap.transcripts.a.filter((e: any) => e.kind === "input");

test("assistant-only input stays out of the task chat while queued, inserted, or discarded", async (t) => {
  const { peer, open } = sending(t);
  const ws = open();
  await ws.load();
  const update = (change: object) => peer.emit("session/update", { sessionId: "s", update: change });
  const info = (key: string, value: object) => update({ sessionUpdate: "session_info_update", _meta: { [key]: value } });
  const internal = { type: "text", text: "resume the saved assignment", annotations: { audience: ["assistant"] } };
  const visible = { type: "text", text: "Use the earlier date." };
  const system = { kind: "system" }, user = { kind: "user" };
  const chunk = (messageId: string, origin: object, content: object) =>
    update({ sessionUpdate: "user_message_chunk", messageId, content, _meta: { [OriginExt.key]: origin } });
  info(Accepted.key, { messageId: "task", origin: system, content: [internal] });
  info(MessageDelivery.key, { messageId: "task", state: "queued", isHead: true, canSendNow: true });
  chunk("task", system, internal);
  info(Discarded.key, { messageId: "cancelled", origin: system, content: [internal], reason: "expired" });
  assert.deepEqual(inputs(await ws.load()), []);

  info(Accepted.key, { messageId: "correction", origin: user, content: [internal, visible] });
  assert.deepEqual(inputs(await ws.load()).map(entry => entry.content), [[visible]]);
  chunk("correction", user, internal);
  chunk("correction", user, visible);
  const [received] = inputs(await ws.load());
  assert.deepEqual(received.content, [visible]);
  assert.ok(!received.pending);
  ws.close();
});

test("a message xsb did not take stays in the transcript, marked, and after a restart is still there to send again under its id", async (t) => {
  const { peer, open } = sending(t);
  const ws = open();
  await ws.load();
  const sent: any[] = [];
  peer.requests.set("session/prompt", (p: any) => { sent.push(p._meta[OriginExt.key]); throw new Error("connection lost"); });
  await ws.send("a", [{ type: "text", text: "hello" }]);
  let [entry] = inputs(await ws.load());
  assert.equal(entry.unsent, true, "not deleted: marked as not delivered");
  assert.equal(entry.detail, "connection lost");
  ws.close();
  // After a restart the hub is asked: it never got it, so it is shown again, and sent again under the same id.
  peer.requests.set(Ledger.status, (p: any) => ({ states: Object.fromEntries(p.messageIds.map((id: string) => [id, "unknown"])) }));
  const again = open();
  [entry] = inputs(await again.load());
  assert.equal(entry.unsent, true);
  peer.requests.set("session/prompt", (p: any) => { sent.push(p._meta[OriginExt.key]); return { messageId: p._meta[OriginExt.key].messageId }; });
  await again.resend("a", entry.id);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[1].messageId, sent[0].messageId, "explicit resend is a new input");
  again.close();
});

test("a message xsb recorded follows its records: waiting, owed, given later, and never appended to itself", async (t) => {
  const { peer, open } = sending(t);
  const ws = open();
  await ws.load();
  const update = (u: any) => peer.emit("session/update", { sessionId: "s", update: u });
  const info = (key: string, value: any) => update({ sessionUpdate: "session_info_update", _meta: { [key]: value } });
  const said = [{ type: "text", text: "first" }];
  info(Accepted.key, { messageId: "m1", origin: { kind: "user", messageId: "m1" }, content: said });
  let [entry] = inputs(await ws.load());
  assert.equal(entry.pending, true, "waiting");
  info(Discarded.key, { messageId: "m1", origin: { kind: "user" }, content: [], reason: "failed", detail: "rate limited", owed: true });
  [entry] = inputs(await ws.load());
  assert.deepEqual([entry.discarded, entry.owed, entry.reason, entry.content], [true, true, "failed", said], "kept, with its content, and why");
  info(Redelivered.key, { messageIds: ["m1"], with: "m2" });
  [entry] = inputs(await ws.load());
  assert.equal(entry.redelivered, true);
  info(Accepted.key, { messageId: "m3", origin: { kind: "user", messageId: "m3" }, content: [{ type: "text", text: "third" }] });
  update({ sessionUpdate: "user_message_chunk", messageId: "m3", content: { type: "text", text: "third" }, _meta: { [OriginExt.key]: { kind: "user" } } });
  const third = inputs(await ws.load()).find((e: any) => e.id === "s:m3");
  assert.deepEqual(third.content, [{ type: "text", text: "third" }], "the waiting entry became the one in the conversation");
  assert.ok(!third.pending);
  ws.close();
});

test("standard tool starts and split UTF-8 terminal bytes update a tool without changing foreground activity", async () => {
  const peer = new Peer(); snapshot(peer, [agent("a")]);
  const ws = workspace(peer); await ws.load(); ws["sessionAgent"].set("s", "a");
  const emit = update => peer.emit("session/update", { sessionId: "s", update });
  emit({ sessionUpdate: "tool_call", toolCallId: "c", title: "Run command", status: "in_progress", content: [{ type: "terminal", terminalId: "terminal" }] });
  const bytes = Buffer.from("输出");
  emit({ sessionUpdate: "terminal_output_chunk", terminalId: "terminal", data: bytes.subarray(0, 2).toString("base64") });
  emit({ sessionUpdate: "terminal_output_chunk", terminalId: "terminal", data: bytes.subarray(2).toString("base64") });
  let tool = ws["transcripts"].get("a").find(e => e.kind === "tool");
  assert.equal(tool.title, "Run command"); assert.equal(tool.terminalOutput, "输出");
  emit({ sessionUpdate: "terminal_update", terminalId: "terminal", output: { data: Buffer.from("snapshot").toString("base64") }, exitStatus: { exitCode: 0 } });
  tool = ws["transcripts"].get("a").find(e => e.kind === "tool");
  assert.equal(tool.terminalOutput, "snapshot", "snapshot replaces rather than duplicates prior chunks");
  ws.close();
});

test("idle does not fail background tool cards, including opaque terminal IDs distinct from tool IDs", async () => {
  const peer = new Peer(); snapshot(peer, [{ ...agent("a"), mainSessionId: "s" }]);
  const ws = workspace(peer); await ws.load(); ws["sessionAgent"].set("s", "a");
  const emit = update => peer.emit("session/update", { sessionId: "s", update });
  emit({ sessionUpdate: "tool_call", toolCallId: "call:opaque", title: "Independent work", status: "in_progress", content: [{ type: "terminal", terminalId: "terminal:opaque" }] });
  emit({ sessionUpdate: "state_update", state: "idle", background: [{ type: "terminal", terminalId: "terminal:opaque" }] });
  const tool = ws["transcripts"].get("a").find(e => e.kind === "tool");
  assert.equal(tool.status, "running");
  assert.equal(ws["activities"].get("a"), undefined);
  ws.close();
});

test("queued input projects user controls and in-flight input cannot be cancelled as queued", async t => {
  const { peer, open } = sending(t);
  const ws = open(); await ws.load();
  const info = (key: string, value: any) => peer.emit("session/update", { sessionId: "s", update: { sessionUpdate: "session_info_update", _meta: { [key]: value } } });
  for (const id of ["q1", "q2"]) info(Accepted.key, { messageId: id, origin: { kind: "agent", agentId: "b", sessionId: "sb" }, content: [{ type: "text", text: id }] });
  info(MessageDelivery.key, { messageId: "q1", state: "queued", isHead: true, canCancel: true, canSendNow: true, targetTurnId: "turn" });
  info(MessageDelivery.key, { messageId: "q2", state: "queued", isHead: false, canCancel: true, canSendNow: false, targetTurnId: "turn" });
  const calls: any[] = [];
  peer.requests.set(MessageDelivery.sendNow, p => { calls.push(p); return {}; });
  peer.requests.set(MessageDelivery.cancel, p => { calls.push(p); return {}; });
  await assert.rejects(ws.sendMessageNow("a", "s:q2"), /queue head/);
  await ws.sendMessageNow("a", "s:q1");
  assert.deepEqual(calls[0], { sessionId: "s", messageId: "q1", targetTurnId: "turn" });
  info(MessageDelivery.key, { messageId: "q1", state: "sending", isHead: false, canCancel: false, canSendNow: false });
  await assert.rejects(ws.cancelMessage("a", "s:q1"), /no longer queued/);
  await ws.cancelMessage("a", "s:q2");
  assert.equal(calls[1].messageId, "q2");
  info(Discarded.key, { messageId: "q2", origin: { kind: "agent", agentId: "b", sessionId: "sb" }, content: [], reason: "interrupted" });
  const interrupted = inputs(await ws.load()).find((e: any) => e.id === "s:q2");
  assert.equal(interrupted.discarded, true);
  assert.equal(interrupted.content[0].text, "q2");
  ws.close();
});
