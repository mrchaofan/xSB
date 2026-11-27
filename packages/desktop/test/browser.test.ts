import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { EventEmitter, once } from "node:events";
import { test } from "node:test";
import { Connection, ToolContext } from "@xsb/protocol";
import type { ToolContextState } from "@xsb/protocol";
import { BrowserSession, BROWSER_INSTRUCTIONS, ATTACH, serveBrowser } from "../src/browser.ts";
import { BrowserDownloads, ownDownloads } from "../src/browser-downloads.ts";

class Context {
  state: ToolContextState = { agentId: "a", sessionId: "sa", turnId: "turn-1", active: true, turns: [{ id: "turn-1", startedAt: 0 }] };
  listeners = new Set<(state: ToolContextState) => void>();
  async snapshot() { return this.state; }
  watch(fn: (state: ToolContextState) => void) { this.listeners.add(fn); fn(this.state); return () => this.listeners.delete(fn); }
  close() { this.listeners.clear(); }
  turn(id: string | null) {
    const time = Date.now();
    const turns = this.state.turns.map((t) => ({ ...t, endedAt: t.endedAt ?? time }));
    if (id) turns.push({ id, startedAt: time });
    this.state = { ...this.state, turnId: id, active: !!id, turns };
    for (const fn of this.listeners) fn(this.state);
  }
}
class Item extends EventEmitter {
  destination = ""; bytes = 0; total = 3; paused = false;
  getFilename() { return "report.csv"; }
  getURL() { return "https://user:password@example.com/file?token=secret#secret"; }
  getMimeType() { return "text/csv"; }
  getReceivedBytes() { return this.bytes; }
  getTotalBytes() { return this.total; }
  getState() { return "progressing"; }
  isPaused() { return this.paused; }
  setSavePath(value: string) { this.destination = value; }
  finish(state = "completed", write = true) {
    if (write) { fs.writeFileSync(this.destination, "abc"); this.bytes = 3; }
    this.emit("done", {}, state);
  }
}
const signal = () => new AbortController().signal;
const read = (result: any) => result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
function temp(t: any) { const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-browser-")); t.after(() => fs.rmSync(cwd, { recursive: true, force: true })); return cwd; }
function collector(project: string) { const d = new BrowserDownloads(project); d.setContext(new Context().state); return d; }
const event = { preventDefault() {} };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("native downloads preserve filenames and atomically reserve suffixes across collectors", (t) => {
  const project = temp(t), a = collector(project), b = collector(project);
  const first = new Item(), second = new Item(), third = new Item();
  a.accept(event, first as any, "p1"); b.accept(event, second as any, "p2"); a.accept(event, third as any, "p1");
  assert.deepEqual([first, second, third].map((i) => path.basename(i.destination)), ["report.csv", "report (1).csv", "report (2).csv"]);
  assert.equal(path.dirname(first.destination), path.join(project, ".xsb2", "downloads"));
  assert.equal(a.list()[0].path, undefined);
  first.finish(); second.finish(); third.finish("cancelled", false);
  assert.equal(a.list()[0].path, first.destination);
  assert.equal(a.list()[1].state, "cancelled");
  assert.ok(!fs.existsSync(third.destination));
  const manifest = fs.readFileSync(a.manifest, "utf8");
  assert.ok(!manifest.includes("secret") && !manifest.includes("password"));
});

test("new turns clear visibility, late completion stays in the old turn, and files remain", async (t) => {
  const d = collector(temp(t)), context = new Context();
  const old = new Item(); d.accept(event, old as any, "p1");
  const oldId = d.list()[0].id;
  await pause(3); context.turn("turn-2"); d.setContext(context.state);
  assert.deepEqual(d.list(), []);
  old.finish();
  assert.deepEqual(d.list(), []);
  assert.throws(() => d.progress(oldId), /current turn/);
  assert.ok(fs.existsSync(old.destination));
  const next = new Item(); d.accept(event, next as any, "p1"); next.finish();
  assert.equal(d.list().length, 1);
  assert.equal(d.list()[0].turnId, "turn-2");
});

test("progress is immediate and reports bytes, pause and unknown size without inventing values", async (t) => {
  const d = collector(temp(t)), item = new Item(); item.total = 100;
  d.accept(event, item as any, "p1"); const id = d.list()[0].id;
  assert.equal((d.progress(id) as any).bytesPerSecond, null);
  await pause(5); item.bytes = 40;
  const progress: any = d.progress(id);
  assert.equal(progress.receivedBytes, 40); assert.equal(progress.percent, 40);
  assert.ok(progress.bytesPerSecond > 0); assert.equal(progress.done, false);
  item.paused = true; item.total = 0;
  const unknown: any = d.progress(id);
  assert.equal(unknown.totalBytes, null); assert.equal(unknown.percent, null); assert.equal(unknown.paused, true);
  item.finish(); assert.equal((d.progress(id) as any).done, true);
  assert.equal((d.progress(id) as any).path, item.destination);
});

test("unsafe names stay in the preset directory; blocked storage never falls back to a dialog", (t) => {
  const project = temp(t), d = collector(project), unsafe = new Item();
  unsafe.getFilename = () => "../../CON.csv";
  d.accept(event, unsafe as any, "p1"); assert.equal(path.dirname(unsafe.destination), d.directory); unsafe.finish();
  const blocked = temp(t); fs.writeFileSync(path.join(blocked, ".xsb2"), "not a directory");
  const rejected = collector(blocked); let prevented = false;
  rejected.accept({ preventDefault() { prevented = true; } }, new Item() as any, "p1");
  assert.equal(prevented, true); assert.equal(rejected.list()[0].state, "interrupted");
  const missing = new Item(); d.accept(event, missing as any, "p1"); missing.finish("completed", false);
  assert.equal(d.list().at(-1)!.state, "interrupted"); assert.equal(d.list().at(-1)!.path, undefined);
});

test("a shared cookie partition uses one listener and routes downloads to their page owner", (t) => {
  const partition = new EventEmitter(), a = collector(temp(t)), b = collector(temp(t));
  const release = ownDownloads({ id: 1, session: partition } as any, "p1", a);
  ownDownloads({ id: 2, session: partition } as any, "p2", b);
  assert.equal(partition.listenerCount("will-download"), 1);
  const item = new Item(); partition.emit("will-download", event, item, { id: 2 });
  assert.equal(a.list().length, 0); assert.equal(b.list().length, 1); item.finish();
  release(); const user = new Item(); partition.emit("will-download", event, user, { id: 1 });
  assert.equal(user.destination, "");
});

class FakePages {
  entries = new Map<string, any>();
  counter = 0;
  operations: string[] = [];
  clicked?: () => void;
  failNavigation = false;
  setAgentControl() {}
  open(_url: string, options: any = {}) {
    const id = `p${++this.counter}`;
    let dead = false;
    let attached = false;
    const contents = {
      isDestroyed: () => dead,
      destroy: () => { dead = true; },
      debugger: {
        attach() { attached = true; }, isAttached: () => attached, detach() { attached = false; },
        sendCommand: async (method: string, args: any) => {
          if (method === "Accessibility.getFullAXTree") return { nodes: [{ nodeId: "1", role: { value: "link" }, name: { value: id }, backendDOMNodeId: Number(id.slice(1)) }] };
          if (method === "DOM.getContentQuads") return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] };
          if (method === "Input.dispatchMouseEvent" && args.type === "mouseReleased") this.clicked?.();
          if (method === "Page.captureScreenshot") return { data: "aW1hZ2U=" };
          return {};
        },
      },
      getTitle: () => id, getURL: () => this.entries.get(id)?.url ?? "about:blank", isLoading: () => false,
      navigationHistory: { goBack() {} },
    };
    this.entries.set(id, { id, options, contents, url: "about:blank", window: false });
    return { id };
  }
  contents(id: string) { return this.entries.get(id)?.contents; }
  async navigate(id: string, url: string) {
    const entry = this.entries.get(id);
    if (this.failNavigation) {
      entry.options.downloads.accept({ preventDefault() {} }, new Item() as any, id);
      throw new Error("net::ERR_ABORTED");
    }
    entry.url = url;
  }
  call(id: string, op: string) {
    this.operations.push(`${id}:${op}`);
    if (op === "close") { this.contents(id).destroy(); this.entries.delete(id); }
    else this.entries.get(id).window = op === "detach";
  }
  async drawn<T>(id: string, draw: () => Promise<T>) { this.operations.push(`${id}:drawn`); return draw(); }
  list() { return [...this.entries.values()].map(({ id, contents, url, window }) => ({ id, url, title: contents.getTitle(), window })); }
  releaseAgent(id: string) { this.entries.get(id).options = {}; }
  popup(parent: string) {
    const options = this.entries.get(parent).options;
    const { id } = this.open("about:blank", options);
    options.onPopup?.(id);
    return id;
  }
}

