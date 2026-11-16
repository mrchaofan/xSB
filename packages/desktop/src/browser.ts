/**
 * Browser use: an agent drives pages of the side panel of the window it works in.
 *
 *   agent ──stdio MCP──▶ xsb-browser-mcp (browser-mcp.ts: a pipe) ──unix socket──▶ here ──▶ Pages
 *
 * The app is the MCP server, because the pages are its own: only the main
 * process can open a tab in the side panel and reach the WebContents behind
 * it. The other way to let a tool drive a browser, a debugging port, would
 * hand over every window of the app, its own pages included.
 *
 * One connection is one session of an agent. It sees and touches only the
 * pages it opened itself, never a tab the user opened; its tabs say that an
 * agent drives them. The user watches in the side panel and can take over.
 *
 * A page is driven over the Chromium DevTools Protocol, through the debugger
 * of its WebContents (`contents.debugger.attach`): the accessibility tree is
 * what the agent reads, `Input.*` events are its mouse and keyboard, and
 * `Page.captureScreenshot` its eyes. The protocol stays inside this process:
 * no debugging port is opened.
 */
import fs from "node:fs";
import net from "node:net";
import type { WebContents } from "electron";
import { Connection, errorMessage } from "@xsb/protocol";
import type { Pages } from "./pages.ts";

/** The pipe's first message: where its agent works, which says whose side panel the pages go to. */
export const ATTACH = "_xsb/attach";
export const SOCKET_ENV = "XSB_BROWSER_SOCKET";

const LOAD_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 15_000;

