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

fs.rmSync(dir, { recursive: true, force: true });
console.log("store: ok");
