/**
 * Append-only JSONL files plus a write-ahead log for changes that span files.
 *
 * Every piece of hub state is an event log: state is whatever replaying the
 * file yields. A single-file change is one appended line, which is atomic
 * enough on its own (a torn last line is discarded on open). A change that
 * must land in several files together goes through `tx`:
 *
 *   1. append  {t:"begin", tx, ops:[{f, r}, ...]}  to wal.jsonl, fsync
 *   2. append each record to its file, tagged `_tx: "<tx>:<index>"`, fsync
 *   3. append  {t:"commit", tx}                    to wal.jsonl
 *
 * It is a redo log. After a crash, `recover` finds begins without a commit and
 * appends whichever tagged records are missing, so a transaction is applied
 * completely or (if its begin line never made it to disk) not at all.
 *
 * The hub is the only writer; `tx` is synchronous, so transactions never
 * interleave within the process.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWrite, ensureDirectory, syncDirectory } from "./files.ts";
export { atomicWrite, ensureDirectory, syncDirectory } from "./files.ts";

export type Record_ = Record<string, any>;
export type Op = { file: string; rec: Record_ };

const WAL = "wal.jsonl";
const WAL_CHECKPOINT_BYTES = 1 << 20;
const MANIFEST = "conversations/current.json";

/** Drop a trailing partial line left by a crash mid-append. */
function repairTail(file: string): void {
  if (!fs.existsSync(file)) return;
  const data = fs.readFileSync(file);
  if (data.length === 0 || data[data.length - 1] === 0x0a) return;
  const lastNewline = data.lastIndexOf(0x0a);
  fs.truncateSync(file, lastNewline + 1);
}

function readLines(file: string): Record_[] {
  if (!fs.existsSync(file)) return [];
  const out: Record_[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* torn line: never acknowledged, so never happened */
    }
  }
  return out;
}

export class Store {
  private root: string;
  private repaired = new Set<string>();
  /** A transaction began and did not reach its commit: an append failed. Until `recover` finishes it, only the WAL knows of it. */
  private unfinished = false;
  private recovering = false;
  private aliases: Record<string, string> = {};
  private baselines: Record<string, number> = {};
  onFailure?: (error: unknown) => void;

  get healthy(): boolean { return !this.unfinished; }
  private writable(): void {
    if (this.unfinished && !this.recovering) throw new Error("Storage write failed; restart and recover before writing again.");
  }
  private failed(error: unknown): never {
    const first = !this.unfinished;
    this.unfinished = true;
    if (first) this.onFailure?.(error);
    throw error;
  }

  constructor(root: string) {
    this.root = root;
    ensureDirectory(root);
    const manifest = path.join(root, MANIFEST);
    if (fs.existsSync(manifest)) {
      const saved = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (saved.version !== 1 || !saved.files || typeof saved.files !== "object" || Array.isArray(saved.files)) throw new Error("Invalid storage manifest");
      for (const [logical, physical] of Object.entries(saved.files)) {
        if (typeof physical !== "string" || !physical.startsWith("conversations/generations/") || path.isAbsolute(physical) || physical.split(/[\\/]/).includes("..")) throw new Error("Invalid storage generation path");
        if (!fs.existsSync(path.join(root, physical))) throw new Error(`Missing storage generation: ${physical}`);
        this.aliases[logical] = physical;
        const baseline = saved.baselines?.[logical] ?? 0;
        if (!Number.isSafeInteger(baseline) || baseline < 0 || baseline > fs.statSync(path.join(root, physical)).size) throw new Error("Invalid storage snapshot baseline");
        this.baselines[logical] = baseline;
      }
    }
  }

  private abs(file: string): string {
    return path.join(this.root, this.aliases[file] ?? file);
  }

  filePath(file: string): string { return this.abs(file); }
  bytes(file: string): number { return fs.statSync(this.abs(file), { throwIfNoEntry: false })?.size ?? 0; }
  deltaBytes(file: string): number { return Math.max(0, this.bytes(file) - (this.baselines[file] ?? 0)); }

  read(file: string): Record_[] {
    return readLines(this.abs(file));
  }

