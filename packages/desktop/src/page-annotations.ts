/**
 * The user's annotations on a web page.
 *
 *   annotation mode  ── Overlay.setInspectMode: the debugger's node selection ──▶ a node
 *   host page (renderer/annotate.js) ── edits the note, where the page cannot reach it
 *   confirmed note   ── embedded in the page, in an isolated world ──▶ follows its node
 *
 * While the mode is on, the debugger's selection takes the page's clicks and
 * hovers, and the input guard (page-input.ts) its keyboard: only scrolling
 * reaches the page. Selecting a node does not end the mode; the user selects
 * as many as they want, and ends it themself.
 *
 * Nothing the page says is trusted. The note's text goes in as text, inside a
 * closed shadow root; the code that places notes runs in a world of its own,
 * where the page's scripts cannot replace what it calls; and the one channel
 * back, a binding that reports where the node being annotated is, exists only
 * in that world and carries numbers that are checked here.
 */
import { randomUUID } from "node:crypto";
import { nativeImage } from "electron";
import type { Rectangle, WebContents } from "electron";
import { annotateInput, holdDebugger } from "./page-input.ts";

const WORLD = "xsb-annotations";
const BINDING = "xsbAnnotationTarget";
/** The longest note, in characters. */
export const NOTE_LIMIT = 2000;
const COMMAND_TIMEOUT_MS = 10_000;

/** The longest element HTML given with a note, in characters. */
const HTML_LIMIT = 20_000;

/**
 * Annotations take the style of the agent the page is for: claude's orange, or the black of
 * codex and of the app itself for any other backend.
 */
export type Tone = "claude" | "default";
const TONES: Record<Tone, { accent: [number, number, number]; paper: string; line: string }> = {
  claude: { accent: [217, 119, 87], paper: "#fdfcfa", line: "#e4dfd5" },
  default: { accent: [20, 20, 20], paper: "#ffffff", line: "#e0e0e0" },
};

/** How the debugger's selection highlights the node under the pointer. */
const highlight = (tone: Tone): object => {
  const [r, g, b] = TONES[tone].accent;
  return {
    showInfo: true,
    showStyles: false,
    contentColor: { r, g, b, a: 0.14 },
    paddingColor: { r, g, b, a: 0.07 },
    borderColor: { r, g, b, a: 0.9 },
    marginColor: { r, g, b, a: 0.04 },
  };
};
/** The colors of the notes embedded in the page, as CSS custom properties of their host. */
const tint = (tone: Tone): string => {
  const { accent: [r, g, b], paper, line } = TONES[tone];
  return `--xsb-accent:rgb(${r},${g},${b});--xsb-wash:rgba(${r},${g},${b},.06);--xsb-paper:${paper};--xsb-line:${line}`;
};

/**
 * A confirmed note, as the conversation of the page's session gets it (renderer/content.js expands it
 * into text and an image when sent): the user's words, the element (its HTML and what it looks like) and the page.
 */
export type WebAnnotation = { type: "web_annotation"; id: string; pageId: string; index: number; note: string; label: string; html: string; url: string; title: string; image?: { mimeType: "image/png"; data: string } };

/** What the host is told about the node being annotated: where it shows in the page's viewport (null: scrolled out of sight), and `seq`, which changes with every selection. */
export type AnnotationTarget = { seq: number; rect: Rectangle | null; label: string };

