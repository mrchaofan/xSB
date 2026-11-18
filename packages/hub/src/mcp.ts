/**
 * The hub's tools as an MCP server.
 *
 * A backend starts `xsb-mcp-bridge` as a stdio MCP server (the one transport
 * every ACP agent must support). The bridge connects here, says which session
 * it belongs to, and from then on relays MCP verbatim. Identity comes from the
 * token the hub put into that session's bridge environment, so a tool call
 * needs no "who am I" argument and an agent cannot speak for another.
 */
import path from "node:path";
import { RpcError } from "@xsb/protocol";
import type { Connection, McpServer, McpServerSpec } from "@xsb/protocol";
import type { Hub } from "./hub.ts";
import { shipped } from "./paths.ts";
import { mcpServers } from "./roles.ts";
import type { LiveSession } from "./session.ts";
import { TOOLS, callTool } from "./tools.ts";
import { VERSION } from "./util.ts";

const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const BRIDGE = path.join(shipped("bin"), "xsb-mcp-bridge");

export const BRIDGE_ATTACH = "_xsb/attach";
export const BRIDGE_SOCKET_ENV = "XSB_MCP_SOCKET";
export const BRIDGE_TOKEN_ENV = "XSB_MCP_TOKEN";

/**
 * The name of the hub's own MCP server, as an agent sees it: its tools are the team's (`team.dispatch_task`, ...;
 * hosts show them as `team/dispatch_task` or `mcp__team__dispatch_task`, for tool names may not contain dots).
 */
export const TEAM_SERVER = "team";

/** The `mcpServers` entry that gives a backend session the hub's tools. */
export function bridgeServer(socketPath: string, token: string): McpServer {
  return {
    type: "stdio",
    name: TEAM_SERVER,
    command: process.execPath,
    args: [BRIDGE],
    env: [
      // process.execPath is Electron in the desktop app. MCP hosts may filter
      // inherited variables, so the bridge must explicitly request Node mode.
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      { name: BRIDGE_SOCKET_ENV, value: socketPath },
      { name: BRIDGE_TOKEN_ENV, value: token },
    ],
  };
}

/**
 * MCP servers every agent has, role or not: what the client that started the hub gives them, in the shape of
 * `.mcp.json` (the desktop app gives its browser). A role's server of the same name takes its place.
 */
export const COMMON_SERVERS_ENV = "XSB_MCP_SERVERS";

export function commonServers(): { server: McpServer; about?: string }[] {
  const given = process.env[COMMON_SERVERS_ENV];
  if (!given) return [];
  const specs: Record<string, McpServerSpec> = JSON.parse(given);
  return mcpServers(specs).map((server) => ({ server, about: specs[server.name]?.about }));
}

/**
 * Serve the team's tools to one bridge. Every session is listed every tool, always: an agent program may take the list
 * once and keep it (codex does, whatever `notifications/tools/list_changed` says). Whether a call is allowed is
 * decided when it is made (capabilities.ts).
 */
export function serveMcp(hub: Hub, conn: Connection, lookup: (token: string) => LiveSession | undefined): void {
  let session: LiveSession | undefined;
  const attached = (): LiveSession => {
    if (!session) throw new RpcError(-32600, "not attached");
    return session;
  };

  conn.onRequest(BRIDGE_ATTACH, (p) => {
    session = lookup(p.token);
    if (!session) throw RpcError.invalidParams("unknown bridge token");
    return {};
  });
  conn.onRequest("initialize", (p) => ({
    protocolVersion: MCP_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : MCP_VERSIONS[0],
    capabilities: { tools: {} },
    serverInfo: { name: TEAM_SERVER, version: VERSION },
  }));
  conn.onRequest("ping", () => ({}));
  conn.onRequest("tools/list", () => {
    attached();
    return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  });
  conn.onRequest("tools/call", async (p) => {
    const result = await callTool(hub, attached(), p.name, p.arguments);
    return { content: [{ type: "text", text: result.text }], isError: result.isError };
  });
}
