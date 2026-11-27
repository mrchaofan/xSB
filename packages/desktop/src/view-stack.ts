/**
 * The native views laid over an app window's own document, in layers.
 *
 * Electron draws its last child on top. Insert each view at its layer so showing
 * a control shield never reattaches the page, an open menu or an active editor.
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

export class ViewStack {
  private layers = new Map<View, Layer>();
  private root: View;

  constructor(root: View) {
    this.root = root;
  }

  /** Show `view` in `layer`. A view already in that layer keeps its place. */
  put(view: View, layer: Layer): void {
    if (this.layers.get(view) === layer) return;
    this.layers.delete(view);
    const rank = LAYERS.indexOf(layer);
    const index = [...this.layers.values()].filter(existing => LAYERS.indexOf(existing) <= rank).length;
    this.root.addChildView(view, index);
    this.layers.set(view, layer);
  }

  take(view: View): void {
    if (this.layers.delete(view)) this.root.removeChildView(view);
  }

  has(view: View): boolean {
    return this.layers.has(view);
  }
}
