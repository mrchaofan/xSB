/**
 * An app window that shows web pages: the main window (its side panel and the
 * preview of an HTML artifact) and the window of a page of its own.
 *
 * The window's document (renderer/page-slot.js) lays out where the page goes and
 * reports that rectangle; the page itself is a native view (pages.ts) placed
 * there, above the document. What the app draws over a page is then a view too,
 * each in its layer (view-stack.ts):
 *
 *   overlay      menus of the document (overlay.ts)
 *   annotation   the editor of the note on the element the user selected (renderer/annotation.js)
 *   control      the shield over a page an agent drives
 *   page         the page shown
 *
 * A window shows one page at a time. The shield takes the user's mouse and
 * leaves the keyboard focus where it was; the editor takes the focus when the
 * user selects an element and gives it back to the page when it closes.
 */
import { WebContentsView } from "electron";
import type { BrowserWindow, Rectangle, WebContents } from "electron";
import { Overlay } from "./overlay.ts";
import type { AnnotationTarget, Tone } from "./page-annotations.ts";
import { ViewStack } from "./view-stack.ts";

/** A page as a window shows it: what pages.ts tells about it. `annotation`: the user is annotating it. */
export type ShownPage = { id: string; view: WebContentsView; controlling: boolean; annotation?: { tone: Tone; target: AnnotationTarget | null } };
/** Where the app's own documents are. `controlText`: what the shield says, in the user's language. */
export type HostShell = { preload: string; overlayUrl: string; editorUrl: string; controlText: string };

/** The editor of a note: its size, in the page's viewport. */
const EDITOR = { width: 300, height: 156 };
const GAP = 8;

/** Where the editor goes in a page placed at `page`: below the element, or above it, or at the bottom when neither fits or the element is out of sight. */
export function editorBounds(page: Rectangle, element: Rectangle | null, zoom: number): Rectangle {
  const gap = Math.round(GAP * zoom);
  const width = Math.max(0, Math.min(Math.round(EDITOR.width * zoom), page.width - 2 * gap));
  const height = Math.max(0, Math.min(Math.round(EDITOR.height * zoom), page.height - 2 * gap));
  const bottom = Math.max(gap, page.height - height - gap);
  let left: number, top: number;
  if (!element) {
    left = Math.max(gap, (page.width - width) / 2);
    top = bottom;
  } else {
    const below = element.y + element.height + gap, above = element.y - height - gap;
    top = below + height <= page.height - gap ? below : above >= gap ? above : bottom;
    left = Math.max(gap, Math.min(element.x, page.width - width - gap));
  }
  return { x: Math.round(page.x + left), y: Math.round(page.y + top), width, height };
}

const sendWhenLoaded = (contents: WebContents, event: object): void => {
  if (contents.isLoadingMainFrame()) contents.once("did-finish-load", () => contents.send("xsb:event", event));
  else contents.send("xsb:event", event);
};

export class PageHost {
  readonly win: BrowserWindow;
  readonly document: WebContents;
  readonly overlay: Overlay;
  private stack: ViewStack;
  private shell: HostShell;
  private shown?: { page: ShownPage; bounds: Rectangle; lent?: boolean };
  private shield?: WebContentsView;
  private editor?: WebContentsView;
  /** What the editor was last told: a new selection is a new note. */
  private editing?: { pageId: string; seq: number; tone: Tone };

  constructor(win: BrowserWindow, shell: HostShell) {
    this.win = win;
    this.document = win.webContents;
    this.shell = shell;
    this.stack = new ViewStack(win.contentView);
    this.overlay = new Overlay(win, this.stack, shell.overlayUrl, shell.preload);
  }

  /** Whether `contents` is one of this window's own documents: the window's, its overlay's or its editor's. */
  owns(contents: WebContents): boolean {
    return contents === this.document || this.overlay.owns(contents) || this.editor?.webContents === contents;
  }

  showing(id: string): boolean {
    return this.shown?.page.id === id && !this.shown.lent;
  }

