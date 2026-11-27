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
import type { Connection, McpServer } from "@xsb/protocol";
import type { Hub } from "./hub.ts";
import { shipped } from "./paths.ts";

import type { LiveSession } from "./session.ts";
import { workflowTools } from "./workflow-tools.ts";
import { projectLanguage } from "./config.ts";
import { workflowToolHint } from "./workflow-guide.ts";
import { boundedText } from "./context.ts";
import { newId, VERSION } from "./util.ts";
import { servePublications } from "./publications.ts";
import { serveToolContext } from "./tool-context.ts";
import type { ContextOwner } from "./tool-context.ts";
import type { Publisher } from "./publications.ts";

const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const BRIDGE = path.join(shipped("bin"), "xsb-mcp-bridge");

export const BRIDGE_ATTACH = "_xsb/attach";
export const BRIDGE_SOCKET_ENV = "XSB_MCP_SOCKET";
export const BRIDGE_TOKEN_ENV = "XSB_MCP_TOKEN";
export const BRIDGE_SERVER_ENV = "XSB_MCP_SERVER";

/** The workflow tools. */
export const WORKFLOW_SERVER = "workflow";

/** The workflow MCP server for this backend session. */
export function bridgeServer(socketPath: string, token: string): McpServer {
  return {
    type: "stdio",
    name: WORKFLOW_SERVER,
    command: process.execPath,
    args: [BRIDGE],
    env: [
      // process.execPath is Electron in the desktop app. MCP hosts may filter
      // inherited variables, so the bridge must explicitly request Node mode.
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      { name: BRIDGE_SOCKET_ENV, value: socketPath },
      { name: BRIDGE_TOKEN_ENV, value: token },
      { name: BRIDGE_SERVER_ENV, value: WORKFLOW_SERVER },
    ],
  };
}

/** Resolve each call against the live session and its current assignment. */
export function serveMcp(
  hub: Hub,
  conn: Connection,
  lookup: (token: string) => LiveSession | undefined,
  contextLookup: (token: string) => ContextOwner | undefined = () => undefined,
  publisherLookup: (token: string) => Publisher | undefined = () => undefined,
): void {
  serveToolContext(hub, conn, contextLookup);
  servePublications(hub, conn, publisherLookup);
  const connectionId = newId("mcp");
  let session: LiveSession | undefined;
  let token: string | undefined;
  const attached = (): LiveSession => {
    if (!session || !token || lookup(token) !== session)
      throw new RpcError(-32600, "not attached or bridge revoked");
    return session;
  };

  conn.onRequest(BRIDGE_ATTACH, (p) => {
    if (p.server !== undefined && p.server !== WORKFLOW_SERVER) throw RpcError.invalidParams("unknown bridge server");
    session = lookup(p.token);
    if (!session) throw RpcError.invalidParams("unknown bridge token");
    token = p.token;
    return {};
  });
  conn.onRequest("initialize", (p) => ({
    protocolVersion: MCP_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : MCP_VERSIONS[0],
    capabilities: { tools: {} },
    serverInfo: { name: WORKFLOW_SERVER, version: VERSION },
    // Shown to the model by agent programs that pass server instructions on: what these tools are, before it guesses.
    instructions: (() => {
      try { return workflowToolHint(!!hub.agent(attached().agentId).workflowOwner, projectLanguage(hub.paths)); }
      catch { return workflowToolHint(false, "en"); }
    })(),
  }));
  conn.onRequest("ping", () => ({}));
  conn.onRequest("tools/list", () => {
    const session = attached();
    const owner = hub.agent(session.agentId).workflowOwner;
    return { tools: workflowTools(!!owner, owner ? hub.workflows.isMarkdownTask(session) : true) };
  });
  conn.onRequest("tools/call", async (p, ctx) => {
    const owner = attached();
    if (!owner.current?.started || !owner.acceptsTools)
      throw new RpcError(-32600, "No active turn: stopped or idle work cannot invoke tools.");
    owner.observeExecution();
    const turnId = owner.current.id;
    const receipt =
      typeof p._meta?.["dev.xsb/call-id"] === "string"
        ? p._meta["dev.xsb/call-id"]
        : connectionId + "/" + JSON.stringify(ctx.id);
    const step = hub.lifecycle.step(owner.source(), `mcp:${receipt}`, { tool: p.name, server: WORKFLOW_SERVER });
    const args = p.arguments ?? {};
    const budget = hub.policy(owner.agentId).outputTokens;
    const log = {
      kind: "tool" as const,
      tool: p.name,
      receipt,
      arguments: boundedText(hub.paths, owner.agentId, JSON.stringify(args), budget),
    };
    let answer: string;
    try {
      const result = owner.withStep(step.source, () => hub.workflows.call(owner, p.name, args, receipt));
      answer = boundedText(
        hub.paths,
        owner.agentId,
        typeof result === "string" ? result : JSON.stringify(result, null, 2),
        budget,
      );
    } catch (error) {
      if (!hub.state.store.healthy) throw error;
      const message = (error as Error).message;
      hub.workflows.record(owner, turnId, { ...log, error: message });
      step.end({ status: "failed" });
      return { content: [{ type: "text", text: message }], isError: true };
    }
    hub.workflows.record(owner, turnId, { ...log, result: answer });
    owner.toolOutput(answer);
    step.end({ status: "completed" });
    return { content: [{ type: "text", text: answer }] };
  });
}
