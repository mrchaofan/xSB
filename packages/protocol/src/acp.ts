/**
 * The slice of ACP v1 the hub reads or writes. Everything else passes through
 * untouched, so the types stay loose on purpose: the hub must not drop fields
 * it does not know.
 */
export const PROTOCOL_VERSION = 1;

export type Meta = Record<string, unknown>;

export type ContentBlock = { type: string; text?: string; uri?: string; name?: string; _meta?: Meta; [k: string]: unknown };

export type McpServer = {
  type?: "http" | "sse";
  name: string;
  command?: string;
  args?: string[];
  env?: { name: string; value: string }[];
  [k: string]: unknown;
};

export type SessionUpdate = { sessionUpdate: string; _meta?: Meta; [k: string]: any };

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
};

export type PermissionRequest = {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string | null; name?: string | null; [k: string]: unknown };
  options: PermissionOption[];
  _meta?: Meta;
};

export type PermissionResponse = {
  outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
};

export type AgentCapabilities = {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  sessionCapabilities?: {
    list?: object | null;
    resume?: object | null;
    close?: object | null;
    systemPrompt?: object | null;
    additionalDirectories?: object | null;
  };
  _meta?: Meta | null;
  [k: string]: unknown;
};

export type InitializeResponse = {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: { name: string; title?: string | null; version: string } | null;
  authMethods?: unknown[];
  _meta?: Meta | null;
};

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