  /** Show `page` at `given`, a rectangle of the window's document. An empty one shows nothing. */
  place(page: ShownPage, given: Rectangle, lent = false): void {
    if (![given.x, given.y, given.width, given.height].every(Number.isFinite)) throw new Error("invalid page bounds");
    const size = this.win.getContentBounds();
    // The slot is measured in the document's CSS pixels. Native view bounds are window DIPs.
    const zoom = this.document.getZoomFactor();
    const x = Math.max(0, Math.min(size.width, Math.round(given.x * zoom))), y = Math.max(0, Math.min(size.height, Math.round(given.y * zoom)));
    const right = Math.min(size.width, Math.round((given.x + given.width) * zoom));
    const bottom = Math.min(size.height, Math.round((given.y + given.height) * zoom));
    const bounds = { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
    if (!bounds.width || !bounds.height) return this.remove(page.id);
    if (this.shown && !this.shown.lent && (this.shown.page.id !== page.id || lent)) this.takePage(this.shown.page.view);
    this.shown = { page, bounds, lent };
    this.drawSlot();
  }

  /** Stop showing the page `id`, if this window shows it. */
  remove(id: string): void {
    if (!this.shown || this.shown.page.id !== id) return;
    if (!this.shown.lent) this.takePage(this.shown.page.view);
    this.shown = undefined;
    this.decorate();
  }

  /**
   * Whether the page `id` is shown where it is drawn. A hidden or minimized window draws nothing,
   * and a page in it has no frame for a screenshot.
   */
  draws(id: string): boolean {
    return this.showing(id) && this.win.isVisible() && !this.win.isMinimized();
  }

  /** Draw a page elsewhere while keeping its slot. A hidden window can still receive new layout reports. */
  lend(id: string): void {
    const slot = this.shown;
    if (!slot || slot.page.id !== id || slot.lent) return;
    slot.lent = true;
    this.takePage(slot.page.view);
    this.decorate();
  }

  /** Return the page to the current slot if the document still wants it there. */
  reclaim(id: string): void {
    const slot = this.shown;
    if (!slot?.lent || slot.page.id !== id || this.win.isDestroyed()) return;
    slot.lent = false;
    this.drawSlot();
  }

  private drawSlot(): void {
    const slot = this.shown!;
    if (!slot.lent) {
      slot.page.view.setBounds(slot.bounds);
      this.stack.put(slot.page.view, "page");
    }
    this.decorate();
  }

  /** The page changed: its shield and editor follow. */
  update(page: ShownPage): void {
    if (!this.shown || this.shown.page.id !== page.id) return;
    this.shown.page = page;
    this.decorate();
  }

  dispose(): void {
    this.overlay.dispose();
    for (const view of [this.shield, this.editor]) if (view?.webContents && !view.webContents.isDestroyed()) view.webContents.close();
  }

  /**
   * Take a page off the window. If it had the keyboard, the window's document takes it back: left alone, the
   * system would give it to whichever view is next, a page the user did not open among them.
   */
  private takePage(view: WebContentsView): void {
    if (this.win.isDestroyed()) return;
    const focused = view.webContents && !view.webContents.isDestroyed() && view.webContents.isFocused();
    this.stack.take(view);
    if (focused && this.win.isFocused()) this.document.focus();
  }

  private decorate(): void {
    if (this.win.isDestroyed()) return;
    const { page, bounds } = (this.shown?.lent ? undefined : this.shown) ?? {};
    if (page?.controlling && bounds) {
      const shield = (this.shield ??= this.createShield());
      shield.setBounds(bounds);
      this.stack.put(shield, "control");
    } else if (this.shield) this.stack.take(this.shield);

    const target = page?.annotation?.target;
    if (page && bounds && target?.seq) {
      const editor = (this.editor ??= this.createView(this.shell.editorUrl, this.shell.preload));
      // Inspector rectangles use the website's CSS pixels. The editor is sized at the app document's zoom.
      const zoom = page.view.webContents.getZoomFactor(), rect = target.rect;
      const element = rect && { x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom };
      const editorZoom = this.document.getZoomFactor();
      if (editor.webContents.getZoomFactor() !== editorZoom) editor.webContents.setZoomFactor(editorZoom);
      editor.setBounds(editorBounds(bounds, element, editorZoom));
      this.stack.put(editor, "annotation");
      const tone = page.annotation!.tone;
      const fresh = this.editing?.pageId !== page.id || this.editing.seq !== target.seq;
      if (fresh || this.editing?.tone !== tone) {
        this.editing = { pageId: page.id, seq: target.seq, tone };
        sendWhenLoaded(editor.webContents, { annotationEditor: { pageId: page.id, seq: target.seq, label: target.label, tone } });
      }
      // The user just selected the element: what they type next is the note.
      if (fresh) editor.webContents.focus();
    } else if (this.editor && this.stack.has(this.editor)) {
      const focused = this.editor.webContents.isFocused();
      this.editing = undefined;
      this.stack.take(this.editor);
      if (focused && page) page.view.webContents.focus();
    }
  }

  /** The shield says an agent drives the page and takes the user's mouse. A click on it leaves the keyboard where it was. */
  private createShield(): WebContentsView {
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font:13px system-ui,sans-serif;user-select:none;cursor:not-allowed}
.frame{position:fixed;inset:0;box-sizing:border-box;border:3px solid #f04452;background:rgba(240,68,82,.025);box-shadow:inset 0 0 18px rgba(240,68,82,.55);animation:control-breathe 1.8s ease-in-out infinite}
.label{position:absolute;top:10px;left:50%;transform:translateX(-50%);padding:7px 14px;border-radius:18px;color:#fff;background:#b92335;white-space:nowrap;box-shadow:0 3px 12px #0003}
@keyframes control-breathe{50%{border-color:#ff8790;box-shadow:inset 0 0 34px rgba(240,68,82,.8)}}
@media(prefers-reduced-motion:reduce){.frame{animation:none}}
</style></head><body><div class="frame"><div class="label" role="status">${escapeHtml(this.shell.controlText)}</div></div></body></html>`;
    const view = this.createView(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    // The shield has no input controls. Consume the pointer before it can focus its document.
    view.webContents.on("before-mouse-event", event => event.preventDefault());
    view.webContents.on("focus", () => {
      if (!this.win.isDestroyed() && this.win.isFocused()) this.document.focus();
    });
    return view;
  }

  private createView(url: string, preload?: string): WebContentsView {
    const view = new WebContentsView({ webPreferences: { ...(preload && { preload, zoomFactor: this.document.getZoomFactor() }), sandbox: true, contextIsolation: true, nodeIntegration: false, focusOnNavigation: false } });
    view.setBackgroundColor("#00000000");
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event) => event.preventDefault());
    void view.webContents.loadURL(url).catch(() => {});
    return view;
  }
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
