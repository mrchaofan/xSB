/**
 * The task graph (docs/TASK-GRAPH.md). Tasks are its nodes; a task has two kinds of edges, both to tasks that existed
 * when it was made, so the graph has no cycles and the order tasks were made in is a topological order:
 *
 *   parents  the tasks it was started for (inferred by the hub; none: the session's own work, the root)
 *   after    the tasks it waits for before it starts (said by the dispatcher)
 *
 * Pure functions over the tasks and their reversed edges; nothing here writes or delivers.
 */
import { isTerminal } from "@xsb/protocol";
import type { Task } from "@xsb/protocol";

/** The edges, reversed: task id -> the tasks started for it (`children`), and those that wait for it (`waiters`). */
export type Graph = { children: Map<string, string[]>; waiters: Map<string, string[]> };

type Tasks = { tasks: Map<string, Task>; graph: Graph };

/** What holds up the session's own work, which no task's end takes along. */
const ROOT = "";

export function addEdges(graph: Graph, task: Task): void {
  const add = (index: Map<string, string[]>, from: string): void => void index.set(from, [...(index.get(from) ?? []), task.id]);
  for (const id of task.parents ?? []) add(graph.children, id);
  for (const id of task.after) add(graph.waiters, id);
}

/**
 * What holds a task up: each parent that has not ended; for one that was completed, what held that up, for what it
 * left running is its dispatcher's now; the root for a task started for nothing. A parent that ended otherwise
 * (cancelled, failed, interrupted) holds nothing up any more. Memoised in `memo`, for a task is asked about once per walk.
 */
function holders(g: Tasks, id: string, memo: Map<string, Set<string>>): Set<string> {
  const known = memo.get(id);
  if (known) return known;
  const held = new Set<string>();
  const parents = g.tasks.get(id)?.parents ?? [];
  if (!parents.length) held.add(ROOT);
  for (const p of parents) {
    const parent = g.tasks.get(p);
    if (!parent) held.add(ROOT);
    else if (!isTerminal(parent.status)) held.add(p);
    else if (parent.status === "completed") for (const h of holders(g, p, memo)) held.add(h);
  }
  memo.set(id, held);
  return held;
}

/**
 * What stopping `root` takes along: every unfinished task below it (through tasks that ended, too) that nothing but
 * what is stopped holds up, in the order they were made (`doomed`, `root` first). `spared`: unfinished tasks that
 * the stopped ones held up together with something that goes on, which therefore go on. `force`: those go too.
 */
export function doom(g: Tasks, root: Task, force = false): { doomed: Task[]; spared: Task[] } {
  return doomMany(g, [root], force ? new Set([root.id]) : new Set());
}

/** Compute one cancellation set for all roots before any of them releases dependencies. */
export function doomMany(g: Tasks, roots: Task[], force = new Set<string>()): { doomed: Task[]; spared: Task[] } {
  // Nothing holding a task up any more (every parent of it was stopped) is no reason to keep it: it goes too.
  const below = new Set<string>();
  const queue = roots.map((t) => t.id);
  while (queue.length) {
    for (const child of g.graph.children.get(queue.pop()!) ?? []) {
      if (below.has(child)) continue;
      below.add(child);
      queue.push(child);
    }
  }
  const forcedBelow = new Set<string>();
  const forcedQueue = [...force];
  while (forcedQueue.length) for (const child of g.graph.children.get(forcedQueue.pop()!) ?? []) {
    if (!forcedBelow.has(child)) { forcedBelow.add(child); forcedQueue.push(child); }
  }
  const stopped = new Set(roots.map((t) => t.id));
  const doomed = [...roots];
  const spared: Task[] = [];
  const memo = new Map<string, Set<string>>();
  for (const task of g.tasks.values()) {
    if (!below.has(task.id) || stopped.has(task.id) || isTerminal(task.status)) continue;
    const held = [...holders(g, task.id, memo)];
    if (held.every((h) => stopped.has(h)) || (forcedBelow.has(task.id) && held.some((h) => stopped.has(h)))) {
      stopped.add(task.id);
      doomed.push(task);
    } else if (held.some((h) => stopped.has(h))) {
      spared.push(task);
    }
  }
  return { doomed, spared };
}

/** The held-back tasks that may start once the tasks `ended` have ended: those not among them that waited for nothing else. */
export function releasable(g: Tasks, ended: Set<string>): Task[] {
  const done = (id: string): boolean => ended.has(id) || !g.tasks.get(id) || isTerminal(g.tasks.get(id)!.status);
  const candidates = new Set([...ended].flatMap((id) => g.graph.waiters.get(id) ?? []));
  return [...candidates]
    .map((id) => g.tasks.get(id)!)
    .filter((t) => t.status === "blocked" && !ended.has(t.id) && t.after.every(done));
}

/** The unfinished tasks started for `id`. */
export function startedFor(g: Tasks, id: string): Task[] {
  return (g.graph.children.get(id) ?? []).map((c) => g.tasks.get(c)!).filter((t) => !isTerminal(t.status));
}
