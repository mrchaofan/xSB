/**
 * AuditHook: every event of the kernel, every veto and every dead letter, appended to `.xsb2/audit.jsonl`. It is a
 * record for people, not state: nothing reads it back.
 */
import type { Store } from "@xsb/store";
import type { HookReports } from "./hooks.ts";
import type { KernelHooks, KernelObserve } from "./kernel.ts";
import { now } from "./util.ts";

const FILE = "audit.jsonl";

/** What is audited: every point but the backends' stream of updates, which the transcripts keep. */
const POINTS: (keyof KernelObserve)[] = [
  "task.created",
  "task.started",
  "task.stopping",
  "task.ended",
  "message.routed",
  "message.withdrawn",
  "notify.delivered",
  "message.insertion_receipt",
  "message.ledger",
  "acp.turn_ended",
  "acp.session_renewed",
];

/** What the hooks report of vetoes and dead letters, written to the audit; and their log line. */
export function auditReports(store: Store, log: (line: string) => void): HookReports {
  return {
    log,
    vetoed: (point, payload, veto) => store.append(FILE, { ts: now(), point, veto: veto.veto, payload }, false),
    deadLetter: (point, event, error) => store.append(FILE, { ts: now(), point, deadLetter: true, error: String(error), event }, false),
  };
}

export function auditHook(hooks: KernelHooks, store: Store): void {
  for (const point of POINTS) hooks.on(point, (event) => store.append(FILE, { ts: now(), point, event }, false));
}
