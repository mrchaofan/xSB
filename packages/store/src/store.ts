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

export type Record_ = Record<string, any>;
export type Op = { file: string; rec: Record_ };

const WAL = "wal.jsonl";
const WAL_CHECKPOINT_BYTES = 1 << 20;

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

  constructor(root: string) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  private abs(file: string): string {
    return path.join(this.root, file);
  }

  read(file: string): Record_[] {
    return readLines(this.abs(file));
  }

  /**
   * The records of a log from the last to the first, read in chunks from the end of the file: a reader that wants
   * only the recent part of a long log (a transcript up to its last boundary) stops early and never reads the rest.
   * A torn last line is skipped, as `read` does.
   */
  *readBackward(file: string, chunkBytes = 64 * 1024): Generator<Record_> {
    const abs = this.abs(file);
    if (!fs.existsSync(abs)) return;
    const fd = fs.openSync(abs, "r");
    try {
      let position = fs.fstatSync(fd).size;
      /** Bytes of the line that the chunks read so far end in the middle of: its start is further back. */
      let rest = Buffer.alloc(0);
      const parse = (line: Buffer): Record_ | undefined => {
        if (line.length === 0) return undefined;
        try {
          return JSON.parse(line.toString("utf8"));
        } catch {
          return undefined; // torn line
        }
      };
      while (position > 0) {
        const size = Math.min(chunkBytes, position);
        position -= size;
        const chunk = Buffer.alloc(size);
        fs.readSync(fd, chunk, 0, size, position);
        const data = Buffer.concat([chunk, rest]);
        // Lines are cut at byte 0x0a, which never occurs inside a UTF-8 character.
        let end = data.length;
        for (;;) {
          const nl = end > 0 ? data.lastIndexOf(0x0a, end - 1) : -1;
          if (nl < 0) break;
          const rec = parse(data.subarray(nl + 1, end));
          if (rec) yield rec;
          end = nl;
        }
        rest = data.subarray(0, end);
      }
      const first = parse(rest);
      if (first) yield first;
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Append one record. `sync` forces it to disk before returning. */
  append(file: string, rec: Record_, sync = true): void {
    const abs = this.abs(file);
    if (!this.repaired.has(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      repairTail(abs);
      this.repaired.add(abs);
    }
    const fd = fs.openSync(abs, "a");
    try {
      fs.writeSync(fd, JSON.stringify(rec) + "\n");
      if (sync) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Apply all ops or none. A single op needs no WAL. */
  tx(ops: Op[]): void {
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
    } catch (e) {
      this.unfinished = true;
      throw e;
    }
    this.checkpoint();
  }

  /** Test hook: throw here to simulate a crash between two steps of `tx`. */
  failpoint?: (at: string) => void;

  /** Finish transactions a crash left half applied. Call once, before reading state. */
  recover(): number {
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
  }

  /** The WAL only matters for open transactions; with none open it can be emptied. */
  private checkpoint(force = false): void {
    const abs = this.abs(WAL);
    if (!fs.existsSync(abs) || (this.unfinished && !force)) return;
    if (force || fs.statSync(abs).size > WAL_CHECKPOINT_BYTES) fs.truncateSync(abs, 0);
  }

  /** Replace a log by its compacted form, atomically. */
  rewrite(file: string, recs: Record_[]): void {
    const abs = this.abs(file);
    const tmp = `${abs}.tmp`;
    fs.writeFileSync(tmp, recs.map((r) => JSON.stringify(r) + "\n").join(""));
    const fd = fs.openSync(tmp, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, abs);
  }
}
