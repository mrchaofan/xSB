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
import { consultationGuidance, WORKFLOW_MAIN_ABOUT, WORKFLOW_TASK_ABOUT, XSB_TOOLS_ABOUT } from "./prompts.ts";
import { consultationSettings, projectLanguage } from "./config.ts";
import { ASK_TOOL } from "./questions.ts";
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
/** xSB's own tools that are no workflow's, though usable in one: `ask` (questions.ts). */
export const XSB_SERVER = "xsb";
type Server = typeof WORKFLOW_SERVER | typeof XSB_SERVER;

/** An `mcpServers` entry that gives a backend session the hub's tools: each server is a bridge of its own. */
export function bridgeServer(socketPath: string, token: string, name: Server = WORKFLOW_SERVER): McpServer {
  return {
    type: "stdio",
    name,
    command: process.execPath,
    args: [BRIDGE],
    env: [
      // process.execPath is Electron in the desktop app. MCP hosts may filter
      // inherited variables, so the bridge must explicitly request Node mode.
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      { name: BRIDGE_SOCKET_ENV, value: socketPath },
      { name: BRIDGE_TOKEN_ENV, value: token },
      { name: BRIDGE_SERVER_ENV, value: name },
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
  let server: Server = WORKFLOW_SERVER;
  const attached = (): LiveSession => {
    if (!session || !token || lookup(token) !== session)
      throw new RpcError(-32600, "not attached or bridge revoked");
    return session;
  };

  conn.onRequest(BRIDGE_ATTACH, (p) => {
    session = lookup(p.token);
    if (!session) throw RpcError.invalidParams("unknown bridge token");
    token = p.token;
    server = p.server === XSB_SERVER ? XSB_SERVER : WORKFLOW_SERVER;
    return {};
  });
  conn.onRequest("initialize", (p) => ({
    protocolVersion: MCP_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : MCP_VERSIONS[0],
    capabilities: { tools: {} },
    serverInfo: { name: server, version: VERSION },
    // Shown to the model by agent programs that pass server instructions on: what these tools are, before it guesses.
    instructions: (() => {
      if (server === XSB_SERVER) return XSB_TOOLS_ABOUT + "\n\n" + consultationGuidance(consultationSettings(hub.paths).effective, projectLanguage(hub.paths));
      try { return hub.agent(attached().agentId).workflowOwner ? WORKFLOW_TASK_ABOUT : WORKFLOW_MAIN_ABOUT; }
      catch { return WORKFLOW_MAIN_ABOUT; }
    })(),
  }));
  conn.onRequest("ping", () => ({}));
  conn.onRequest("tools/list", () => {
    const session = attached();
    return { tools: server === XSB_SERVER ? [ASK_TOOL] : workflowTools(!!hub.agent(session.agentId).workflowOwner) };
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
    const step = hub.lifecycle.step(owner.source(), `mcp:${receipt}`, { tool: p.name, server });
    const args = p.arguments ?? {};
    const budget = hub.policy(owner.agentId).outputTokens;
    const log = server === WORKFLOW_SERVER ? {
      kind: "tool" as const,
      tool: p.name,
      receipt,
      arguments: boundedText(hub.paths, owner.agentId, JSON.stringify(args), budget),
    } : undefined;
    let answer: string;
    try {
      let result: unknown;
      if (server === XSB_SERVER) {
        if (p.name !== ASK_TOOL.name) throw Error(`Unknown tool ${p.name}`);
        result = await owner.withStep(step.source, () => hub.questions.ask(owner, args, ctx?.signal));
        // Waiting for a person must not let an old bridge/turn credit output to new work.
        if (attached() !== owner || owner.current?.id !== turnId || !owner.acceptsTools)
          throw RpcError.cancelled();
      } else result = owner.withStep(step.source, () => hub.workflows.call(owner, p.name, args, receipt));
      answer = boundedText(
        hub.paths,
        owner.agentId,
        typeof result === "string" ? result : JSON.stringify(result, null, 2),
        budget,
      );
    } catch (error) {
      if (log && !hub.state.store.healthy) throw error;
      const message = (error as Error).message;
      if (log) hub.workflows.record(owner, turnId, { ...log, error: message });
      step.end({ status: "failed" });
      return { content: [{ type: "text", text: message }], isError: true };
    }
    if (log) hub.workflows.record(owner, turnId, { ...log, result: answer });
    owner.toolOutput(answer);
    step.end({ status: "completed" });
    return { content: [{ type: "text", text: answer }] };
  });
}