/** Runs in the isolated world, once per document. Its API is `globalThis.xsbNotes`, which only this world sees. */
const PAGE_SCRIPT = String.raw`(() => {
  if (globalThis.xsbNotes) return;
  const report = globalThis.${BINDING};
  const host = document.createElement("xsb-annotations");
  const base = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:strict;";
  let colors = "";
  host.style.cssText = base;
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = ".box{position:fixed;box-sizing:border-box;border:2px solid var(--xsb-accent);border-radius:3px;background:var(--xsb-wash)}" +
    ".badge{position:absolute;left:-2px;top:-2px;transform:translateY(-100%);min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px 9px 9px 0;background:var(--xsb-accent);color:#fff;font:600 11px/18px system-ui,sans-serif;text-align:center}" +
    ".note{position:absolute;left:-2px;top:calc(100% + 4px);width:max-content;max-width:260px;padding:6px 9px;border-radius:6px;background:var(--xsb-paper);color:#1f1d1a;border:1px solid var(--xsb-line);border-left:3px solid var(--xsb-accent);box-shadow:0 2px 8px rgba(0,0,0,.14);font:12px/1.45 system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere}" +
    ".box.up .note{top:auto;bottom:calc(100% + 22px)}";
  root.append(style);
  const notes = [];
  let pending = null, reported = "", numbered = 0;

  // The part of a node that shows: its box, cut by every scrolling or clipping ancestor and by the viewport.
  const visible = (node) => {
    if (!node.isConnected) return null;
    const r = node.getBoundingClientRect();
    let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
    for (let a = node.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX !== "visible" || s.overflowY !== "visible") {
        const c = a.getBoundingClientRect();
        left = Math.max(left, c.left); top = Math.max(top, c.top); right = Math.min(right, c.right); bottom = Math.min(bottom, c.bottom);
      }
      if (s.position === "fixed") break;
    }
    left = Math.max(left, 0); top = Math.max(top, 0); right = Math.min(right, innerWidth); bottom = Math.min(bottom, innerHeight);
    return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
  };
  const place = () => {
    if (!host.isConnected) document.documentElement.append(host);
    host.style.cssText = base + colors;
    for (const { node, box } of notes) {
      const r = visible(node);
      box.hidden = !r;
      if (!r) continue;
      box.style.cssText = "left:" + r.x + "px;top:" + r.y + "px;width:" + r.width + "px;height:" + r.height + "px";
      box.classList.toggle("up", r.y + r.height > innerHeight - 80);
    }
    const now = JSON.stringify(pending ? visible(pending) : null);
    if (pending && now !== reported) { reported = now; report(now); }
  };
  // Next frame; a timer as well, since a page in a hidden or background window gets no frames.
  let queued = false;
  const run = () => { if (queued) { queued = false; place(); } };
  const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(run); setTimeout(run, 100); };
  const resized = new ResizeObserver(schedule);
  // Capture: a scroll of any region, not only of the page, moves what is in it.
  addEventListener("scroll", schedule, { capture: true, passive: true });
  addEventListener("resize", schedule, { passive: true });
  resized.observe(document.documentElement);
  setInterval(() => { if (pending || notes.length) schedule(); }, 400);

  const label = (node) => {
    const id = node.id ? "#" + node.id : "";
    const cls = typeof node.className === "string" && node.className.trim() ? "." + node.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    return (node.localName + id + cls).slice(0, 80);
  };
  globalThis.xsbNotes = {
    track(node) {
      const element = node.nodeType === 1 ? node : node.parentElement;
      if (!element) throw new Error("not an element");
      pending = element; reported = ""; resized.observe(element); schedule();
      return label(element);
    },
    untrack() { pending = null; reported = ""; },
    tint(value) { colors = String(value); host.style.cssText = base + colors; },
    // For a picture of the element alone: the notes step aside, and it comes into view if it is not.
    hide(hidden) { host.style.visibility = hidden ? "hidden" : ""; },
    details(limit) {
      if (!pending) throw new Error("nothing is selected");
      if (!visible(pending)) pending.scrollIntoView({ block: "center", inline: "nearest" });
      const html = pending.outerHTML;
      return { rect: visible(pending), label: label(pending), html: html.length > limit ? html.slice(0, limit) + "\n<!-- … -->" : html };
    },
    // A note keeps its number: the conversation calls it by it, whatever is removed before it.
    embed(text, id) {
      if (!pending) throw new Error("nothing is selected");
      const box = document.createElement("div"), badge = document.createElement("div"), note = document.createElement("div");
      box.className = "box"; badge.className = "badge"; note.className = "note";
      badge.textContent = String(++numbered);
      note.textContent = text;
      box.append(badge, note);
      root.append(box);
      notes.push({ id, node: pending, box });
      pending = null; reported = "";
      schedule();
      return numbered;
    },
    count() { return notes.length; },
    remove(ids) {
      for (let i = notes.length - 1; i >= 0; i--) if (ids.includes(notes[i].id)) notes.splice(i, 1)[0].box.remove();
      return notes.length;
    },
    clear() { const ids = notes.map((n) => n.id); for (const { box } of notes.splice(0)) box.remove(); return ids; },
  };
  document.documentElement.append(host);
})()`;