test("new pages preserve the original, and popups/select/close remain connection-scoped", async (t) => {
  const project = temp(t), pages = new FakePages(), context = new Context();
  const browser = new BrowserSession(project, () => ({ pages: pages as any, project }), context);
  t.after(() => browser.release());
  const invoke = (name: string, args = {}) => browser.call(name, args, signal());
  await invoke("browser_navigate", { url: "one.example" });
  await invoke("browser_open", { url: "two.example", presentation: "window" });
  assert.equal(pages.entries.get("p1").url, "https://one.example/"); assert.ok(pages.operations.includes("p2:detach"));
  await invoke("browser_select", { pageId: "p1" }); pages.clicked = () => { pages.popup("p1"); };
  assert.match(read(await invoke("browser_click", { ref: 1 })), /pageId: p3/);
  const user = pages.open("about:blank"); assert.equal((await invoke("browser_select", { pageId: user.id })).isError, true);
  await invoke("browser_close", { pageId: "p3" }); assert.match(read(await invoke("browser_snapshot")), /pageId: p2/);
});

test("list/progress APIs are small, nonblocking, and reset on runtime turn changes without another browser action", async (t) => {
  const project = temp(t), pages = new FakePages(), context = new Context();
  const browser = new BrowserSession(project, () => ({ pages: pages as any, project }), context);
  t.after(() => browser.release());
  const invoke = (name: string, args = {}) => browser.call(name, args, signal());
  const baseline = JSON.parse(read(await invoke("browser_downloads_list")));
  assert.equal(baseline.directory, path.join(project, ".xsb2", "downloads"));
  assert.equal(pages.counter, 0);
  await invoke("browser_navigate", { url: "export.example" });
  assert.equal(JSON.parse(read(await invoke("browser_downloads_list"))).total, 0);
  const item = new Item();
  // An ordinary page action or a delayed script can trigger this native event.
  pages.entries.get("p1").options.downloads.accept(event, item as any, "p1");
  const listed = JSON.parse(read(await invoke("browser_downloads_list")));
  assert.equal(listed.turnId, "turn-1"); assert.equal(listed.total, 1);
  assert.equal((await invoke("browser_downloads_list", { waitMs: 30000 })).isError, true);
  assert.equal((await invoke("browser_downloads_progress", { id: listed.downloads[0].id })).isError, undefined);
  await pause(3); context.turn("turn-2"); item.finish();
  assert.equal(JSON.parse(read(await invoke("browser_downloads_list"))).total, 0);
  assert.equal((await invoke("browser_downloads_progress", { id: listed.downloads[0].id })).isError, true);
  assert.ok(BROWSER_INSTRUCTIONS.includes("browser_downloads_progress"));
});

test("MCP advertises only list/progress downloads APIs and serializes its page actions", async (t) => {
  const project = temp(t), pages = new FakePages();
  const server = serveBrowser(path.join(project, "browser.sock"), () => ({ pages: pages as any, project }));
  await once(server, "listening"); const socket = net.connect(path.join(project, "browser.sock")); await once(socket, "connect");
  const peer = new Connection(socket, socket);
  t.after(async () => { peer.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  peer.notify(ATTACH, { cwd: project });
  const names = (await peer.request("tools/list")).tools.map((tool: any) => tool.name);
  assert.ok(names.includes("browser_downloads_list") && names.includes("browser_downloads_progress"));
  assert.ok(!names.includes("browser_downloads") && !names.includes("click_download"));
  const [first, second] = await Promise.all([
    peer.request("tools/call", { name: "browser_navigate", arguments: { url: "one.example" } }),
    peer.request("tools/call", { name: "browser_open", arguments: { url: "two.example" } }),
  ]);
  assert.match(read(first), /pageId: p1/); assert.match(read(second), /pageId: p2/);
});
