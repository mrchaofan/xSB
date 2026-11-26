/**
 * LedgerHook: what became of every input given to a session, from the signals ACP v1 gives (ext.ts, `LedgerState`).
 *
 *   message.insertion_receipt   ACP v2's answer to `session/prompt`: inserted into the conversation; or -32800, or
 *                               stopped while the hub held it: it never will be
 *   acp.session_update          anything the backend reports after an insertion: the model went on, it was seen
 *   acp.turn_ended              ended normally: seen. Stopped or failed before anything followed: in the
 *                               conversation, unprocessed; it is seen when the session goes on
 *   acp.session_renewed         the backend session is gone: what was left unprocessed in it never will be seen
 *
 * What is in flight is kept per session in memory: after a restart of the hub an input left `inserted` or
 * `inserted_unprocessed` stays so.
 */
import type { Kernel } from "./kernel.ts";
import { RunExt } from "@xsb/protocol";
import type { RunUpdate } from "@xsb/protocol";

/** Updates of a backend that say the model went on. */
const OUTPUT = new Set(["agent_message_chunk", "agent_message", "agent_thought_chunk", "agent_thought", "tool_call_update", "tool_call_content_chunk", "plan_update"]);

export function ledgerHook(kernel: Kernel): void {
  /** Session -> inputs inserted in its running turn and not yet followed by anything. */
  const inserted = new Map<string, Set<string>>();
  /** Session -> inputs in its conversation whose turn was stopped before the model went on. */
  const unprocessed = new Map<string, Set<string>>();
  const of = <T>(map: Map<string, T>, sessionId: string, make: () => T): T => map.get(sessionId) ?? (map.set(sessionId, make()), map.get(sessionId)!);
  const seen = (sessionId: string): void => {
    for (const id of [...(inserted.get(sessionId) ?? []), ...(unprocessed.get(sessionId) ?? [])]) kernel.mark(id, "seen");
    inserted.delete(sessionId);
    unprocessed.delete(sessionId);
  };

  kernel.hooks.on("message.insertion_receipt", ({ messageId, about, inserted: inThere, outcome }) => {
    if (!inThere) return kernel.mark(messageId, outcome === "unknown" ? "insertion_uncertain" : "discarded_unseen", about);
    kernel.mark(messageId, "inserted", about);
    of(inserted, about.sessionId, () => new Set()).add(messageId);
  });
  kernel.hooks.on("acp.session_update", ({ sessionId, update }) => {
    const run = update._meta?.[RunExt.key] as RunUpdate | undefined;
    if (run?.turnId === null || run?.state === "idle") return;
    if (OUTPUT.has(update.sessionUpdate)) seen(sessionId);
  });
  kernel.hooks.on("acp.turn_ended", ({ sessionId, stopReason, failed }) => {
    if (!failed && stopReason !== "cancelled") return seen(sessionId);
    for (const id of inserted.get(sessionId) ?? []) {
      kernel.mark(id, "inserted_unprocessed");
      of(unprocessed, sessionId, () => new Set()).add(id);
    }
    inserted.delete(sessionId);
  });
  kernel.hooks.on("acp.session_renewed", ({ sessionId }) => {
    for (const id of unprocessed.get(sessionId) ?? []) kernel.mark(id, "discarded_unseen");
    unprocessed.delete(sessionId);
  });
}
