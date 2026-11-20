import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolContext } from "@xsb/protocol";
import { Hooks } from "../src/hooks.ts";
import { serveMcp, BRIDGE_ATTACH } from "../src/mcp.ts";
import { contextServer } from "../src/tool-context.ts";

test("tool context is scoped, read-only, and streams turn changes without posting mail", async () => {
  const hooks = new Hooks<any, any>({ log() {}, vetoed() {}, deadLetter() {} });
  let frame = { agentId: "a", sessionId: "sa", turnId: null as string | null, active: false, turns: [] as any[] };
  const owner = { server: "browser", session: { id: "sa", agentId: "a", toolContext: () => frame } };
  let valid = true, closed = false, end!: () => void;
  const handlers = new Map<string, (p: any) => any>(), notifications: any[] = [];
  const conn = { isClosed: false, closed: new Promise<void>((r) => { end = r; }), onRequest(name: string, fn: any) { handlers.set(name, fn); }, notify(name: string, state: any) { notifications.push({ name, state }); }, close() { closed = true; this.isClosed = true; end(); } };
  const hub = { state: { agents: new Map([["a", {}]]), mail: new Map() }, kernel: { hooks }, stopping: false };
  serveMcp(hub as any, conn as any, () => undefined, (token) => valid && token === "readonly" ? owner as any : undefined);
  assert.equal(handlers.get(ToolContext.attach)!({ token: "readonly" }).turnId, null);
  frame = { ...frame, turnId: "turn-1", active: true, turns: [{ id: "turn-1", startedAt: 100 }] };
  hooks.emit("acp.turn_changed", { sessionId: "sa", agentId: "a" }); await hooks.settled();
  assert.equal(notifications.at(-1).state.turnId, "turn-1");
  assert.equal(hub.state.mail.size, 0);
  assert.ok(!handlers.has("_xsb/tool-events/publish"));
  assert.throws(() => handlers.get(BRIDGE_ATTACH)!({ token: "readonly" }), /unknown bridge token/);
  hooks.emit("acp.turn_changed", { sessionId: "sb", agentId: "b" }); await hooks.settled();
  assert.equal(notifications.length, 1);
  valid = false;
  assert.throws(() => handlers.get(ToolContext.current)!({}), /revoked/);
  conn.close(); await conn.closed;
  assert.equal(closed, true);
});

test("runtime identity replaces spoofed environment keys without granting event publishing", () => {
  const scoped = contextServer({ type: "stdio", name: "browser", command: "browser", env: [{ name: "KEEP", value: "yes" }, { name: ToolContext.tokenEnv, value: "spoof" }] }, "/socket", "trusted");
  assert.ok(scoped.type === "stdio");
  assert.equal(scoped.env?.find((e) => e.name === "KEEP")?.value, "yes");
  assert.deepEqual(scoped.env?.filter((e) => e.name === ToolContext.tokenEnv), [{ name: ToolContext.tokenEnv, value: "trusted" }]);
});
