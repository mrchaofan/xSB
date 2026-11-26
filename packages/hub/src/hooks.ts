/**
 * Hooks: the framework's extension points. Every point exists whether or not anything is registered on it; what the
 * system itself does at a point (its policies, its effectors) is registered like anything else, and can be
 * overruled or replaced the same way.
 *
 *   decide   handlers run in the order they were registered; each is given what the one before returned and returns
 *            it, changed or not, or vetoes. A handler that throws vetoes too (fail-closed): what nobody could approve
 *            does not happen. A veto is reported (`vetoed`), for the audit.
 *   observe  events are fanned out after the change they report is committed, in the order they were emitted, but
 *            not within the call that emitted them. Every handler gets every event; one that fails is tried again,
 *            up to `retries` times, and then the event is a dead letter for it (`deadLetter`). A failing handler
 *            never keeps the others from an event.
 */
export type Veto = { veto: string };
export const isVeto = (x: unknown): x is Veto => typeof x === "object" && x !== null && "veto" in x;

type Points = Record<string, unknown>;
type Observer = { handler: (event: any) => void | Promise<void>; retries: number };

export type HookReports = {
  log(line: string): void;
  vetoed(point: string, payload: unknown, veto: Veto): void;
  deadLetter(point: string, event: unknown, error: unknown): void;
};

/** How often an observer that failed is tried again with the same event. */
const RETRIES = 2;

export class Hooks<Decide extends Points, Observe extends Points> {
  private deciders = new Map<keyof Decide, ((payload: any) => any)[]>();
  private observers = new Map<keyof Observe, Observer[]>();
  private pending: { point: keyof Observe; event: unknown }[] = [];
  private draining?: Promise<void>;
  private active = new Set<Promise<void>>();
  private reports: HookReports;

  constructor(reports: HookReports) {
    this.reports = reports;
  }

  decider<K extends keyof Decide>(point: K, handler: (payload: Decide[K]) => Decide[K] | Veto): void {
    this.deciders.set(point, [...(this.deciders.get(point) ?? []), handler]);
  }

  on<K extends keyof Observe>(point: K, handler: (event: Observe[K]) => void | Promise<void>, options: { retries?: number } = {}): () => void {
    const observer = { handler, retries: options.retries ?? RETRIES };
    this.observers.set(point, [...(this.observers.get(point) ?? []), observer]);
    return () => this.observers.set(point, (this.observers.get(point) ?? []).filter((h) => h !== observer));
  }

  decide<K extends keyof Decide>(point: K, payload: Decide[K]): Decide[K] | Veto {
    let current = payload;
    for (const handler of this.deciders.get(point) ?? []) {
      let next: Decide[K] | Veto;
      try {
        next = handler(current);
        if (next && typeof (next as any).then === "function") {
          void Promise.resolve(next).catch(() => {});
          next = { veto: `${String(point)}: decision hooks must be synchronous` };
        }
      } catch (e) {
        next = { veto: `${String(point)}: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (isVeto(next)) {
        this.reports.vetoed(String(point), current, next);
        return next;
      }
      current = next;
    }
    return current;
  }

  emit<K extends keyof Observe>(point: K, event: Observe[K]): void {
    if (!this.observers.get(point)?.length) return;
    this.pending.push({ point, event });
    this.draining ??= Promise.resolve().then(() => this.drain());
  }

  /** Resolves once every event emitted so far has been handed to its observers. */
  async settled(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** Explicit observer barrier, never part of ending a turn. */
  async completed(): Promise<void> {
    do { await this.settled(); await Promise.all([...this.active]); } while (this.draining || this.active.size);
  }

  private drain(): void {
    for (let next = this.pending.shift(); next; next = this.pending.shift()) {
      for (const handler of this.observers.get(next.point) ?? []) this.attempt(String(next.point), handler, next.event, 0);
    }
    this.draining = undefined;
  }

  private attempt(point: string, handler: Observer, event: unknown, tries: number): void {
    const failed = (e: unknown): void => {
      if (tries < handler.retries) return this.attempt(point, handler, event, tries + 1);
      this.reports.log(`hook ${point}: dead letter after ${tries + 1} tries: ${e instanceof Error ? e.stack : String(e)}`);
      this.reports.deadLetter(point, event, e);
    };
    try {
      const done = handler.handler(event);
      if (done && typeof done.then === "function") {
        const work = Promise.resolve(done).then(() => {}, failed);
        this.active.add(work);
        void work.then(() => this.active.delete(work), () => this.active.delete(work));
      }
    } catch (e) {
      failed(e);
    }
  }
}
