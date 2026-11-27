import assert from "node:assert/strict";
import test from "node:test";
import { ConversationEvent, conversationEntry } from "../src/conversation-event.ts";

test("Markdown publications are attributed, versioned, and separate from historical ACP messages", () => {
  const entry = { schemaVersion: 1, id: "p1", sessionId: "main", source: { kind: "plugin", id: "charts", label: "Charts" }, markdown: "# Result\n\n**12** items" };
  const update = (value: unknown) => ({ sessionUpdate: "session_info_update", _meta: { [ConversationEvent.key]: value } });
  assert.deepEqual(conversationEntry(update({ ...entry, futureField: true }), "main"), entry);
  assert.equal(conversationEntry(update(entry), "other"), undefined);
  for (const value of [undefined, null, [], { ...entry, schemaVersion: 2 }, { ...entry, markdown: {} }, { ...entry, source: { kind: "user" } }]) {
    assert.equal(conversationEntry(update(value), "main"), undefined);
  }
  for (const sessionUpdate of ["user_message_chunk", "agent_message_chunk", "tool_call", "state_update"]) {
    assert.equal(conversationEntry({ ...update(entry), sessionUpdate }, "main"), undefined);
  }
});
