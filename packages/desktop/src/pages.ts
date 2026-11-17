/**
 * The web pages of one window: the page tabs of its side panel.
 *
 * A page is a WebContents that the main process owns
 * (`webContents.create({ type: "webview2" })`, an API of the private Electron
 * build this app runs on; see scripts/patch-electron.mjs). A document shows
 * one with `<webview2 web-contents-id>`. Taking the element away does not
 * touch the page, and that is what lets a page move between the side panel
 * and a window of its own without loading again:
 *
 *   side panel   (renderer/pages.js)        ┐
 *   page window  (renderer/page-window.js)  ┴ <webview2> ──shows──▶ a page here
 *
 * Both are told of every change as `{ page }` and `{ removedPage }` events.
 * A page ends when its tab is closed, when its window is closed, or with the
 * window whose side panel it belongs to.
 */
import { BrowserWindow, session, shell, webContents } from "electron";
import type { WebContents, WebPreferences } from "electron";
import { address } from "./address.ts";
import type { PageView } from "./bridge.ts";

/** What the private Electron adds to the official one's types. */
type Webview2 = WebContents & { isAttached(): boolean; detach(): boolean; destroy(): void };
const create = (webContents as unknown as { create?: (options: WebPreferences & { type: "webview2" }) => Webview2 }).create;

/** Web pages keep their cookies and logins here, apart from the app's own pages. */
const WEB_PARTITION = "persist:xsb-web";
/** Previews of the HTML files agents wrote: the only pages that can read `xsb-artifact://`, and no website is among them. */
export const PREVIEW_PARTITION = "xsb-preview";

type Page = { id: string; contents: Webview2; embedded: boolean; agent: boolean; window?: BrowserWindow; error?: string };
/** Where the app's own files are, for a page's window. */
type Shell = { preload: string; pageWindowUrl: string };

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
  open(url: string, { embedded = false, agent = false } = {}): PageView {
    if (url !== "about:blank" && !(embedded && url.startsWith("xsb-artifact:"))) url = address(url);
    if (!create) throw new Error("this Electron has no <webview2>");
    const contents = create.call(webContents, {
      type: "webview2",
      partition: url.startsWith("xsb-artifact:") ? PREVIEW_PARTITION : WEB_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    const page: Page = { id: `p${++this.seq}`, contents, embedded, agent };
    this.pages.set(page.id, page);

    const changed = (): void => this.changed(page);
    for (const event of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"] as const) contents.on(event as any, changed);
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) page.error = undefined;
    });
    contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;      // -3: the load was aborted, by another one
      page.error = description;
      changed();
    });
    // What a page opens in a new window becomes a tab next to it. An agent's page loads it itself: the agent acts on that one tab.
    contents.setWindowOpenHandler(({ url: target }) => {
      if (!/^https?:/.test(target)) return { action: "deny" };
      if (page.agent) void contents.loadURL(target).catch(() => {});
      else this.open(target);
      return { action: "deny" };
    });
    void contents.loadURL(url).catch(() => {});     // a failed load is reported by did-fail-load
    changed();
    return this.view(page);
  }

  /** One thing done to a page: by its tab, its window, or an agent. */
  call(id: string, op: string, arg?: unknown): void {
    const page = this.pages.get(id);
    if (!page) throw new Error("this page was closed");
    const { contents, window } = page;
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

  /** Put the page on screen, for what needs it drawn (a screenshot): its tab becomes the side panel's current one. */
  async reveal(id: string): Promise<void> {
    const page = this.pages.get(id);
    if (!page) throw new Error("this page was closed");
    if (!page.contents.isAttached()) this.send({ revealPage: id });
    for (let i = 0; i < 30 && !page.contents.isAttached(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!page.contents.isAttached()) throw new Error("the page is not on screen and could not be brought there");
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
    page.contents.detach();
    this.changed(page);
    void window.loadURL(this.shell.pageWindowUrl);
  }

  /** Back into the side panel. */
  private restore(page: Page): void {
    const window = page.window;
    if (!window) return;
    page.window = undefined;
    page.contents.detach();
    window.destroy();
    this.changed(page);
  }

  // -----------------------------------------------------------------------------

  private close(page: Page): void {
    if (!this.pages.delete(page.id)) return;
    const window = page.window;
    page.window = undefined;
    if (window && !window.isDestroyed()) window.destroy();
    page.contents.destroy();
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

  private view({ id, contents, window, agent, error }: Page): PageView {
    return {
      id,
      contentsId: contents.id,
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      window: !!window,
      pinned: !!window && window.isAlwaysOnTop(),
      agent,
      error,
    };
  }
}