export class Annotator {
  private contents: WebContents;
  private report: (target: AnnotationTarget | null) => void;
  private changed: () => void;
  private letGo?: () => void;
  private world?: number;
  private seq = 0;
  private target?: AnnotationTarget;
  private toneOf: () => Tone;
  /** The style of the current annotating. */
  tone: Tone = "default";
  /** The notes embedded in the current document. */
  count = 0;

  /**
   * `report` tells the host where the node being annotated is; `changed`, that the mode or the count changed;
   * `toneOf`, whose style the annotations take, asked at every start.
   */
  constructor(contents: WebContents, report: (target: AnnotationTarget | null) => void, changed: () => void, toneOf: () => Tone) {
    this.contents = contents;
    this.report = report;
    this.changed = changed;
    this.toneOf = toneOf;
    contents.debugger.on("message", this.onMessage);
    // A new document has none of the notes, nor the world they were in.
    contents.on("did-navigate", this.onDocument);
  }

  get active(): boolean { return !!this.letGo; }

  /** The node being annotated, for a host that newly shows the page. */
  get pending(): AnnotationTarget | undefined { return this.target; }

  async start(): Promise<void> {
    if (this.letGo) return;
    this.letGo = holdDebugger(this.contents);
    this.tone = this.toneOf();
    annotateInput(this.contents, true);
    try {
      await this.send("DOM.enable");
      await this.send("Overlay.enable");
      await this.select();
    } catch (e) {
      this.stop();
      throw e;
    }
    this.changed();
  }

  stop(): void {
    if (!this.letGo) return;
    annotateInput(this.contents, false);
    this.drop();
    if (this.attached()) {
      for (const [method, params] of [["Overlay.setInspectMode", { mode: "none" }], ["Runtime.removeBinding", { name: BINDING }], ["Overlay.disable", {}]] as const) {
        void this.contents.debugger.sendCommand(method, params).catch(() => {});
      }
    }
    const letGo = this.letGo;
    this.letGo = undefined;
    letGo();
    this.changed();
  }

  /**
   * Embed the note for the node being annotated, and stay in the mode for the next. What is returned goes to
   * the conversation: the note, the element's HTML, and a picture of the element taken before the note covers it.
   */
  async save(pageId: string, text: string): Promise<WebAnnotation> {
    if (!this.letGo || !this.target) throw new Error("select an element of the page first");
    const details = await this.inWorld(`globalThis.xsbNotes.details(${HTML_LIMIT})`);
    const image = await this.picture(rectOf(JSON.stringify(details.rect))).catch(() => undefined);
    const id = randomUUID();
    const index = await this.inWorld(`(globalThis.xsbNotes.tint(${JSON.stringify(tint(this.tone))}), globalThis.xsbNotes.embed(${JSON.stringify(text)}, ${JSON.stringify(id)}))`);
    this.count = await this.inWorld("globalThis.xsbNotes.count()");
    this.target = undefined;
    this.report(null);
    this.changed();
    return {
      type: "web_annotation", id, pageId, index, note: text, label: String(details.label ?? "").slice(0, 80), html: String(details.html ?? ""),
      url: this.contents.getURL(), title: this.contents.getTitle(), ...(image ? { image: { mimeType: "image/png" as const, data: image } } : {}),
    };
  }

  /** The element as it shows, without the selection's highlight or the notes over it. */
  private async picture(rect: Rectangle | null): Promise<string | undefined> {
    if (!rect) return undefined;
    await this.send("Overlay.hideHighlight");
    await this.inWorld("globalThis.xsbNotes.hide(true)");
    try {
      // The viewport as it is, cut here: a clip would make Chromium move the page's viewport, and it does not always move it back.
      const { cssVisualViewport: view } = await this.send("Page.getLayoutMetrics");
      const { data } = await this.send("Page.captureScreenshot", { format: "png" });
      if (typeof data !== "string") return undefined;
      const shot = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
      const { width: pixels, height: rows } = shot.getSize();
      const scale = pixels / view.clientWidth, pad = 8;
      const x = Math.max(0, Math.floor((rect.x - pad) * scale)), y = Math.max(0, Math.floor((rect.y - pad) * scale));
      const width = Math.min(pixels, Math.ceil((rect.x + rect.width + pad) * scale)) - x, height = Math.min(rows, Math.ceil((rect.y + rect.height + pad) * scale)) - y;
      if (width <= 0 || height <= 0) return undefined;
      return shot.crop({ x, y, width, height }).toPNG().toString("base64");
    } finally {
      await this.inWorld("globalThis.xsbNotes.hide(false)").catch(() => {});
    }
  }

