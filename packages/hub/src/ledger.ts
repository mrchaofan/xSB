/** ACP insertion evidence only. Output, completion and context renewal never prove model receipt or revoke it. */
import type { Kernel } from "./kernel.ts";

export function ledgerHook(kernel: Kernel): void {
  /** Session -> inputs inserted in its running turn and not yet followed by anything. */
  const inserted = new Map<string, Set<string>>();
  const of = <T>(map: Map<string, T>, sessionId: string, make: () => T): T => map.get(sessionId) ?? (map.set(sessionId, make()), map.get(sessionId)!);
  const finish = (sessionId: string): void => {
    inserted.delete(sessionId);
  };

  kernel.hooks.on("message.insertion_receipt", ({ messageId, about, inserted: inThere, outcome }) => {
    if (!inThere) return kernel.mark(messageId, outcome === "unknown" ? "insertion_uncertain" : "discarded_unseen", about);
    kernel.mark(messageId, "inserted", about);
    of(inserted, about.sessionId, () => new Set()).add(messageId);
  });
  kernel.hooks.on("acp.turn_ended", ({ sessionId, stopReason, failed }) => {
    if (!failed && stopReason !== "cancelled") return finish(sessionId);
    for (const id of inserted.get(sessionId) ?? []) {
      kernel.mark(id, "inserted_unprocessed");
    }
    inserted.delete(sessionId);
  });
}
