import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { Connection } from "../src/jsonrpc.ts";

test("fragmented UTF-8 messages, blank lines and malformed lines preserve notification order", () => {
  const input = new PassThrough(), output = new PassThrough();
  const conn = new Connection(input, output);
  const seen: string[] = [];
  let replies = "";
  output.on("data", (b) => replies += b);
  conn.onNotification("test", (p) => seen.push(p.text));
  const wire = Buffer.from('\n{broken}\n' + JSON.stringify({ method: "test", params: { text: "你好🌏" } }) + '\r\n' + JSON.stringify({ method: "test", params: { text: "next" } }) + '\n');
  for (const byte of wire) input.write(Buffer.from([byte]));
  assert.deepEqual(seen, ["你好🌏", "next"]);
  assert.equal(JSON.parse(replies).error.code, -32700);
  conn.close();
});

test("a large message delivered in small fragments is parsed exactly once", () => {
  const input = new PassThrough(), conn = new Connection(input, new PassThrough());
  const data = "x".repeat(4 * 1024 * 1024);
  let received = 0;
  conn.onNotification("test", (p) => { assert.equal(p.data, data); received++; });
  const wire = JSON.stringify({ method: "test", params: { data } }) + "\n";
  for (let i = 0; i < wire.length; i += 257) input.write(wire.slice(i, i + 257));
  assert.equal(received, 1);
  conn.close();
});
