/**
 * The web pages of one window: the page tabs of its side panel.
 *
 * A page is a WebContentsView that the main process owns. An app window shows
 * it (page-host.ts) where its document lays out a place for it: the side panel
 * of the main window, or a window of the page's own. Moving the view between
 * them does not touch the page, and that is what lets a page move without
 * loading again. What the app draws over a page, the shield of a page an agent
 * drives and the editor of a note, are views of the window that shows it.
 *
 *   side panel   (renderer/pages.js)        ┐
 *   page window  (renderer/page-window.js)  ┴ renderer/page-slot.js ──bounds──▶ PageHost ──shows──▶ a page here
 *
 * Both documents are told of every change as `{ page }` and `{ removedPage }` events.
 * A page ends when its tab is closed, when its window is closed, or with the
 * window whose side panel it belongs to.
 */
import { BrowserWindow, WebContentsView, session, shell } from "electron";
import type { BrowserWindowConstructorOptions, LoadURLOptions, Rectangle, WebContents } from "electron";
import { address } from "./address.ts";
import type { PageView } from "./bridge.ts";
import { ownDownloads } from "./browser-downloads.ts";
import type { BrowserDownloads } from "./browser-downloads.ts";
import { controlInput, installInputGuard, pressedByUser } from "./page-input.ts";
import { Annotator, NOTE_LIMIT } from "./page-annotations.ts";
import type { Tone } from "./page-annotations.ts";
import { PageHost } from "./page-host.ts";
import type { HostShell, ShownPage } from "./page-host.ts";

/** Web pages keep their cookies and logins here, apart from the app's own pages. */
const WEB_PARTITION = "persist:xsb-web";
/** Previews of the HTML files agents wrote: the only pages that can read `xsb-artifact://`, and no website is among them. */
export const PREVIEW_PARTITION = "xsb-preview";
/** A page no window shows is drawn in a small, non-activating window for its screenshot. */
const SCREENSHOT_SIZE = { width: 800, height: 600 };
const WEB_PREFERENCES = { sandbox: true, contextIsolation: true, nodeIntegration: false, focusOnNavigation: false };

/** `background`: an agent opened it, or its page did while the agent was driving it; its tab is shown without taking the user's focus. */
export type PageOptions = { sessionId?: string; embedded?: boolean; agent?: boolean; background?: boolean; downloads?: BrowserDownloads; onPopup?: (id: string, openerId: string) => void };
type Page = { id: string; view: WebContentsView; contents: WebContents; embedded: boolean; agent: boolean; background: boolean; initialDocument?: Promise<void>; userFocused?: boolean; controlling?: boolean; window?: PageHost; error?: string; favicon?: string; releaseDownloads?: () => void; annotator?: Annotator; options: PageOptions };
/** `pageWindowUrl`: the document of a page's own window. `toneOf`: the style of annotations on a page of this session (page-annotations.ts), after its agent's backend. */
type Shell = HostShell & { pageWindowUrl: string; toneOf?: (sessionId?: string) => Tone };

export class Pages {
  private pages = new Map<string, Page>();
  private drawing = new Map<string, BrowserWindow>();
  private seq = 0;
  /** The main window, whose side panel the pages are tabs of. */
  readonly host: PageHost;
  private shell: Shell;

  constructor(host: PageHost, shell: Shell) {
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
    const view = new WebContentsView({ webPreferences: { ...WEB_PREFERENCES, partition: url.startsWith("xsb-artifact:") ? PREVIEW_PARTITION : WEB_PARTITION } });
    const page = this.register(view, options);
    const loading = page.contents.loadURL(url);
    // A new agent tab needs a renderer before its debugger can drive the first real navigation.
    if (options.agent && url === "about:blank") page.initialDocument = loading;
    void loading.catch(() => {});
    this.changed(page);
    return this.view(page);
  }

  async waitForInitialDocument(id: string): Promise<void> {
    const page = this.pages.get(id);
    if (!page) throw new Error("this page was closed");
    await page.initialDocument;
  }

