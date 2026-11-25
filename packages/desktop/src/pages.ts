/**
 * The web pages of one window: the page tabs of its side panel.
 *
 * A page is a WebContents that the main process owns. Explicitly opened pages use
 * (`webContents.create({ type: "webview2" })`, an API of the private Electron
 * build this app runs on; see scripts/patch-electron.mjs). A document shows
 * one with `<webview2 web-contents-id>`. Taking the element away does not
 * touch the page, and that is what lets a page move between the side panel
 * and a window of its own without loading again. Chromium-created popup guests
 * instead use a WebContentsView in the same tab viewport, preserving their opener:
 *
 *   side panel   (renderer/pages.js)        ┐
 *   page window  (renderer/page-window.js)  ┴ <webview2> ──shows──▶ a page here
 *
 * Both are told of every change as `{ page }` and `{ removedPage }` events.
 * A page ends when its tab is closed, when its window is closed, or with the
 * window whose side panel it belongs to.
 */
import { BrowserWindow, WebContentsView, session, shell, webContents } from "electron";
import type { BrowserWindowConstructorOptions, Rectangle, WebContents, WebPreferences } from "electron";
import { address } from "./address.ts";
import type { PageView } from "./bridge.ts";
import { ownDownloads } from "./browser-downloads.ts";
import type { BrowserDownloads } from "./browser-downloads.ts";
import { controlInput, installInputGuard } from "./page-input.ts";
import { Annotator, NOTE_LIMIT } from "./page-annotations.ts";
import type { AnnotationTarget, Tone } from "./page-annotations.ts";

/** What the private Electron adds to the official one's types. */
type Webview2 = WebContents & { isAttached(): boolean; detach(): boolean; destroy(): void };
const create = (webContents as unknown as { create?: (options: WebPreferences & { type: "webview2" }) => Webview2 }).create;

/** Web pages keep their cookies and logins here, apart from the app's own pages. */
const WEB_PARTITION = "persist:xsb-web";
/** Previews of the HTML files agents wrote: the only pages that can read `xsb-artifact://`, and no website is among them. */
export const PREVIEW_PARTITION = "xsb-preview";

export type PageOptions = { sessionId?: string; embedded?: boolean; agent?: boolean; downloads?: BrowserDownloads; onPopup?: (id: string, openerId: string) => void };
type Page = { id: string; contents: Webview2; embedded: boolean; agent: boolean; controlling?: boolean; controlBounds?: { sender: WebContents; bounds: Rectangle | null }; controlView?: WebContentsView; controlHost?: BrowserWindow; window?: BrowserWindow; nativeView?: WebContentsView; viewHost?: BrowserWindow; error?: string; favicon?: string; releaseDownloads?: () => void; annotator?: Annotator; options: PageOptions };
/** Where the app's own files are, for a page's window. */
/** `toneOf`: the style of annotations on a page of this session (page-annotations.ts), after its agent's backend. */
type Shell = { preload: string; pageWindowUrl: string; controlText?: string; toneOf?: (sessionId?: string) => Tone };

export class Pages {
  /** False on an Electron without `<webview2>` (the official one): there are no page tabs then. */
  static readonly supported = typeof create === "function";

  private pages = new Map<string, Page>();
  private seq = 0;
  private host: WebContents;
  private shell: Shell;

  constructor(host: WebContents, shell: Shell) {
    this.host = host;
    this.shell = shell;
    // Neither a website nor a page an agent wrote gets camera, location or notifications by asking.
    for (const partition of [WEB_PARTITION, PREVIEW_PARTITION]) {
      session.fromPartition(partition).setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
    }
  }

  /** The page tabs, in the order they were opened. */
  list(): PageView[] {
    return [...this.pages.values()].filter((page) => !page.embedded).map((page) => this.view(page));
  }

