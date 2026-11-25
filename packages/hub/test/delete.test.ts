// Deleting a conversation and cleaning up the project (hub.ts deleteConversation / purgeDeleted, state.ts forget).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hub } from "../src/hub.ts";
import { Paths } from "../src/paths.ts";
import { initProject } from "../src/config.ts";
import { ops } from "../src/state.ts";

function setup(t: test.TestContext) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xsb-delete-")));
  const saved = process.env.XSB_HOME;
  process.env.XSB_HOME = path.join(dir, "home");
  const paths = new Paths(path.join(dir, "project"));
  fs.mkdirSync(paths.dir, { recursive: true });
  initProject(paths);
  t.after(() => {
    if (saved === undefined) delete process.env.XSB_HOME; else process.env.XSB_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const hub = new Hub(paths.project);
  const stopped: string[] = [];
  hub.backends.stop = ((id: string) => void stopped.push(id)) as any;
  return { hub, paths, stopped };
}

/** A conversation with a transcript and an asset file of its own. */
function conversation(hub: Hub, paths: Paths, name: string) {
  const session = hub.createConversation("claude", name);
  const transcript = path.join(paths.dir, Paths.transcript(session.agentId, session.id));
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "x".repeat(1000));
  const file = path.join(paths.assets, `${name}.png`);
  fs.mkdirSync(paths.assets, { recursive: true });
  fs.writeFileSync(file, "y".repeat(500));
  hub.state.commit([ops.putAsset({ id: `image/${name}`, version: 1, path: file, by: session.agentId, sessionId: session.id } as any)]);
  return { session, transcript, file };
}

const listed = (hub: Hub) => [...hub.state.agents.values()].filter((a) => a.conversation && !hub.isDeleted(a)).map((a) => a.name);

test("a deleted conversation leaves the list at once; cleaning up removes its files and records for good", (t) => {
  const { hub, paths, stopped } = setup(t);
  const kept = conversation(hub, paths, "kept");
  const gone = conversation(hub, paths, "gone");
  hub.deleteConversation(gone.session.agentId);
  assert.deepEqual(listed(hub), ["kept"]);
  assert.deepEqual(stopped, [gone.session.agentId]);
  assert.ok(fs.existsSync(gone.transcript), "its files stay until the cleanup");

  const freed = hub.purgeDeleted();
  assert.equal(freed.conversations, 1);
  assert.ok(freed.bytes >= 1500, `freed ${freed.bytes} bytes`);
  assert.ok(!fs.existsSync(paths.agentDir(gone.session.agentId)));
  assert.ok(!fs.existsSync(gone.file));
  assert.ok(fs.existsSync(kept.transcript) && fs.existsSync(kept.file), "the other conversation is untouched");
  assert.deepEqual(hub.purgeDeleted(), { conversations: 0, bytes: 0 }, "a second cleanup has nothing left");

  // What is on disk says the same after a restart.
  const again = new Hub(paths.project);
  assert.deepEqual([...again.state.agents.values()].map((a) => a.name), ["kept"]);
  assert.ok(!again.state.sessions.has(gone.session.id));
  assert.deepEqual([...again.state.assets.keys()], ["image/kept"]);
  const log = fs.readFileSync(path.join(paths.dir, "conversations/agents.jsonl"), "utf8");
  assert.ok(!log.includes(gone.session.agentId), "the log is compacted, not just appended to");
});

test("a conversation that is working is not deleted", (t) => {
  const { hub, paths } = setup(t);
  const busy = conversation(hub, paths, "busy");
  Object.defineProperty(busy.session, "busy", { get: () => true });
  assert.throws(() => hub.deleteConversation(busy.session.agentId), /still working; stop it before deleting it/);
  assert.deepEqual(listed(hub), ["busy"]);
});
