import type { SessionUpdate } from "./acp.ts";

/** Passive, host-attributed Markdown for a conversation's transcript and live subscribers. */
export const ConversationEvent = { key: "dev.xsb/conversation-event" } as const;

export type ConversationEntry = {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  source: { kind: "plugin"; id: string; label: string };
  markdown: string;
  /** A later event with the same identity marks the original, historical entry withdrawn. */
  withdrawn?: true;
};

/** A local MCP plugin can publish from its own process over the tool-context socket. */
export const PluginPublication = {
  tokenEnv: "XSB_CONVERSATION_TOKEN",
  publish: "_xsb/conversation/publish",
} as const;

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Additive fields are allowed. Unsupported versions and older ACP messages keep their existing interpretation. */
export function conversationEntry(update: SessionUpdate, sessionId: string): ConversationEntry | undefined {
  const entry = update._meta?.[ConversationEvent.key];
  if (update.sessionUpdate !== "session_info_update" || !record(entry) || entry.schemaVersion !== 1 ||
      !identifier(entry.id) || entry.sessionId !== sessionId || typeof entry.markdown !== "string") return;
  const source = entry.source;
  if (!record(source) || source.kind !== "plugin" || !identifier(source.id) || !identifier(source.label)) return;
  return { schemaVersion: 1, id: entry.id, sessionId, source: { kind: "plugin", id: source.id, label: source.label },
    markdown: entry.markdown, ...(entry.withdrawn === true && { withdrawn: true }) };
}
