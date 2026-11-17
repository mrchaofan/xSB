import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-store-"));
const ops = [
  { file: "a.jsonl", rec: { n: 1 } },
  { file: "b.jsonl", rec: { n: 2 } },
  { file: "sub/c.jsonl", rec: { n: 3 } },
];
const strip = (recs: any[]) => recs.map(({ _tx, ...r }) => r);

// A crash at every point of a transaction ends, after recovery, in all or nothing.
for (const at of ["after-begin", "after-op-0", "after-op-1", "after-op-2"]) {
  const root = path.join(dir, at);
  const store = new Store(root);
  store.failpoint = (p) => {
    if (p === at) throw new Error("crash");
  };
  assert.throws(() => store.tx(ops));

  const reopened = new Store(root);
  assert.equal(reopened.recover(), 1, at);
  assert.deepEqual(strip(reopened.read("a.jsonl")), [{ n: 1 }], at);
  assert.deepEqual(strip(reopened.read("b.jsonl")), [{ n: 2 }], at);
  assert.deepEqual(strip(reopened.read("sub/c.jsonl")), [{ n: 3 }], at);
  // Recovery is idempotent.
  assert.equal(new Store(root).recover(), 0, at);
  assert.equal(reopened.read("a.jsonl").length, 1, at);
}

// A begin line that never fully reached the disk is a transaction that never happened.
{
  const root = path.join(dir, "torn-begin");
  const store = new Store(root);
  store.append("a.jsonl", { n: 0 });
  fs.appendFileSync(path.join(root, "wal.jsonl"), '{"t":"begin","tx":"tx_x","ops":[{"f":"a.jsonl","r":{"n"');
  assert.equal(new Store(root).recover(), 0);
  assert.deepEqual(store.read("a.jsonl"), [{ n: 0 }]);
}

// A torn data line is dropped, and the next append starts on a clean line.
{
  const root = path.join(dir, "torn-data");
  const store = new Store(root);
  store.append("a.jsonl", { n: 1 });
  fs.appendFileSync(path.join(root, "a.jsonl"), '{"n":2,"half');
  const reopened = new Store(root);
  reopened.append("a.jsonl", { n: 3 });
  assert.deepEqual(reopened.read("a.jsonl"), [{ n: 1 }, { n: 3 }]);
}

// The committed path.
{
  const store = new Store(path.join(dir, "ok"));
  store.tx(ops);
  store.tx(ops);
  assert.equal(store.read("a.jsonl").length, 2);
  assert.equal(store.recover(), 0);
  assert.equal(store.read("wal.jsonl").length, 0);
}

// A transaction that failed half way (a full disk, say) while the process went on: later transactions, however
// large, do not empty the log that still has to finish it.
{
  const root = path.join(dir, "failed-then-busy");
  const store = new Store(root);
  store.failpoint = (p) => {
    if (p === "after-op-0") throw new Error("disk full");
  };
  assert.throws(() => store.tx(ops));
  store.failpoint = undefined;
  const big = "x".repeat(600_000);
  store.tx([{ file: "d.jsonl", rec: { big } }, { file: "e.jsonl", rec: { big } }]);
  const reopened = new Store(root);
  assert.equal(reopened.recover(), 1);
  assert.deepEqual(strip(reopened.read("sub/c.jsonl")), [{ n: 3 }]);
}

// Reading backward yields the same records last first, whatever the chunk size cuts through (lines, characters of
// several bytes), skips a torn last line, and stops reading where the reader stops.
{
  const store = new Store(path.join(dir, "backward"));
  const recs = Array.from({ length: 50 }, (_, n) => ({ n, text: "长生".repeat(n % 7) }));
  for (const rec of recs) store.append("t.jsonl", rec, false);
  fs.appendFileSync(path.join(dir, "backward", "t.jsonl"), '{"torn":');
  for (const chunk of [1, 3, 7, 64, 1 << 16]) assert.deepEqual([...store.readBackward("t.jsonl", chunk)], recs.slice().reverse(), `chunk ${chunk}`);
  const seen: number[] = [];
  for (const rec of store.readBackward("t.jsonl", 16)) {
    seen.push(rec.n);
    if (rec.n === 47) break;
  }
  assert.deepEqual(seen, [49, 48, 47]);
  assert.deepEqual([...store.readBackward("none.jsonl")], []);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("store: ok");
