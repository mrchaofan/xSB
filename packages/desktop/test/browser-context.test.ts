import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { Connection, ToolContext } from "@xsb/protocol";
import { BrowserContext } from "../src/browser-context.ts";

test("the browser observes runtime turns without model calls and closes its subscription", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-context-"));
  let peer: Connection | undefined;
  let state = { agentId: "a", sessionId: "sa", turnId: "one", active: true, turns: [{ id: "one", startedAt: 0 }] };
  const server = net.createServer((socket) => {
    peer = new Connection(socket, socket);
    peer.onRequest(ToolContext.attach, ({ token }) => { assert.equal(token, "readonly"); return state; });
    peer.onRequest(ToolContext.current, () => state);
  });
  server.listen(path.join(directory, "context.sock")); await once(server, "listening");
  const source = new BrowserContext(path.join(directory, "context.sock"), "readonly");
  t.after(async () => { source.close(); peer?.close(); await new Promise<void>((r) => server.close(() => r())); fs.rmSync(directory, { recursive: true, force: true }); });
  const seen: string[] = [], stop = source.watch((frame) => seen.push(frame.turnId!));
  assert.equal((await source.snapshot()).turnId, "one");
  state = { ...state, turnId: "two", turns: [{ id: "one", startedAt: 0, endedAt: 100 } as any, { id: "two", startedAt: 100 }] };
  peer!.notify(ToolContext.changed, state);
  for (let end = Date.now() + 1000; !seen.includes("two") && Date.now() < end;) await new Promise((r) => setTimeout(r, 10));
  assert.ok(seen.includes("two"));
  stop(); source.close();
});
