/** Native transfers keep Chromium's cookies, redirects, POST and blob semantics.
 * One collector owns its pages; only the active runtime turn is visible to tools.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DownloadItem, Session, WebContents } from "electron";
import { Paths } from "@xsb/hub";
import { errorMessage } from "@xsb/protocol";
import type { ToolContextState, TurnWindow } from "@xsb/protocol";

export type BrowserDownload = {
  id: string;
  pageId: string;
  turnId: string | null;
  filename: string;
  source: string;
  mimeType: string;
  startedAt: number;
  finishedAt?: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  path?: string;
  error?: string;
};
type Entry = { record: BrowserDownload; item?: DownloadItem; destination?: string; startedRevision: number; sample?: { time: number; bytes: number } };

/** A shared cookie partition does not imply shared download ownership. */
const routes = new WeakMap<Session, Map<number, { downloads: BrowserDownloads; pageId: string; onStart?: () => void }>>();
export function ownDownloads(contents: WebContents, pageId: string, downloads: BrowserDownloads, onStart?: () => void): () => void {
  let owners = routes.get(contents.session);
  if (!owners) {
    owners = new Map();
    routes.set(contents.session, owners);
    const byContents = owners;
    contents.session.on("will-download", (event, item, source) => {
      const owner = source && byContents.get(source.id);
      if (owner) { owner.downloads.accept(event, item, owner.pageId); owner.onStart?.(); }
    });
  }
  owners.set(contents.id, { downloads, pageId, onStart });
  const byContents = owners;
  return () => { byContents.delete(contents.id); };
}

