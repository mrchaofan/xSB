import type { Store } from "@xsb/store";
import { Paths } from "./paths.ts";

type Session = { agentId: string; id: string };
export type WorkflowAudit =
  | { kind: "tool"; tool: string; receipt: string; arguments: string; result: string }
  | { kind: "tool"; tool: string; receipt: string; arguments: string; error: string }
  | { kind: "context"; context: string }
  | { kind: "scope"; messageId: string; scope: string };

export const workflowJournal = (s: Session): string => `agents/${s.agentId}/workflow/${s.id}.jsonl`;

export function workflowAuditRecord(s: Session, turnId: string, ts: string, event: WorkflowAudit) {
  return { schemaVersion: 1 as const, source: "workflow" as const, agentId: s.agentId, sessionId: s.id, turnId, ts, ...event };
}

/** Newest first. Earlier releases wrote these three records to the session transcript without a schema or kind. */
export function* readWorkflowJournal(store: Store, s: Session) {
  for (const record of store.readBackward(workflowJournal(s))) {
    if (record.schemaVersion === 1 && record.source === "workflow" && record.sessionId === s.id && record.agentId === s.agentId)
      yield record;
  }
  for (const { ts, update } of store.readBackward(Paths.transcript(s.agentId, s.id))) {
    const old = update?.sessionUpdate === "session_info_update" && update._meta?.["dev.xsb/workflow-log"];
    if (!old || typeof ts !== "string" || typeof old.turnId !== "string") continue;
    let event: WorkflowAudit;
    if (typeof old.context === "string") event = { kind: "context", context: old.context };
    else if (typeof old.scope === "string" && typeof old.messageId === "string")
      event = { kind: "scope", messageId: old.messageId, scope: old.scope };
    else if (typeof old.tool === "string" && typeof old.receipt === "string" && typeof old.arguments === "string") {
      const tool = { kind: "tool" as const, tool: old.tool, receipt: old.receipt, arguments: old.arguments };
      if (typeof old.result === "string") event = { ...tool, result: old.result };
      else if (typeof old.error === "string") event = { ...tool, error: old.error };
      else continue;
    } else continue;
    yield workflowAuditRecord(s, old.turnId, ts, event);
  }
}
