import { createHash } from "node:crypto";
import { conversationEntry, PluginPublication, RpcError } from "@xsb/protocol";
import type { Connection } from "@xsb/protocol";
import type { Hub } from "./hub.ts";
import type { LiveSession } from "./session.ts";
import { Paths } from "./paths.ts";

/** Resolved by the host from a publisher credential; session is the destination conversation. */
export type Publisher = { session: LiveSession; pluginId: string };

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
// The transcript is the receipt. Rebuild just the ID/digest index on first use after a restart.
const publications = new WeakMap<LiveSession, Map<string, string>>();
function publicationIndex(hub: Hub, session: LiveSession): Map<string, string> {
  let index = publications.get(session);
  if (index) return index;
  index = new Map();
  for (const row of hub.state.store.readBackward(Paths.transcript(session.agentId, session.id))) {
    const entry = row.update && conversationEntry(row.update, session.id);
    if (entry?.id.startsWith("publication_")) index.set(entry.id, digest(entry.markdown));
  }
  publications.set(session, index);
  return index;
}

/** This operation accepts display text. Its credential grants neither ACP nor runtime lifecycle operations. */
export function servePublications(hub: Hub, conn: Connection, lookup: (token: string) => Publisher | undefined): void {
  conn.onRequest(PluginPublication.publish, params => {
    const owner = typeof params?.token === "string" && lookup(params.token);
    if (!owner || hub.stopping) throw RpcError.invalidParams("Unknown or revoked publication credential");
    if (typeof params.markdown !== "string" || !params.markdown.trim() ||
        typeof params.idempotencyKey !== "string" || !params.idempotencyKey.trim() ||
        Object.keys(params).some(key => !["token", "idempotencyKey", "markdown"].includes(key))) {
      throw RpcError.invalidParams("Expected a publication credential, an idempotencyKey and Markdown text");
    }
    const { session, pluginId } = owner;
    const id = "publication_" + digest(JSON.stringify([session.id, pluginId, params.idempotencyKey]));
    const contentHash = digest(params.markdown);
    const index = publicationIndex(hub, session);
    const prior = index.get(id);
    if (prior !== undefined) {
      if (prior !== contentHash) throw RpcError.invalidParams("This publication key already identifies different Markdown");
      return { id };
    }
    try {
      session.appendConversationEntry(id, { kind: "plugin", id: pluginId, label: pluginId }, params.markdown);
    } catch (error) {
      // Notification can fail after the durable write. Consult the transcript before the next retry.
      publications.delete(session);
      throw error;
    }
    hub.state.afterCommit(() => index.set(id, contentHash));
    return { id };
  });
}
