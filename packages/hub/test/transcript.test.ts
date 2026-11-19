import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "@xsb/store";
import { Boundaries, OriginExt } from "@xsb/protocol";
import { Paths } from "../src/paths.ts";
import { turnsSinceCleared } from "../src/transcript.ts";
import { handoff } from "../src/prompts.ts";

function readTurns(updates: any[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-transcript-"));
  try {
    const store = new Store(dir);
    updates.forEach((update) => store.append(Paths.transcript("a", "s"), { ts: "2026-01-01T00:00:00Z", update }, false));
    return turnsSinceCleared(store, "a", "s");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const input = (id: string, text: string, steered = false) => ({
  sessionUpdate: "user_message_chunk", messageId: id, content: { type: "text", text },
  _meta: { [OriginExt.key]: { kind: "user", steered } },
});
const reply = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

test("handoff retains tools reported only as updates and the final answer after tool activity", () => {
  const turns = readTurns([
    input("u1", "Fix the image"), reply("Checking it."),
    { sessionUpdate: "tool_call_update", toolCallId: "t1", title: "Read image", status: "in_progress" },
    { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
    reply("The image is ready."),
    { sessionUpdate: "tool_call", toolCallId: "t2", title: "Verify output", status: "pending" },
    { sessionUpdate: "tool_call_update", toolCallId: "t2", title: "Verify dimensions", status: "completed" },
    { sessionUpdate: "agent_message", content: [{ type: "text", text: "Verified and registered." }] },
    input("u2", "Continue"),
    { sessionUpdate: "tool_call_update", toolCallId: "t1", title: "Read next image", status: "completed" },
    reply("Next image ready."),
  ]);
  assert.deepEqual(turns.map(t => t.tools), [["Read image", "Verify dimensions"], ["Read next image"]]);
  assert.deepEqual(turns.map(t => t.reply), ["Verified and registered.", "Next image ready."]);
});

test("handoff respects cleared boundaries and keeps steered inputs and tool updates in one turn", () => {
  const turns = readTurns([
    input("old", "Old context"),
    { sessionUpdate: "session_info_update", _meta: { [Boundaries.key]: { kind: "cleared" } } },
    input("new", "Current context"),
    { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "pending" },
    input("steer", "Keep the face", true),
    { sessionUpdate: "tool_call_update", toolCallId: "t1", title: "Render", status: "completed" },
    reply("Done"),
  ]);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].inputs.map(i => i.text), ["Current context", "Keep the face"]);
  assert.deepEqual(turns[0].tools, ["Render"]);
  assert.equal(turns[0].reply, "Done");
});

test("an oversized latest input still hands off the recent decision without enlarging the history budget", () => {
  const text = handoff("renewed", [{
    at: "2026-01-01T00:00:00Z",
    inputs: [{ origin: { kind: "user" }, text: `Use the selected image.\n${"asset contents\n".repeat(5000)}` }],
    tools: ["Read image\n" + "command details\n".repeat(5000)],
    reply: "Selected image registered; proceed to editing.",
  }], { tasks: [], waiting: [], assets: [] });
  assert.ok(text.includes("Use the selected image."));
  assert.ok(text.includes("Selected image registered; proceed to editing."));
  assert.ok(text.includes("Excerpt"));
  assert.ok(!text.includes("There is no earlier conversation to tell."));
  assert.ok(text.length < 42_000);
});