  /**
   * Open a page. An embedded one is shown inside something else (the preview of an HTML
   * artifact) and is no tab; one an agent opened says so on its tab.
   */
  open(url: string, options: PageOptions = {}): PageView {
    const { embedded = false } = options;
    if (url !== "about:blank" && !(embedded && url.startsWith("xsb-artifact:"))) url = address(url);
    if (!create) throw new Error("this Electron has no <webview2>");
    const contents = create.call(webContents, {
      type: "webview2",
      partition: url.startsWith("xsb-artifact:") ? PREVIEW_PARTITION : WEB_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    const page = this.register(contents, options);
    void contents.loadURL(url).catch(() => {});
    this.changed(page);
    return this.view(page);
  }

  /** All pages, including Chromium's pre-created native popups, share ownership and lifecycle. */
  private register(contents: Webview2, options: PageOptions, nativeView?: WebContentsView): Page {
    const { embedded = false, agent = false, downloads } = options;
    const page: Page = { id: `p${++this.seq}`, contents, embedded, agent, options, nativeView };
    nativeView?.setVisible(false);
    this.pages.set(page.id, page);
    installInputGuard(contents);
    if (downloads) page.releaseDownloads = ownDownloads(contents, page.id, downloads, () => { page.error = undefined; this.changed(page); });
    contents.once("destroyed", () => this.close(page));

    const changed = (): void => this.changed(page);
    for (const event of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"] as const) contents.on(event as any, changed);
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) page.error = undefined;
    });
    // The tab shows the site's icon. Only web and inline images: nothing that reaches the app's own files.
    contents.on("did-navigate", () => { page.favicon = undefined; });
    contents.on("page-favicon-updated", (_event, favicons) => {
      page.favicon = favicons.find((url) => /^(https?:|data:image\/)/i.test(url));
      changed();
    });
    contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;      // -3: the load was aborted, by another one
      page.error = description;
      changed();
    });
    // Keep the opener intact. Chromium, rather than loadURL, performs the child navigation.
    contents.setWindowOpenHandler(({ url: target }) => {
      if (!/^https?:/i.test(target) && target !== "about:blank" && !target.startsWith("blob:")) return { action: "deny" };
      // Preview pages must not hand their private artifact partition to a website.
      if (page.embedded) {
        if (/^https?:/i.test(target)) this.open(target, { sessionId: page.options.sessionId });
        return { action: "deny" };
      }
      return {
        action: "allow",
        outlivesOpener: true,
        overrideBrowserWindowOptions: { webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } },
        createWindow: (nativeOptions) => {
          // Electron has ALREADY created the guest. Replacing it with create()
          // breaks its contract and loses opener/POST state. It has no webview2
          // attachment bridge. Adopt it into a managed View in the tab's bounds;
          // never create an Electron window for a website popup.
          const guest = (nativeOptions as BrowserWindowConstructorOptions & { webContents: Webview2 }).webContents;
          const child = this.register(guest, page.options, new WebContentsView({ webContents: guest }));
          this.changed(child);
          page.options.onPopup?.(child.id, page.id);
          return guest;
        },
      };
    });
    return page;
  }

  /** One thing done to a page: by its tab, its window, or an agent. */
  call(id: string, op: string, arg?: unknown): void {
    const page = this.pages.get(id);
    if (!page) throw new Error("this page was closed");
    const { contents, window } = page;
    if (page.controlling && ["navigate", "back", "forward", "reload", "external"].includes(op)) throw new Error(this.shell.controlText ?? "An agent is controlling this page");
    if (op === "navigate") void this.navigate(id, String(arg)).catch(() => {});
    else if (op === "back") contents.navigationHistory.goBack();
    else if (op === "forward") contents.navigationHistory.goForward();
    else if (op === "reload") contents.reload();
    else if (op === "external") void shell.openExternal(contents.getURL());
    else if (op === "close") this.close(page);
    else if (op === "detach") this.detach(page);
    else if (op === "restore") this.restore(page);
    else if (op === "show") window?.show();
    else if (op === "pin") window?.setAlwaysOnTop(arg === true);
    else throw new Error(`unknown page operation ${op}`);
    if (op === "pin") this.changed(page);
  }

  /** The address bar and browser tools use the same validation and navigation. */
  navigate(id: string, given: string): Promise<void> {
    const contents = this.contents(id);
    if (!contents) throw new Error("this page was closed");
    return contents.loadURL(address(given));
  }

  /** The page's WebContents, for what drives it (browser.ts). */
  contents(id: string): WebContents | undefined {
    return this.pages.get(id)?.contents;
  }

  /** The trusted renderer gives native popup tabs their viewport. Stale updates from
   * a former host cannot move a page back after a detach/restore operation.
   */
  layout(id: string, sender: WebContents, bounds: Rectangle | null): void {
    const page = this.pages.get(id);
    if (!page?.nativeView || sender !== (page.window?.webContents ?? this.host)) return;
    const owner = BrowserWindow.fromWebContents(sender);
    if (!owner || owner.isDestroyed()) return;
    if (!bounds) { page.nativeView.setVisible(false); return; }
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) throw new Error("invalid page bounds");
    const size = owner.getContentBounds();
    const x = Math.max(0, Math.min(size.width, Math.round(bounds.x)));
    const y = Math.max(0, Math.min(size.height, Math.round(bounds.y)));
    const width = Math.max(0, Math.min(size.width - x, Math.round(bounds.width)));
    const height = Math.max(0, Math.min(size.height - y, Math.round(bounds.height)));
    if (page.viewHost !== owner) {
      this.unmount(page);
      owner.contentView.addChildView(page.nativeView);
      page.viewHost = owner;
    }
    page.nativeView.setBounds({ x, y, width, height });
    page.nativeView.setVisible(width > 0 && height > 0);
    if (page.controlView?.getVisible() && page.controlHost === owner) owner.contentView.addChildView(page.controlView);
  }

  /**
   * The user's annotations (page-annotations.ts), asked for by the host that shows the page and by
   * no one else. The host never names a node: it confirms or drops the one the user selected.
   */
  async annotate(id: string, sender: WebContents, op: string, arg?: unknown): Promise<void> {
    const page = this.pages.get(id);
    if (!page) throw new Error("this page was closed");
    const annotator = page.annotator;
    // The composer of the page's conversation, in the main window, takes out notes it sent or dropped.
    if (op === "annotationsRemove") {
      if (sender !== this.host && sender !== this.hostOf(page)) throw new Error("this page is shown elsewhere");
      const ids = Array.isArray(arg) && arg.length <= 200 && arg.every((id) => typeof id === "string" && id.length <= 64) ? arg as string[] : undefined;
      if (!ids) throw new Error("annotationsRemove takes a list of ids");
      return annotator?.remove(ids);
    }
    if (sender !== this.hostOf(page)) throw new Error("this page is shown elsewhere");
    if (op === "annotate") {
      if (typeof arg !== "boolean") throw new Error("annotate takes true or false");
      if (!arg) return annotator?.stop();
      if (page.controlling) throw new Error(this.shell.controlText ?? "An agent is controlling this page");
      if (page.nativeView || page.embedded) throw new Error("this page cannot be annotated");
      page.annotator ??= new Annotator(page.contents, (target) => this.sendTarget(page, target), () => this.changed(page),
        () => this.shell.toneOf?.(page.options.sessionId) ?? "default");
      return page.annotator.start();
    }
    if (!annotator?.active) throw new Error("annotation mode is off");
    if (op === "annotationSave") {
      const text = typeof arg === "string" ? arg.trim() : "";
      if (!text || text.length > NOTE_LIMIT) throw new Error(`a note has 1 to ${NOTE_LIMIT} characters`);
      // The note, the element and its picture go to the page's conversation, whose composer is in the main window.
      const annotation = await annotator.save(page.id, text);
      if (!this.host.isDestroyed()) this.host.send("xsb:event", { webAnnotation: { pageId: page.id, sessionId: page.options.sessionId, annotation } });
      return;
    }
    if (op === "annotationDiscard") return annotator.discard();
    if (op === "annotationsClear") {
      const ids = await annotator.clear();
      if (ids.length && !this.host.isDestroyed()) this.host.send("xsb:event", { webAnnotationsRemoved: { pageId: page.id, sessionId: page.options.sessionId, ids } });
      return;
    }
    throw new Error(`unknown page operation ${op}`);
  }

  /** Where the node being annotated is goes only to the host that shows the page. */
  private sendTarget(page: Page, target: AnnotationTarget | null): void {
    const host = this.hostOf(page);
    if (!host.isDestroyed()) host.send("xsb:event", { annotationTarget: { pageId: page.id, ...(target ?? { seq: 0, rect: null, label: "" }) } });
  }

  private hostOf(page: Page): WebContents {
    return page.window?.webContents ?? this.host;
  }

  /** Control lasts one browser tool call (browser.ts): a shield above the page, user input blocked. */
  setAgentControl(id: string, controlling: boolean): void {
    const page = this.pages.get(id);
    if (!page || page.controlling === controlling) return;
    page.controlling = controlling;
    // An agent taking the page ends the user's annotating; the notes stay.
    if (controlling) page.annotator?.stop();
    controlInput(page.contents, controlling);
    if (!controlling) this.unmountControl(page);
    else if (page.controlBounds?.bounds) this.controlLayout(id, page.controlBounds.sender, page.controlBounds.bounds);
    this.changed(page);
  }

  controlLayout(id: string, sender: WebContents, bounds: Rectangle | null): void {
    const page = this.pages.get(id);
    if (!page || sender !== (page.window?.webContents ?? this.host)) return;
    page.controlBounds = { sender, bounds };
    if (!bounds || !page.controlling) { this.unmountControl(page); return; }
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) throw new Error("invalid page bounds");
    const owner = BrowserWindow.fromWebContents(sender);
    if (!owner || owner.isDestroyed()) return;
    if (!page.controlView) {
      const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      page.controlView = view;
      view.setBackgroundColor("#00000000");
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const label = this.shell.controlText ?? "An agent is controlling this page";
      const html = `<!doctype html><html><head><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font:13px system-ui;user-select:none;cursor:not-allowed}
.frame{position:fixed;inset:0;box-sizing:border-box;border:3px solid #f04452;background:rgba(240,68,82,.025);box-shadow:inset 0 0 18px rgba(240,68,82,.55);animation:breathe 1.8s ease-in-out infinite}
.label{position:absolute;top:10px;left:50%;transform:translateX(-50%);padding:7px 14px;border-radius:18px;color:#fff;background:#b92335;white-space:nowrap;box-shadow:0 3px 12px #0003}
@keyframes breathe{50%{border-color:#ff8790;box-shadow:inset 0 0 34px rgba(240,68,82,.8)}}
@media(prefers-reduced-motion:reduce){.frame{animation:none}}
</style></head><body><div class="frame"><div class="label"></div></div><script>
document.querySelector('.label').textContent=${JSON.stringify(label)};
for(const type of ['keydown','keyup','mousedown','mouseup','click','wheel','contextmenu','dragover','drop'])addEventListener(type,e=>e.preventDefault(),{passive:false});
</script></body></html>`;
      void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
    }
    if (page.controlHost !== owner) {
      this.unmountControl(page);
      owner.contentView.addChildView(page.controlView);
      page.controlHost = owner;
    }
    const size = owner.getContentBounds();
    const x = Math.max(0, Math.min(size.width, Math.round(bounds.x))), y = Math.max(0, Math.min(size.height, Math.round(bounds.y)));
    page.controlView.setBounds({ x, y, width: Math.max(0, Math.min(size.width - x, Math.round(bounds.width))), height: Math.max(0, Math.min(size.height - y, Math.round(bounds.height))) });
    page.controlView.setVisible(bounds.width > 0 && bounds.height > 0);
    // Shield stays above any native popup view. It is not focused: the user's keyboard focus stays where it is.
    owner.contentView.addChildView(page.controlView);
  }

  private unmountControl(page: Page): void {
    page.controlView?.setVisible(false);
    if (page.controlView && page.controlHost && !page.controlHost.isDestroyed()) page.controlHost.contentView.removeChildView(page.controlView);
    page.controlHost = undefined;
  }

  private unmount(page: Page): void {
    page.nativeView?.setVisible(false);
    if (page.nativeView && page.viewHost && !page.viewHost.isDestroyed()) page.viewHost.contentView.removeChildView(page.nativeView);
    page.viewHost = undefined;
  }

  /** End agent control while leaving its pages and in-flight downloads available to the user. */
  releaseAgent(id: string): void {
    const page = this.pages.get(id);
    if (!page) return;
    page.agent = false;
    this.setAgentControl(id, false);
    page.releaseDownloads?.();
    page.releaseDownloads = undefined;
    page.options = { sessionId: page.options.sessionId }; // New user popups/downloads no longer belong to the old connection.
    this.changed(page);
  }

  /** Put the page on screen, for what needs it drawn (a screenshot): its tab becomes the side panel's current one. */
  async reveal(id: string): Promise<void> {
    const page = this.pages.get(id);
    if (!page) throw new Error("this page was closed");
    if (page.window) {
      page.window.show();
    }
    const shown = (): boolean => page.nativeView ? page.nativeView.getVisible() : page.contents.isAttached();
    if (!page.window && !shown()) this.send({ revealPage: id });
    for (let i = 0; i < 30 && !shown(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!shown()) throw new Error("the page is not on screen and could not be brought there");
  }

  /** The page that a window of its own shows, if `contents` is such a window. */
  shownIn(contents: WebContents): PageView | undefined {
    const page = [...this.pages.values()].find((p) => p.window?.webContents === contents);
    return page && this.view(page);
  }

  /** The window the pages belong to is gone, and they go with it. */
  dispose(): void {
    for (const page of [...this.pages.values()]) this.close(page);
  }

  // ---- a page in a window of its own -------------------------------------------

  /** Move the page out of the side panel into a window. The page itself is not touched: it does not load again. */
  private detach(page: Page): void {
    if (page.window) return page.window.show();
    const window = new BrowserWindow({
      width: 1000,
      height: 760,
      minWidth: 400,
      minHeight: 240,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 20 },
      title: page.contents.getTitle(),
      webPreferences: { preload: this.shell.preload, webview2Tag: true } as WebPreferences,
    });
    page.window = window;
    // The window shows the page and nothing else.
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    // Closing the window closes the page, unless the page has left it (restore).
    window.on("closed", () => {
      if (page.window === window) this.close(page);
    });
    // The side panel lets go first; a page is shown in one place at a time.
    page.annotator?.discard();
    page.controlBounds = undefined;
    this.unmountControl(page);
    if (page.nativeView) this.unmount(page);
    else page.contents.detach();
    this.changed(page);
    void window.loadURL(this.shell.pageWindowUrl);
  }

  /** Back into the side panel. */
  private restore(page: Page): void {
    const window = page.window;
    if (!window) return;
    page.annotator?.discard();
    page.window = undefined;
    page.controlBounds = undefined;
    this.unmountControl(page);
    if (page.nativeView) this.unmount(page);
    else page.contents.detach();
    window.destroy();
    this.changed(page);
  }

  // -----------------------------------------------------------------------------

  private close(page: Page): void {
    if (!this.pages.delete(page.id)) return;
    page.annotator?.dispose();
    const window = page.window;
    page.window = undefined;
    this.unmountControl(page);
    this.unmount(page);
    if (window && !window.isDestroyed()) window.destroy();
    page.releaseDownloads?.();
    if (!page.contents.isDestroyed()) page.contents.destroy();
    if (page.controlView && !page.controlView.webContents.isDestroyed()) (page.controlView.webContents as Webview2).destroy();
    if (!page.embedded) this.send({ removedPage: page.id });
  }

  private changed(page: Page): void {
    // Events of a page that is being destroyed still arrive.
    if (page.embedded || !this.pages.has(page.id) || page.contents.isDestroyed()) return;
    const event = { page: this.view(page) };
    this.send(event);
    if (page.window && !page.window.isDestroyed()) page.window.webContents.send("xsb:event", event);
  }

  private send(event: { page: PageView } | { removedPage: string } | { revealPage: string }): void {
    if (!this.host.isDestroyed()) this.host.send("xsb:event", event);
  }

  private view({ id, options, contents, window, nativeView, agent, controlling, error, favicon, annotator }: Page): PageView {
    return {
      id,
      contentsId: contents.id,
      sessionId: options.sessionId,
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      window: !!window,
      nativeView: !!nativeView,
      pinned: !!window && window.isAlwaysOnTop(),
      agent,
      controlling: !!controlling,
      annotating: !!annotator?.active,
      annotations: annotator?.count ?? 0,
      tone: this.shell.toneOf?.(options.sessionId) ?? "default",
      error,
      favicon,
    };
  }
}
