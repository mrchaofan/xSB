import { RpcError, ToolContext } from "@xsb/protocol";
import type { Connection, McpServer, ToolContextState } from "@xsb/protocol";
import type { Hub } from "./hub.ts";
import type { LiveSession } from "./session.ts";

export type ContextOwner = { session: LiveSession; server: string };
export function contextServer(server: McpServer, socket: string, token: string): McpServer {
  if (server.type !== "stdio") return server;
  const reserved = new Set([ToolContext.socketEnv, ToolContext.tokenEnv]);
  return { ...server, env: [
    ...(server.env ?? []).filter((entry) => !reserved.has(entry.name)),
    { name: ToolContext.socketEnv, value: socket }, { name: ToolContext.tokenEnv, value: token },
  ] };
}

/** Tools may observe runtime turns, but cannot enqueue mail or invoke team tools. */
export function serveToolContext(hub: Hub, conn: Connection, lookup: (token: string) => ContextOwner | undefined): void {
  let owner: ContextOwner | undefined;
  let token = "";
  let unsubscribe: (() => void) | undefined;
  const state = (): ToolContextState => {
    if (hub.stopping || !owner || lookup(token) !== owner || !hub.state.agents.has(owner.session.agentId)) throw RpcError.invalidParams("tool context credential revoked or not attached");
    return owner.session.toolContext();
  };
  conn.onRequest(ToolContext.attach, (p) => {
    token = p.token; owner = lookup(token);
    const initial = state();
    unsubscribe?.();
    unsubscribe = hub.kernel.hooks.on("acp.turn_changed", ({ sessionId }) => {
      if (sessionId !== owner?.session.id || conn.isClosed) return;
      try { conn.notify(ToolContext.changed, state()); } catch { conn.close(); }
    });
    void conn.closed.then(() => unsubscribe?.());
    return initial;
  });
  conn.onRequest(ToolContext.current, state);
}
