/**
 * The slice of ACP v2 (the draft the official agents serve: claude-agent-acp, codex-acp) the system reads or
 * writes. Everything else passes through untouched, so the types stay loose on purpose: nobody may drop fields
 * it does not know.
 *
 * The parts of v2 the system is built on:
 *   - `session/prompt` answers `{ messageId }` once the message is inserted into the conversation, not when the
 *     work is done; a prompt sent while the agent works is inserted when the agent can take it (steered at once,
 *     or held). A prompt cancelled before its insertion is answered with -32800 (`RpcError.cancelled`).
 *   - Work is reported by `state_update`: `running`, `requires_action`, and `idle` with the reason it stopped.
 *   - `session/cancel` stops the foreground work and the prompts not inserted yet.
 */
export const PROTOCOL_VERSION = 2;

export type Meta = Record<string, unknown>;

export type ContentBlock = { type: string; text?: string; uri?: string; name?: string; _meta?: Meta; [k: string]: unknown };

export type McpServer =
  | { type: "stdio"; name: string; command: string; args?: string[]; env?: { name: string; value: string }[]; _meta?: Meta }
  | { type: "http"; name: string; url: string; headers?: { name: string; value: string }[]; _meta?: Meta };

export type SessionUpdate = { sessionUpdate: string; _meta?: Meta; [k: string]: any };

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | "error";
export type SessionState = "idle" | "running" | "requires_action";
/** `state_update`; `error` comes with the stop reason `error`, as a JSON-RPC error object. */
export type StateUpdate = { sessionUpdate: "state_update"; state: SessionState; stopReason?: StopReason | null; error?: { code: number; message: string; data?: unknown } | null };
export const isStateUpdate = (u: SessionUpdate): u is StateUpdate => u.sessionUpdate === "state_update";

export type PermissionOption = { optionId: string; name: string; kind: string };

export type PermissionRequest = {
  sessionId: string;
  title: string;
  description?: string | null;
  subject?: { type: string; toolCall?: { toolCallId: string; title?: string | null; name?: string | null; [k: string]: unknown }; [k: string]: unknown } | null;
  options: PermissionOption[];
  _meta?: Meta;
};

export type PermissionResponse = { outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } };

export type Implementation = { name: string; title?: string | null; version: string };

export type AgentCapabilities = {
  session?: {
    prompt?: { image?: object | null; audio?: object | null; embeddedContext?: object | null } | null;
    mcp?: { stdio?: object | null; http?: object | null } | null;
    additionalDirectories?: object | null;
    systemPrompt?: { mode?: object | null } | null;
    [k: string]: unknown;
  } | null;
  _meta?: Meta | null;
  [k: string]: unknown;
};

export type InitializeRequest = { protocolVersion: number; info: Implementation; capabilities?: { _meta?: Meta | null; [k: string]: unknown }; _meta?: Meta | null };
export type InitializeResponse = { protocolVersion: number; info: Implementation; capabilities?: AgentCapabilities; authMethods?: unknown[]; _meta?: Meta | null };

export type PromptResponse = { messageId: string };

export const text = (value: string): ContentBlock => ({ type: "text", text: value });

/** Plain text of a prompt; non-text blocks are named, not dropped. */
export function textOf(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return b.text as string;
      if (b.type === "resource_link") return `[${b.name ?? b.uri}](${b.uri})`;
      return `[${b.type}]`;
    })
    .join("\n");
}
