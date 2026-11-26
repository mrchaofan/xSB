/** Immutable, nonblocking observations; causality never grants execution authority. */
import type { ExecutionSource } from "@xsb/protocol";
import type { KernelHooks } from "./kernel.ts";
import { newId, now } from "./util.ts";

export type LifecycleEvent = { eventId: string; ts: string; source: ExecutionSource; data: Record<string, unknown> };
export type LifecyclePoint = "session.opened" | "session.bound" | "session.closed" | "session.unbound" | "session.background_changed" | "turn.started" | "turn.ended" | "step.started" | "step.ended";
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
export class Lifecycle {
  private hooks: KernelHooks;
  constructor(hooks: KernelHooks) { this.hooks = hooks; }
  emit(point: LifecyclePoint, source: ExecutionSource, data: Record<string, unknown> = {}): void {
    const event = freeze(structuredClone({ eventId: newId("evt"), ts: now(), source, data }));
    this.hooks.emit(point, event);
  }
  step(source: ExecutionSource, stepId: string, data: Record<string, unknown> = {}): { source: ExecutionSource; end(data?: Record<string, unknown>): void } {
    const captured = freeze(structuredClone({ ...source, stepId }));
    this.emit("step.started", captured, data);
    let ended = false;
    return { source: captured, end: (result = {}) => { if (!ended) { ended = true; this.emit("step.ended", captured, result); } } };
  }
}