const str = (description: string): object => ({ type: "string", description });
const ref = { type: "integer", description: "The element's number in the latest snapshot: the n of [n]." };
const TOOLS = [
  {
    name: "browser_navigate",
    description: "Open a URL in the browser in the app's side panel, where the user watches. The first call opens a tab; later calls load in the same tab. Answers a snapshot of the page.",
    inputSchema: { type: "object", required: ["url"], properties: { url: str("The address to load.") } },
  },
  {
    name: "browser_snapshot",
    description: "The page as it is now: title, address, and its content in reading order. What can be acted on has a number [n]; numbers are valid until the next snapshot.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "Click an element. Answers a snapshot of the page afterwards.",
    inputSchema: { type: "object", required: ["ref"], properties: { ref } },
  },
  {
    name: "browser_type",
    description: "Replace the content of a text field with a text. Answers a snapshot of the page afterwards.",
    inputSchema: { type: "object", required: ["ref", "text"], properties: { ref, text: str("What to enter."), submit: { type: "boolean", description: "Press Enter afterwards." } } },
  },
  {
    name: "browser_press_key",
    description: "Press a key in the page, on whatever has focus: Enter, Escape, Tab, ArrowDown, PageDown, a, … Answers a snapshot of the page afterwards.",
    inputSchema: { type: "object", required: ["key"], properties: { key: str("The key's name.") } },
  },
  {
    name: "browser_back",
    description: "Go back to the previous page. Answers a snapshot.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_screenshot",
    description: "A picture of what the page shows now. Use it for what a snapshot cannot say: layout, images, a chart.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ---- one page, over the protocol ------------------------------------------------

/** Roles of the accessibility tree that are something to act on. */
const ACTIONABLE = new Set(["button", "link", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox", "radio", "switch", "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem"]);
/** Keys by name, as `Input.dispatchKeyEvent` wants them: the virtual key code. A key of one character is itself. */
const KEYS: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, " ": 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PageUp: 33, PageDown: 34, End: 35, Home: 36 };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A page as an agent drives it. `refs` are the elements of the latest snapshot: [n] is `refs[n - 1]`, a DOM node. */
class Driven {
  private refs: number[] = [];
  private contents: WebContents;

  constructor(contents: WebContents) {
    this.contents = contents;
    contents.debugger.attach("1.3");
  }

  /** The agent is done with the page. The page stays, for the user. */
  release(): void {
    if (!this.contents.isDestroyed() && this.contents.debugger.isAttached()) this.contents.debugger.detach();
  }

  /** One command of the protocol. A page that does not answer is an error to the agent, not a call that never ends. */
  private send(method: string, params: object = {}): Promise<any> {
    const late = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`the page did not answer ${method}`)), COMMAND_TIMEOUT_MS).unref());
    return Promise.race([this.contents.debugger.sendCommand(method, params), late]);
  }

  /** What an action set off (a navigation, a request that redraws the page) has had time to show. */
  async settled(): Promise<void> {
    await sleep(300);
    for (const until = Date.now() + LOAD_TIMEOUT_MS; this.contents.isLoading() && Date.now() < until; ) await sleep(100);
  }

  async navigate(url: string): Promise<void> {
    const { errorText } = await this.send("Page.navigate", { url });
    if (errorText) throw new Error(`${url} could not be loaded: ${errorText}`);
  }

  /** The page in reading order, from its accessibility tree: what a person using it by ear would be told. */
  async snapshot(): Promise<string> {
    const { nodes } = await this.send("Accessibility.getFullAXTree");
    const byId = new Map<string, any>(nodes.map((node: any) => [node.nodeId, node]));
    const lines: string[] = [];
    this.refs = [];
    const walk = (node: any): void => {
      const role = node.role?.value;
      const name = String(node.name?.value ?? "").trim().replace(/\s+/g, " ");
      const flag = (property: string): boolean => node.properties?.some((p: any) => p.name === property && p.value.value === true);
      if (!node.ignored && ACTIONABLE.has(role) && !flag("disabled") && node.backendDOMNodeId) {
        this.refs.push(node.backendDOMNodeId);
        const value = String(node.value?.value ?? "");
        lines.push(`[${this.refs.length}] ${role} ${JSON.stringify(name.slice(0, 100))}${value && value !== name ? ` = ${JSON.stringify(value.slice(0, 100))}` : ""}${flag("checked") || flag("selected") ? " (on)" : ""}${flag("focused") ? " (focused)" : ""}`);
        return;       // its content is its name
      }
      if (!node.ignored && role === "heading") return void lines.push(`# ${name}`);
      if (!node.ignored && role === "StaticText" && name) return void lines.push(name);
      for (const id of node.childIds ?? []) if (byId.has(id)) walk(byId.get(id));
    };
    if (nodes.length) walk(nodes[0]);
    const text = lines.join("\n");
    return `${this.contents.getTitle()}\n${this.contents.getURL()}\n\n${text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (cut here: the page is longer)` : text || "(the page is empty)"}`;
  }

  private node(index: number): { backendNodeId: number } {
    const backendNodeId = this.refs[index - 1];
    if (!backendNodeId) throw new Error(`there is no element [${index}] in the latest snapshot`);
    return { backendNodeId };
  }

  async click(index: number): Promise<void> {
    const node = this.node(index);
    await this.send("DOM.scrollIntoViewIfNeeded", node);
    const { quads } = await this.send("DOM.getContentQuads", node);
    if (!quads?.length) throw new Error(`element [${index}] has no place on the page any more: take a new snapshot`);
    const [x1, y1, , , x3, y3] = quads[0];
    const at = { x: (x1 + x3) / 2, y: (y1 + y3) / 2, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { ...at, type: "mouseMoved", button: "none" });
    await this.send("Input.dispatchMouseEvent", { ...at, type: "mousePressed" });
    await this.send("Input.dispatchMouseEvent", { ...at, type: "mouseReleased" });
  }

  async type(index: number, text: string): Promise<void> {
    // As a person would: click into the field, which also gives the page the focus that typing needs.
    await this.click(index);
    // Select what is there, so that what is typed replaces it.
    const { object } = await this.send("DOM.resolveNode", this.node(index));
    await this.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function () { if (this.select) this.select(); else getSelection().selectAllChildren(this); }" });
    if (!text) return this.key("Backspace");
    await this.send("Input.insertText", { text });
  }

  async key(key: string): Promise<void> {
    const code = KEYS[key] ?? ([...key].length === 1 ? key.toUpperCase().charCodeAt(0) : undefined);
    if (code === undefined) throw new Error(`unknown key "${key}". Known: ${Object.keys(KEYS).join(", ").replace(" ,", "Space,")}, or one character`);
    // A key that writes something says what: Enter a line break, which is what submits a form.
    const text = key === "Enter" ? "\r" : [...key].length === 1 ? key : undefined;
    const event = { key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
    await this.send("Input.dispatchKeyEvent", { ...event, type: text ? "keyDown" : "rawKeyDown", text });
    await this.send("Input.dispatchKeyEvent", { ...event, type: "keyUp" });
  }

  async screenshot(): Promise<string> {
    return (await this.send("Page.captureScreenshot", { format: "png" })).data;
  }
}

// ---- the server -----------------------------------------------------------------

/**
 * Listen for agents. `pagesFor` says whose side panel an agent's pages go to,
 * given the directory the agent works in.
 */
export function serveBrowser(socketPath: string, pagesFor: (cwd: string) => Pages | undefined): net.Server {
  fs.rmSync(socketPath, { force: true });     // left behind by a run that did not end well
  const server = net.createServer((socket) => {
    const conn = new Connection(socket, socket, "browser");
    let cwd = "";
    /** The session's tab, once it has opened one: the page its tools act on. */
    let tab: { pages: Pages; id: string; contents: WebContents; driven: Driven } | undefined;
    const page = (): Driven => {
      if (!tab || tab.contents.isDestroyed()) throw new Error("no page is open: open one with browser_navigate");
      return tab.driven;
    };
    void conn.closed.then(() => tab?.driven.release());

    conn.onNotification(ATTACH, (p) => (cwd = p.cwd));
    conn.onRequest("initialize", (p) => ({ protocolVersion: p.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "xsb-browser-mcp", version: "0.1.0" } }));
    conn.onRequest("ping", () => ({}));
    conn.onRequest("tools/list", () => ({ tools: TOOLS }));
    conn.onRequest("tools/call", async (p) => {
      const args = p.arguments ?? {};
      try {
        if (p.name === "browser_screenshot") {
          const driven = page();
          await tab!.pages.reveal(tab!.id);      // a page that is not on screen is not drawn
          return { content: [{ type: "image", data: await driven.screenshot(), mimeType: "image/png" }] };
        }
        if (p.name === "browser_navigate") {
          const url = /^[a-z][a-z0-9+.-]*:/i.test(args.url) ? args.url : `https://${args.url}`;
          if (!/^https?:/.test(url)) throw new Error("only http and https addresses can be opened");
          if (!tab || tab.contents.isDestroyed()) {
            const pages = pagesFor(cwd);
            if (!pages) throw new Error("the xsb app has no window open for this workspace, so there is no browser to use");
            const { id } = pages.open("about:blank", { agent: true });
            const contents = pages.contents(id)!;
            tab = { pages, id, contents, driven: new Driven(contents) };
          }
          await page().navigate(url);
        } else if (p.name === "browser_click") await page().click(args.ref);
        else if (p.name === "browser_type") {
          await page().type(args.ref, String(args.text));
          if (args.submit) await page().key("Enter");
        } else if (p.name === "browser_press_key") await page().key(String(args.key));
        else if (p.name === "browser_back") tab?.contents.navigationHistory.goBack();
        else if (p.name !== "browser_snapshot") throw new Error(`no tool "${p.name}"`);
        await page().settled();
        return { content: [{ type: "text", text: await page().snapshot() }] };
      } catch (e) {
        return { content: [{ type: "text", text: errorMessage(e) }], isError: true };
      }
    });
  });
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
  return server;
}