  /** Forget the node being annotated, without a note. */
  discard(): void {
    this.drop();
  }

  /** Take these notes out of the page (sent, or removed from the composer). Notes of an earlier document are gone already. */
  async remove(ids: string[]): Promise<void> {
    if (this.world === undefined || !ids.length) return;
    this.count = await this.inWorld(`globalThis.xsbNotes.remove(${JSON.stringify(ids)})`);
    this.changed();
  }

  /** Take every note out of the page; returns their ids, for the composer to drop them too. */
  async clear(): Promise<string[]> {
    const ids: unknown = this.world === undefined ? [] : await this.inWorld("globalThis.xsbNotes.clear()");
    this.count = 0;
    this.changed();
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  }

  dispose(): void {
    this.stop();
    if (!this.contents.isDestroyed()) {
      this.contents.debugger.off("message", this.onMessage);
      this.contents.off("did-navigate", this.onDocument);
    }
  }

  private drop(): void {
    if (!this.target) return;
    this.target = undefined;
    if (this.world !== undefined) void this.inWorld("globalThis.xsbNotes.untrack()").catch(() => {});
    this.report(null);
  }

  /** Node selection, kept on after each pick. */
  private select(): Promise<unknown> {
    return this.send("Overlay.setInspectMode", { mode: "searchForNode", highlightConfig: highlight(this.tone) });
  }

  private onDocument = (): void => {
    this.world = undefined;
    this.count = 0;
    if (this.target) { this.target = undefined; this.report(null); }
    if (this.letGo) void this.select().catch(() => {});
    this.changed();
  };

  private onMessage = (_event: unknown, method: string, params: any): void => {
    if (!this.letGo) return;
    if (method === "Overlay.inspectNodeRequested" && Number.isSafeInteger(params?.backendNodeId)) void this.pick(params.backendNodeId).catch(() => {});
    else if (method === "Runtime.bindingCalled" && params?.name === BINDING && params.executionContextId === this.world && this.target) {
      this.target = { ...this.target, rect: rectOf(params.payload) };
      this.report(this.target);
    }
  };

  private async pick(backendNodeId: number): Promise<void> {
    const world = await this.ensureWorld();
    const { object } = await this.send("DOM.resolveNode", { backendNodeId, executionContextId: world });
    const { result, exceptionDetails } = await this.send("Runtime.callFunctionOn", {
      objectId: object.objectId, functionDeclaration: "function () { return globalThis.xsbNotes.track(this); }", returnByValue: true,
    });
    void this.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
    if (exceptionDetails) return;
    this.target = { seq: ++this.seq, rect: null, label: String(result.value ?? "").slice(0, 80) };
    this.report(this.target);
    // Some builds leave the selection after a pick: keep it on.
    if (this.letGo) await this.select();
  }

  private async ensureWorld(): Promise<number> {
    if (this.world !== undefined) return this.world;
    const { frameTree } = await this.send("Page.getFrameTree");
    const { executionContextId } = await this.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WORLD, grantUniveralAccess: false });
    // Into the world that now exists, by its name: a binding for contexts yet to come would need Runtime.enable, which sites can detect.
    await this.send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD });
    const installed = await this.send("Runtime.evaluate", { expression: PAGE_SCRIPT, contextId: executionContextId });
    if (installed.exceptionDetails) throw new Error("could not prepare the page for annotations");
    this.world = executionContextId;
    return executionContextId;
  }

  private async inWorld(expression: string): Promise<any> {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", { expression, contextId: await this.ensureWorld(), returnByValue: true });
    if (exceptionDetails) throw new Error("the page did not take the annotation");
    return result.value;
  }

  private attached(): boolean {
    return !this.contents.isDestroyed() && this.contents.debugger.isAttached();
  }

  private send(method: string, params: object = {}): Promise<any> {
    const late = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`the page did not answer ${method}`)), COMMAND_TIMEOUT_MS).unref());
    return Promise.race([this.contents.debugger.sendCommand(method, params), late]);
  }
}

/** A rectangle reported by the page, or null: anything else is not one. */
function rectOf(payload: unknown): Rectangle | null {
  let value: any;
  try { value = JSON.parse(String(payload)); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1e6) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}