  /**
   * The records of a log from the last to the first, read in chunks from the end of the file: a reader that wants
   * only the recent part of a long log (a transcript up to its last boundary) stops early and never reads the rest.
   * A torn last line is skipped, as `read` does.
   */
  *readBackward(file: string, chunkBytes = 64 * 1024): Generator<Record_> {
    for (const { record } of this.readBackwardEntries(file, undefined, chunkBytes)) yield record;
  }

  /** Records with stable byte offsets; `before` excludes that byte and everything after it. */
  *readBackwardEntries(file: string, before?: number, chunkBytes = 64 * 1024): Generator<{ offset: number; record: Record_ }> {
    const abs = this.abs(file);
    if (!fs.existsSync(abs)) return;
    const fd = fs.openSync(abs, "r");
    try {
      let position = Math.min(before ?? Infinity, fs.fstatSync(fd).size);
      let fragments: Buffer[] = [];
      const parse = (first: Buffer): Record_ | undefined => {
        const line = fragments.length ? Buffer.concat([first, ...fragments.reverse()]) : first;
        fragments = [];
        if (!line.length) return;
        try { return JSON.parse(line.toString("utf8")); } catch { return; }
      };
      while (position > 0) {
        const size = Math.min(chunkBytes, position);
        position -= size;
        const chunk = Buffer.alloc(size);
        fs.readSync(fd, chunk, 0, size, position);
        let end = chunk.length;
        for (;;) {
          const nl = end > 0 ? chunk.lastIndexOf(0x0a, end - 1) : -1;
          if (nl < 0) break;
          const record = parse(chunk.subarray(nl + 1, end));
          if (record) yield { offset: position + nl + 1, record };
          end = nl;
        }
        if (end > 0) fragments.push(chunk.subarray(0, end));
      }
      const record = parse(Buffer.alloc(0));
      if (record) yield { offset: 0, record };
    } finally { fs.closeSync(fd); }
  }

  /** One record addressed by a history image reference. */
  readAt(file: string, offset: number): Record_ | undefined {
    const fd = fs.openSync(this.abs(file), "r");
    try {
      const fragments: Buffer[] = [];
      let position = offset;
      for (;;) {
        const chunk = Buffer.alloc(64 * 1024);
        const count = fs.readSync(fd, chunk, 0, chunk.length, position);
        if (!count) return;
        const nl = chunk.subarray(0, count).indexOf(0x0a);
        fragments.push(chunk.subarray(0, nl < 0 ? count : nl));
        if (nl >= 0) return JSON.parse(Buffer.concat(fragments).toString("utf8"));
        position += count;
      }
    } finally { fs.closeSync(fd); }
  }

  /** Append one record. `sync` forces it to disk before returning. */
  append(file: string, rec: Record_, sync = true): void {
    this.writable();
    try {
      this.appendRecord(file, rec, sync);
      if (file === "audit.jsonl" && this.bytes(file) > 16 * 1024 * 1024) {
        const abs = this.abs(file), fd = fs.openSync(abs, "r");
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(abs, `${abs}.${Date.now()}-${randomBytes(3).toString("hex")}`);
        syncDirectory(path.dirname(abs));
        this.repaired.delete(abs);
      }
    } catch (error) { this.failed(error); }
  }