  private register(view: WebContentsView, options: PageOptions): Page {
    const { embedded = false, agent = false, background = false, downloads } = options;
    const contents = view.webContents;
    const page: Page = { id: `p${++this.seq}`, view, contents, embedded, agent, background, options };
    view.setBackgroundColor("#ffffff");
    this.pages.set(page.id, page);
    installInputGuard(contents, !embedded);
    if (downloads) page.releaseDownloads = ownDownloads(contents, page.id, downloads, () => { page.error = undefined; this.changed(page); });
    contents.once("destroyed", () => this.close(page));
    // Chromium can give a background page focus when it loads or opens a popup. A user's tab selection
    // or click in the page can claim that focus, even after Chromium has delivered the focus event.
    contents.on("blur", () => { page.userFocused = false; });
    contents.on("focus", () => {
      if (!page.background) return;
      setTimeout(() => {
        const host = this.hostOf(page);
        if (!contents.isDestroyed() && contents.isFocused() && !page.userFocused && !pressedByUser(contents) && !host.win.isDestroyed() && host.win.isFocused()) host.document.focus();
      }, 50);
    });

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
    // A popup is a page in a tab like any other. Chromium has made its contents already, with its opener,
    // its first request (a posted form) and what the opener writes into it: the tab takes that very contents.
    contents.setWindowOpenHandler(({ url }) => {
      // Preview pages must not hand their private artifact partition to a website.
      if (page.embedded) {
        if (/^https?:/i.test(url)) this.open(url, { sessionId: page.options.sessionId });
        return { action: "deny" };
      }
      if (!/^(https?|blob):/i.test(url) && url !== "about:blank") return { action: "deny" };
      return {
        action: "allow",
        outlivesOpener: true,
        overrideBrowserWindowOptions: { webPreferences: WEB_PREFERENCES },
        createWindow: (options) => {
          const guest = (options as BrowserWindowConstructorOptions & { webContents: WebContents }).webContents;
          // Who caused the popup decides whether it is shown: the agent's action, or the user's.
          const child = this.register(new WebContentsView({ webContents: guest }), { ...page.options, background: !!page.controlling });
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
    if (arg === "background" && page.annotator?.pending && ["detach", "restore", "close"].includes(op))
      throw Error("The user is editing a page annotation. Retry after they finish.");
    if (page.controlling && ["navigate", "back", "forward", "reload", "external"].includes(op)) throw new Error(this.shell.controlText);
    if (op === "navigate") void this.navigate(id, String(arg)).catch(() => {});
    else if (op === "back") contents.navigationHistory.goBack();
    else if (op === "forward") contents.navigationHistory.goForward();
    else if (op === "reload") contents.reload();
    else if (op === "external") void shell.openExternal(contents.getURL());
    else if (op === "close") this.close(page);
    else if (op === "detach") this.detach(page, arg === "background");
    else if (op === "restore") this.restore(page);
    else if (op === "show") window?.win.show();
    else if (op === "pin") window?.win.setAlwaysOnTop(arg === true);
    else throw new Error(`unknown page operation ${op}`);
    if (op === "pin") this.changed(page);
  }

  /** Resolve a tab for interaction. By default its visible view takes the keyboard in the active window. */
  focus(id: string, focusContents = true): WebContents {
    const page = this.pages.get(id);
    if (!page || page.contents.isDestroyed()) throw new Error("this page was closed");
    if (focusContents) {
      const host = this.hostOf(page);
      if (host.showing(id) && host.win.isFocused()) {
        page.userFocused = true;
        page.contents.focus();
      }
    }
    return page.contents;
  }

  /** Only the page's current host may place its view or request keyboard focus after layout. */
  present(id: string, sender: WebContents, ...[op, value]: ["bounds", bounds?: Rectangle | null] | ["focus", focusContents?: boolean]): void {
    const page = this.pages.get(id);
    if (!page) return;
    const host = this.hostOf(page);
    if (sender !== host.document) return;
    if (op === "focus") return void this.focus(id, value);
    const bounds = value;
    if (!bounds) return host.remove(id);
    // Keep drawing a screenshot until a visible host needs the view. Hidden windows still record the latest layout.
    const drawing = this.drawing.get(id);
    const capturing = drawing && !drawing.isDestroyed() && drawing.contentView.children.includes(page.view);
    const lent = !!capturing && (!host.win.isVisible() || host.win.isMinimized());
    if (capturing && !lent) drawing.contentView.removeChildView(page.view);
    for (const other of this.hosts()) if (other !== host) other.remove(id);
    host.place(this.shown(page), bounds, lent);
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

  /**
   * The user's annotations (page-annotations.ts), asked for by the window that shows the page (its document,
   * or the editor over the page) and by no one else. The window never names a node: it confirms or drops the one the user selected.
   */
  async annotate(id: string, sender: WebContents, op: string, arg?: unknown): Promise<void> {
    const page = this.pages.get(id);
    if (!page && op === "annotationsRemove" && sender === this.host.document) return;
    if (!page) throw new Error("this page was closed");
    const annotator = page.annotator;
    // The composer of the page's conversation, in the main window, takes out notes it sent or dropped.
    if (op === "annotationsRemove") {
      if (sender !== this.host.document && !this.hostOf(page).owns(sender)) throw new Error("this page is shown elsewhere");
      const ids = Array.isArray(arg) && arg.length <= 200 && arg.every((id) => typeof id === "string" && id.length <= 64) ? arg as string[] : undefined;
      if (!ids) throw new Error("annotationsRemove takes a list of ids");
      return annotator?.remove(ids);
    }
    if (!this.hostOf(page).owns(sender)) throw new Error("this page is shown elsewhere");
    if (op === "annotate") {
      if (typeof arg !== "boolean") throw new Error("annotate takes true or false");
      if (!arg) return annotator?.stop();
      if (page.controlling) throw new Error(this.shell.controlText);
      if (page.embedded) throw new Error("this page cannot be annotated");
      page.annotator ??= new Annotator(page.contents, () => this.hostOf(page).update(this.shown(page)), () => this.changed(page),
        () => this.shell.toneOf?.(page.options.sessionId) ?? "default");
      return page.annotator.start();
    }
    if (!annotator?.active) throw new Error("annotation mode is off");
    if (op === "annotationSave") {
      const text = typeof arg === "string" ? arg.trim() : "";
      if (!text || text.length > NOTE_LIMIT) throw new Error(`a note has 1 to ${NOTE_LIMIT} characters`);
      // The note, the element and its picture go to the page's conversation, whose composer is in the main window.
      const annotation = await annotator.save(page.id, text);
      this.send({ webAnnotation: { pageId: page.id, sessionId: page.options.sessionId, annotation } });
      return;
    }
    if (op === "annotationDiscard") return annotator.discard();
    if (op === "annotationsClear") {
      const ids = await annotator.clear();
      if (ids.length) this.send({ webAnnotationsRemoved: { pageId: page.id, sessionId: page.options.sessionId, ids } });
      return;
    }
    throw new Error(`unknown page operation ${op}`);
  }

  /** The window the page belongs to: its own, or the main window. */
  private hostOf(page: Page): PageHost {
    return page.window ?? this.host;
  }

  private hosts(): PageHost[] {
    return [this.host, ...[...this.pages.values()].flatMap((page) => page.window ? [page.window] : [])];
  }

  /** The window, of these pages, that `contents` is a document of. */
  hostOwning(contents: WebContents): PageHost | undefined {
    return this.hosts().find((host) => host.owns(contents));
  }

  private shown(page: Page): ShownPage {
    const { annotator } = page;
    return { id: page.id, view: page.view, controlling: !!page.controlling,
      annotation: annotator?.active ? { tone: annotator.tone, target: annotator.pending ?? null } : undefined };
  }

  /** Control lasts one browser tool call (browser.ts): a shield over the page, user input blocked. */
  setAgentControl(id: string, controlling: boolean): void {
    const page = this.pages.get(id);
    if (!page || page.controlling === controlling) return;
    if (controlling && page.annotator?.pending) throw Error("The user is editing a page annotation. Retry after they finish.");
    page.controlling = controlling;
    // An agent taking the page ends the user's annotating; the notes stay.
    if (controlling) page.annotator?.stop();
    controlInput(page.contents, controlling);
    this.changed(page);
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

  /**
   * Run `draw` (a screenshot) while the page is drawn. A page a shown window shows stays where it is.
   * Any other, one no window shows or one in a hidden or minimized window, is put in a temporary,
   * non-interactive window for the while: never showing the user's window, selecting their tab, or
   * activating a window to obtain a Chromium frame. A page taken from its window goes back to it.
   */
  async drawn<T>(id: string, draw: () => Promise<T>): Promise<T> {
    const page = this.pages.get(id);
    if (!page) throw new Error("this page was closed");
    if (this.hosts().some((host) => host.draws(id))) return draw();
    if (this.drawing.has(id)) throw new Error("this page is already being drawn");
    this.hostOf(page).lend(id);
    const window = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      useContentSize: true,
      ...SCREENSHOT_SIZE,
      title: this.shell.controlText,
    });
    this.drawing.set(id, window);
    window.setIgnoreMouseEvents(true);
    try {
      page.view.setBounds({ x: 0, y: 0, ...SCREENSHOT_SIZE });
      window.contentView.addChildView(page.view);
      window.showInactive();
      return await draw();
    } finally {
      // The page leaves before the window goes; a window that showed it meanwhile keeps it.
      if (!window.isDestroyed()) {
        if (window.contentView.children.includes(page.view)) window.contentView.removeChildView(page.view);
        window.destroy();
      }
      this.drawing.delete(id);
      if (this.pages.has(id)) this.hostOf(page).reclaim(id);
    }
  }

  /** The page that a window of its own shows, if `contents` is such a window. */
  shownIn(contents: WebContents): PageView | undefined {
    const page = [...this.pages.values()].find((p) => p.window?.document === contents);
    return page && this.view(page);
  }

  /** The window the pages belong to is gone, and they go with it. */
  dispose(): void {
    for (const page of [...this.pages.values()]) this.close(page);
    this.host.dispose();
  }

  // ---- a page in a window of its own -------------------------------------------

  /** Move the page out of the side panel into a window. The page itself is not touched: it does not load again. */
  private detach(page: Page, background = false): void {
    if (page.window) return background ? page.window.win.showInactive() : page.window.win.show();
    const window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 760,
      minWidth: 400,
      minHeight: 240,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 20 },
      title: page.contents.getTitle(),
      webPreferences: { preload: this.shell.preload, focusOnNavigation: false },
    });
    const host = new PageHost(window, this.shell);
    // The window shows the page and nothing else.
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    // Closing the window closes the page, unless the page has left it (restore).
    window.on("closed", () => {
      host.dispose();
      if (page.window === host) this.close(page);
    });
    // The side panel lets go first; a page is shown in one place at a time.
    page.annotator?.discard();
    this.host.remove(page.id);
    page.window = host;
    this.changed(page);
    if (background) window.showInactive(); else window.show();
    void window.loadURL(this.shell.pageWindowUrl);
  }

  /** Back into the side panel. */
  private restore(page: Page): void {
    const host = page.window;
    if (!host) return;
    page.annotator?.discard();
    host.remove(page.id);
    page.window = undefined;
    host.win.destroy();
    this.changed(page);
  }

  // -----------------------------------------------------------------------------

  private close(page: Page): void {
    if (!this.pages.delete(page.id)) return;
    const drawing = this.drawing.get(page.id);
    this.drawing.delete(page.id);
    if (drawing && !drawing.isDestroyed()) drawing.destroy();
    page.annotator?.dispose();
    this.host.remove(page.id);
    const host = page.window;
    page.window = undefined;
    if (host && !host.win.isDestroyed()) host.win.destroy();
    page.releaseDownloads?.();
    if (!page.contents.isDestroyed()) page.contents.close();
    if (!page.embedded) this.send({ removedPage: page.id });
  }

  private changed(page: Page): void {
    // Events of a page that is being destroyed still arrive.
    if (!this.pages.has(page.id) || page.contents.isDestroyed() || this.host.document.isDestroyed()) return;
    this.hostOf(page).update(this.shown(page));
    if (page.embedded) return;
    const event = { page: this.view(page) };
    // Switching the displayed tab would unmount a focused web page or its annotation editor.
    const keepTab = page.background && this.host.win.isFocused() && !this.host.document.isFocused();
    this.send({ ...event, keepTab });
    if (page.window && !page.window.win.isDestroyed()) page.window.document.send("xsb:event", event);
  }

  private send(event: object): void {
    if (!this.host.document.isDestroyed()) this.host.document.send("xsb:event", event);
  }

  private view({ id, options, contents, window, agent, background, controlling, error, favicon, annotator }: Page): PageView {
    return {
      id,
      sessionId: options.sessionId,
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      window: !!window,
      pinned: !!window && window.win.isAlwaysOnTop(),
      agent,
      background,
      controlling: !!controlling,
      annotating: !!annotator?.active,
      annotations: annotator?.count ?? 0,
      tone: this.shell.toneOf?.(options.sessionId) ?? "default",
      error,
      favicon,
    };
  }
}
