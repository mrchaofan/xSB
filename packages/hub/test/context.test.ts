import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { boundedText, contentTokens, contextOverflow, contextRef, readContext, textTokens } from "../src/context.ts";
import { Paths } from "../src/paths.ts";

test("large text and JSON retain their original and return valid bounded retrieval envelopes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-context-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = new Paths(dir);
  for (const body of ["中文决定\n".repeat(20000), "\u0000".repeat(10000), JSON.stringify({ result: "x\n\t\"".repeat(10000), status: "completed" })]) {
    const excerpt = boundedText(paths, "a", body, 4000);
    const envelope = JSON.parse(excerpt);
    assert.ok(textTokens(excerpt) <= 4000);
    let offset = 0, actual = "";
    while (true) {
      const page = JSON.parse(readContext(paths, "a", envelope.context_ref, offset, 777));
      actual += page.text;
      if (page.done) break;
      assert.ok(page.next_offset > offset);
      offset = page.next_offset;
    }
    assert.equal(actual, body);
    assert.throws(() => readContext(paths, "b", envelope.context_ref), /ENOENT/);
  }
  assert.throws(() => readContext(paths, "a", "../../secret"), /Invalid/);
});

test("small content is unchanged and references are stable", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-context-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = new Paths(dir);
  assert.equal(boundedText(paths, "a", "small", 4000), "small");
  const first = contextRef(paths, "a", "decision");
  assert.deepEqual(contextRef(paths, "a", "decision"), first);
  assert.equal(fs.readFileSync(first.file, "utf8"), "decision");
});

test("context estimates cover aggregate inputs and treat images independently of their encoded size", () => {
  const text = { type: "text" as const, text: "x".repeat(1000) };
  assert.equal(contentTokens([text, text]), 1000);
  assert.ok(contentTokens([{ type: "image", data: "a", mimeType: "image/png" }]) > contentTokens([text]));
  assert.ok(contextOverflow({ message: "ignored", data: { errorKind: "context_length_exceeded" } }));
  assert.equal(contextOverflow(new Error("Invalid request: unsupported option")), false);
  assert.equal(contextOverflow(new Error("Rate limit exceeded")), false);
});