  private appendRecord(file: string, rec: Record_, sync: boolean): void {
    const abs = this.abs(file);
    const exists = fs.existsSync(abs);
    if (!this.repaired.has(abs)) {
      ensureDirectory(path.dirname(abs));
      repairTail(abs);
      this.repaired.add(abs);
    }
    const fd = fs.openSync(abs, "a");
    try {
      fs.writeFileSync(fd, JSON.stringify(rec) + "\n");
      if (sync) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (sync && !exists) syncDirectory(path.dirname(abs));
  }

  /** Apply all ops or none. A single op needs no WAL. */
  tx(ops: Op[]): void {
    this.writable();
    if (ops.length === 0) return;
    if (ops.length === 1) return this.append(ops[0].file, ops[0].rec);
    const tx = `tx_${randomBytes(6).toString("hex")}`;
    try {
      this.append(WAL, { t: "begin", tx, ops: ops.map((o) => ({ f: o.file, r: o.rec })) });
      this.failpoint?.("after-begin");
      ops.forEach((op, i) => {
        this.append(op.file, { ...op.rec, _tx: `${tx}:${i}` });
        this.failpoint?.(`after-op-${i}`);
      });
      this.append(WAL, { t: "commit", tx });
      this.checkpoint();
    } catch (e) {
      this.failed(e);
    }
  }

  /** Test hook: throw here to simulate a crash between two steps of `tx`. */
  failpoint?: (at: string) => void;

  /** Finish transactions a crash left half applied. Call once, before reading state. */
  recover(): number {
    if (this.unfinished) throw new Error("Recover storage using a new Store and rebuild state.");
    this.recovering = true;
    try {
      repairTail(this.abs(WAL));
      const begun = new Map<string, { f: string; r: Record_ }[]>();
      for (const rec of this.read(WAL)) {
        if (rec.t === "begin") begun.set(rec.tx, rec.ops);
        else if (rec.t === "commit") begun.delete(rec.tx);
      }
      for (const [tx, ops] of begun) {
        const applied = new Map<string, Set<string>>();
        ops.forEach((op, i) => {
          let tags = applied.get(op.f);
          if (!tags) {
            repairTail(this.abs(op.f));
            tags = new Set(this.read(op.f).map((r) => r._tx).filter(Boolean));
            applied.set(op.f, tags);
          }
          const tag = `${tx}:${i}`;
          if (!tags.has(tag)) this.append(op.f, { ...op.r, _tx: tag });
        });
        this.append(WAL, { t: "commit", tx });
      }
      this.unfinished = false;
      this.checkpoint(true);
      return begun.size;
    } finally { this.recovering = false; }
  }

  /** The WAL only matters for open transactions; with none open it can be emptied. */
  private checkpoint(force = false): void {
    const abs = this.abs(WAL);
    if (!fs.existsSync(abs) || (this.unfinished && !force)) return;
    if (force || fs.statSync(abs).size > WAL_CHECKPOINT_BYTES) {
      const fd = fs.openSync(abs, "r+");
      try { fs.ftruncateSync(fd, 0); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  }

  /** Replace a log by its compacted form, atomically. */
  rewrite(file: string, recs: Record_[]): void {
    this.writable();
    try { atomicWrite(this.abs(file), recs.map((r) => JSON.stringify(r) + "\n").join("")); }
    catch (error) { this.failed(error); }
  }

  /** Switch a group of compacted logs with one durable manifest publication. Transcripts keep their offsets. */
  compact(logs: Record<string, Record_[]>): void {
    this.writable();
    const prior = { ...this.aliases };
    const generation = `conversations/generations/g_${randomBytes(8).toString("hex")}`;
    const next = { ...prior };
    const baselines = { ...this.baselines };
    try {
      this.checkpoint(true);
      for (const [i, [file, recs]] of Object.entries(logs).entries()) {
        next[file] = `${generation}/${i}-${path.basename(file)}`;
        atomicWrite(path.join(this.root, next[file]), recs.map(r => JSON.stringify(r) + "\n").join(""));
        baselines[file] = fs.statSync(path.join(this.root, next[file])).size;
        this.failpoint?.(`after-snapshot-file-${i}`);
      }
      this.failpoint?.("before-snapshot-publish");
      atomicWrite(path.join(this.root, MANIFEST), JSON.stringify({ version: 1, files: next, baselines }) + "\n");
      this.aliases = next;
      this.baselines = baselines;
      this.failpoint?.("after-snapshot-publish");
    } catch (error) { this.failed(error); }
    // Cleanup follows publication; failures only leave unused files, never a partial state.
    for (const file of Object.keys(logs)) {
      for (const old of new Set([prior[file] ?? file, file])) {
        try { fs.rmSync(path.join(this.root, old), { force: true }); } catch { /* retry on a later maintenance pass */ }
      }
    }
    for (const dir of new Set(Object.values(prior).map(file => path.dirname(path.join(this.root, file))))) {
      try { fs.rmdirSync(dir); } catch { /* a live or nonempty generation stays */ }
    }
    const active = new Set(Object.values(next).map(file => path.dirname(path.join(this.root, file))));
    try {
      const generations = path.join(this.root, "conversations/generations");
      for (const entry of fs.readdirSync(generations, { withFileTypes: true })) {
        const dir = path.join(generations, entry.name);
        if (entry.isDirectory() && /^g_[a-f0-9]{16}$/.test(entry.name) && !active.has(dir)) fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch { /* unused generations can be collected on the next successful maintenance */ }
  }
}
