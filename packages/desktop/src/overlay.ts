/**
 * What is drawn over everything in an app window, web pages included: menus.
 *
 * A web page is a native view above the window's document (view-stack.ts), so a
 * menu of the document that should cover the page cannot be one of its elements.
 * It is drawn here instead: a transparent view of the app's own (renderer/overlay.html),
 * the size of the window, in the top layer, while it is open.
 *
 * It closes itself: a click outside what it shows (it covers the whole window,
 * so there is no outside it cannot see), Escape, or losing the focus. Nothing
 * else tells it to. The document that opened it waits for its answer; what it
 * shows is up to `kind`, which only the overlay's document knows how to draw.
 */
import { WebContentsView } from "electron";
import type { BrowserWindow, WebContents } from "electron";
import type { ViewStack } from "./view-stack.ts";

/** A request the overlay's document draws: `kind` picks how (renderer/overlay.js). */
export type OverlayRequest = { kind: string; [key: string]: unknown };

export class Overlay {
  private view?: WebContentsView;
  private current?: { seq: number; opener: WebContents; answer: (result: unknown) => void };
  private seq = 0;
  private win: BrowserWindow;
  private stack: ViewStack;
  private url: string;
  private preload: string;

  constructor(win: BrowserWindow, stack: ViewStack, url: string, preload: string) {
    this.win = win;
    this.stack = stack;
    this.url = url;
    this.preload = preload;
    win.on("resize", () => this.fit());
  }

  /** The overlay's document, which answers in `done`. */
  owns(contents: WebContents): boolean {
    return this.view?.webContents === contents;
  }

  /** Show `request` over the window. The answer is what the user chose; null when they closed it. */
  show(request: OverlayRequest, opener: WebContents): Promise<unknown> {
    if (this.current) this.done(this.current.seq, null);
    const view = (this.view ??= this.create());
    const seq = ++this.seq;
    this.fit();
    this.stack.put(view, "overlay");
    return new Promise((answer) => {
      this.current = { seq, opener, answer };
      const draw = (): void => {
        if (this.current?.seq !== seq) return;
        // The request's pointer coordinates and the menu are in the opener's CSS pixels.
        const zoom = opener.getZoomFactor();
        if (view.webContents.getZoomFactor() !== zoom) view.webContents.setZoomFactor(zoom);
        view.webContents.send("xsb:event", { overlay: { ...request, seq } });
        view.webContents.focus();
      };
      if (view.webContents.isLoadingMainFrame()) view.webContents.once("did-finish-load", draw);
      else draw();
    });
  }

  /** The overlay's document closed what it showed as `seq`. A late answer to one already replaced is ignored. */
  done(seq: number, result: unknown): void {
    const open = this.current;
    if (!open || open.seq !== seq) return;
    this.current = undefined;
    if (this.view && !this.win.isDestroyed()) this.stack.take(this.view);
    open.answer(result ?? null);
    // The keyboard goes back to where the user was, unless they left the window.
    if (!this.win.isDestroyed() && this.win.isFocused() && !open.opener.isDestroyed()) open.opener.focus();
  }

  dispose(): void {
    if (this.current) this.done(this.current.seq, null);
    if (this.view?.webContents && !this.view.webContents.isDestroyed()) this.view.webContents.close();
  }

  private create(): WebContentsView {
    const view = new WebContentsView({ webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    view.setBackgroundColor("#00000000");
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event) => event.preventDefault());
    void view.webContents.loadURL(this.url).catch(() => {});
    return view;
  }

  private fit(): void {
    if (!this.view || this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    this.view.setBounds({ x: 0, y: 0, width, height });
  }
}
