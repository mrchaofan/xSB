/**
 * The native views laid over an app window's own document, in layers.
 *
 * Electron has no z-index for views: what is drawn on top is the last child.
 * Re-adding a child puts it on top, and that is the one move used here.
 * Each change computes the order the layers want and makes it with the
 * fewest moves (`restack`), so a page that stays where it is is not touched.
 *
 *   overlay      menus over everything (overlay.ts)
 *   annotation   the editor of a note on the page shown (page-host.ts)
 *   control      the shield over a page an agent drives (page-host.ts)
 *   page         the web page shown (pages.ts)
 *   ─────────    the window's own document (index.html, page.html)
 */
import type { View } from "electron";

export const LAYERS = ["page", "control", "annotation", "overlay"] as const;
export type Layer = (typeof LAYERS)[number];

/**
 * How to turn `current` into `desired` by removing views and re-adding views on top: the longest start of
 * `desired` that `current` already has in order stays, everything after it is added again, in order.
 */
export function restack<T>(current: readonly T[], desired: readonly T[]): { remove: T[]; add: T[] } {
  const wanted = new Set(desired);
  let kept = 0;
  for (const item of current) if (item === desired[kept]) kept++;
  return { remove: current.filter((item) => !wanted.has(item)), add: desired.slice(kept) };
}

export class ViewStack {
  /** In the order they were put, which is their order within a layer. */
  private layers = new Map<View, Layer>();
  private root: View;

  constructor(root: View) {
    this.root = root;
  }

  /** Show `view` in `layer`. A view already in that layer keeps its place. */
  put(view: View, layer: Layer): void {
    if (this.layers.get(view) === layer) return;
    this.layers.delete(view);
    this.layers.set(view, layer);
    this.apply();
  }

  take(view: View): void {
    if (this.layers.delete(view)) this.apply();
  }

  has(view: View): boolean {
    return this.layers.has(view);
  }

  private apply(): void {
    const rank = (layer: Layer): number => LAYERS.indexOf(layer);
    const desired = [...this.layers].sort((a, b) => rank(a[1]) - rank(b[1])).map(([view]) => view);
    const { remove, add } = restack(this.root.children, desired);
    for (const view of remove) this.root.removeChildView(view);
    for (const view of add) this.root.addChildView(view);
  }
}
