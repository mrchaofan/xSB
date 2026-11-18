import assert from "node:assert/strict";
import { test } from "node:test";
import { Paths } from "@xsb/hub";
import { Agents, Assets, History, Roles, Tasks, Teams } from "@xsb/protocol";
import { address } from "../src/address.ts";
import { Driven } from "../src/browser.ts";
import { Workspace } from "../src/workspace.ts";
import type { Notice } from "../src/workspace.ts";

const role = (instructions = "old") => ({ name: "developer", instructions, description: "build", backend: "mock", mcpServers: {}, skills: [], agents: [] });
const agent = (id: string) => ({ id, name: id, role: "developer", workspace: "/tmp", backend: "mock", description: "old", state: "idle" });
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
  peer.requests.set(Roles.list, () => ({ roles: [role()] }));
  peer.requests.set(Teams.list, () => ({ teams: [] }));
  peer.requests.set(Agents.list, () => ({ agents }));
  peer.requests.set(Tasks.list, () => ({ tasks: [] }));
  peer.requests.set(Assets.list, () => ({ assets: [] }));
}

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

test("roles are one list answer, and an event after it is the newer word", async () => {
  const peer = new Peer();
  snapshot(peer);
  // The list is answered first; what the hub does after it comes as events, while the rest still loads.
  peer.requests.set(Teams.list, async () => {
    await new Promise((resolve) => setTimeout(resolve));
    peer.emit(Roles.update, { role: role("new") });
    peer.emit(Roles.update, { role: { ...role(), name: "tester" } });
    peer.emit(Roles.removed, { name: "tester" });
    return { teams: [] };
  });
  const ws = workspace(peer);
  assert.deepEqual(
    (await ws.load()).roles.map((r) => [r.name, r.instructions]),
    [["developer", "new"]],
  );
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

test("apply reports the failed agent and a retry skips successful restarts", async () => {
  const peer = new Peer();
  snapshot(peer, [agent("a"), agent("b"), agent("c")]);
  const ws = workspace(peer);
  await ws.load();
  const restarted = [];
  let fail = true;
  peer.requests.set(Agents.restart, ({ id }) => {
    if (id === "b" && fail) throw new Error("restart refused");
    restarted.push(id);
    return {};
  });
  const first = await ws.applyRole("developer");
  assert.deepEqual(first, { done: ["a"], failed: "b", error: "restart refused" });
  fail = false;
  assert.deepEqual(await ws.applyRole("developer", first.done), { done: ["a", "b", "c"] });
  assert.deepEqual(restarted, ["a", "b", "c"]);
  ws.close();
});

test("sync retries only agents whose values still differ", async () => {
  const peer = new Peer();
  snapshot(peer, [agent("a"), agent("b")]);
  const ws = workspace(peer);
  await ws.load();
  const updated = [];
  let fail = true;
  peer.requests.set(Agents.put, ({ agent: patch }) => {
    if (patch.id === "b" && fail) throw new Error("update refused");
    updated.push(patch.id);
    return { agent: { ...agent(patch.id), ...patch } };
  });
  assert.equal((await ws.syncRole("developer")).failed, "b");
  fail = false;
  assert.deepEqual((await ws.syncRole("developer")).done, ["b"]);
  assert.deepEqual(updated, ["a", "b"]);
  ws.close();
});

test("long snapshot parts retain their content and all element refs despite page changes", async () => {
  let captures = 0;
  const clicked = [];
  const contents = {
    debugger: {
      attach() {},
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
  const driven = new Driven(contents);
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
