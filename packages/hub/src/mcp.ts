/**
 * The hub's tools as an MCP server.
 *
 * A backend starts `xsb-mcp-bridge` as a stdio MCP server (the one transport
 * every ACP agent must support). The bridge connects here, says which session
 * it belongs to, and from then on relays MCP verbatim. Identity comes from the
 * token the hub put into that session's bridge environment, so a tool call
 * needs no "who am I" argument and an agent cannot speak for another.
 */
import { fileURLToPath } from "node:url";
import { RpcError } from "@xsb/protocol";
import type { Connection, McpServer } from "@xsb/protocol";
import type { Hub } from "./hub.ts";
import type { LiveSession } from "./session.ts";
import { TOOLS, callTool } from "./tools.ts";
import { VERSION } from "./util.ts";

const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const BRIDGE = fileURLToPath(new URL("../bin/xsb-mcp-bridge", import.meta.url));

export const BRIDGE_ATTACH = "_xsb/attach";
export const BRIDGE_SOCKET_ENV = "XSB_MCP_SOCKET";
export const BRIDGE_TOKEN_ENV = "XSB_MCP_TOKEN";

/** The `mcpServers` entry that gives a backend session the hub's tools. */
export function bridgeServer(socketPath: string, token: string): McpServer {
  return {
    name: "xsb",
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
    serverInfo: { name: "xsb", version: VERSION },
  }));
  conn.onRequest("ping", () => ({}));
  conn.onRequest("tools/list", () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  conn.onRequest("tools/call", (p) => {
    const result = callTool({ hub, session: attached() }, p.name, p.arguments);
    return { content: [{ type: "text", text: result.text }], isError: result.isError };
  });
}