function filename(given: string): string {
  let name = [...given.replace(/[\\/<>:"|?*\x00-\x1f\x7f]/g, "_").replace(/[. ]+$/g, "")].slice(0, 120).join("");
  while (Buffer.byteLength(name) > 180) name = [...name].slice(0, -1).join("");
  name = name.replace(/[. ]+$/g, "");
  return !name || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) ? "download" : name;
}
function source(given: string): string {
  try { const url = new URL(given); return url.protocol === "blob:" ? "blob:" : url.origin; }
  catch { return "unknown"; }
}

/** Atomic reservation across pages, connections and processes, including in-flight files. */
function reserve(directory: string, suggested: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const extension = path.extname(suggested), stem = suggested.slice(0, suggested.length - extension.length);
  for (let i = 0; ; i++) {
    const candidate = path.join(directory, i ? `${stem} (${i})${extension}` : suggested);
    try { fs.closeSync(fs.openSync(candidate, "wx", 0o600)); return candidate; }
    catch (e: any) { if (e.code !== "EEXIST") throw e; }
  }
}

export class BrowserDownloads {
  readonly directory: string;
  readonly manifest: string;
  private records = new Map<string, Entry>();
  private turns: TurnWindow[] = [];
  private activeTurn: string | null = null;
  revision = 0;

  constructor(project: string) {
    this.directory = new Paths(project).downloads;
    this.manifest = path.join(this.directory, ".records", randomUUID(), "manifest.json");
  }

  /** New turns have an empty visible list. Old transfers keep their original metadata
   * and files, and their eventual done callbacks cannot repopulate the new turn.
   */
  setContext(context: ToolContextState): void {
    const changedTurn = this.activeTurn !== context.turnId;
    this.activeTurn = context.turnId;
    this.turns = context.turns;
    let changedRecord = false;
    for (const { record } of this.records.values()) {
      // A delayed runtime boundary notification is reconciled against actual
      // start/end times; it never assigns a completed old transfer to a new turn.
      if (this.turns.length && record.startedAt < this.turns[0].startedAt) continue;
      const turnId = this.turnAt(record.startedAt);
      if (turnId !== record.turnId) { record.turnId = turnId; changedRecord = true; }
    }
    if (changedTurn || changedRecord) this.revision++;
    if (changedRecord) this.persist();
  }

  private turnAt(time: number): string | null {
    return this.turns.findLast((t) => t.startedAt <= time && (t.endedAt === undefined || time < t.endedAt))?.id ?? null;
  }

  accept(event: { preventDefault(): void }, item: DownloadItem, pageId: string): void {
    const id = randomUUID(), startedAt = Date.now();
    const record: BrowserDownload = {
      id, pageId, turnId: this.turnAt(startedAt), filename: filename(item.getFilename()), source: source(item.getURL()), mimeType: item.getMimeType(), startedAt,
      state: "progressing", receivedBytes: 0, totalBytes: item.getTotalBytes(),
    };
    const entry: Entry = { record, item, startedRevision: this.revision + 1 };
    this.records.set(id, entry);
    try {
      entry.destination = reserve(this.directory, record.filename);
      record.filename = path.basename(entry.destination);
      // Synchronous in will-download: never allow Electron's default save dialog.
      item.setSavePath(entry.destination);
    } catch (e) {
      event.preventDefault();
      try { if (entry.destination) fs.rmSync(entry.destination, { force: true }); } catch { /* No default dialog fallback. */ }
      entry.item = undefined;
      record.state = "interrupted";
      record.finishedAt = Date.now();
      record.error = `Could not prepare download: ${errorMessage(e)}`;
      this.changed();
      return;
    }
    item.once("done", (_event, state) => {
      record.state = state;
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.finishedAt = Date.now();
      if (state === "completed") {
        try {
          const stat = fs.statSync(entry.destination!);
          if (!stat.isFile() || (stat.size === 0 && record.totalBytes > 0)) throw new Error("the destination has no completed file content");
          record.path = entry.destination;
        } catch (e) {
          record.state = "interrupted";
          record.error = `Download finished without a file: ${errorMessage(e)}`;
        }
      } else {
        record.error = `Chromium download ${state}; no completed file is available.`;
        try { fs.rmSync(entry.destination!, { force: true }); } catch { /* Do not crash the native callback. */ }
      }
      entry.item = undefined;
      this.changed();
    });
    this.changed();
  }

  list(): BrowserDownload[] {
    if (!this.activeTurn) return [];
    return [...this.records.values()].filter(({ record }) => record.turnId === this.activeTurn).map((entry) => this.read(entry));
  }

  private read({ record, item }: Entry): BrowserDownload {
    return { ...record, ...(item ? { receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() } : {}) };
  }

  /** A small, nonblocking progress API. Unknown size/rate is null, not invented. */
  progress(id: string): object {
    const entry = this.records.get(id);
    if (!entry || !this.activeTurn || entry.record.turnId !== this.activeTurn) throw new Error(`no download ${id} belongs to the current turn`);
    const record = this.read(entry), time = Date.now(), sample = entry.sample;
    const bytesPerSecond = entry.item && sample && time > sample.time ? Math.max(0, (record.receivedBytes - sample.bytes) * 1000 / (time - sample.time)) : null;
    entry.sample = { time, bytes: record.receivedBytes };
    return {
      ...record, done: !entry.item,
      totalBytes: record.totalBytes > 0 ? record.totalBytes : null,
      percent: record.state === "completed" ? 100 : record.totalBytes > 0 ? Math.min(100, record.receivedBytes * 100 / record.totalBytes) : null,
      bytesPerSecond, paused: entry.item?.isPaused() ?? false,
      transferState: entry.item?.getState() ?? record.state,
    };
  }

  startedAfter(pageId: string, revision: number): boolean {
    return [...this.records.values()].some((entry) => entry.record.pageId === pageId && entry.startedRevision > revision);
  }

  private changed(): void { this.revision++; this.persist(); }
  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.manifest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(`${this.manifest}.tmp`, JSON.stringify({ downloads: [...this.records.values()].map((entry) => this.read(entry)) }, null, 2), { mode: 0o600 });
      fs.renameSync(`${this.manifest}.tmp`, this.manifest);
    } catch (e) {
      for (const { record } of this.records.values()) record.error ??= `Download ledger could not be saved: ${errorMessage(e)}`;
    }
  }
}
