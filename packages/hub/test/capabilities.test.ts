import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hub } from "../src/hub.ts";
import { allowRoles, capabilities, migratePermissions, reaches, roleKey, roleReach } from "../src/capabilities.ts";
import { loadProjectConfig, saveProjectConfig } from "../src/config.ts";

function fixture(run: (hub: Hub) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-capabilities-"));
  const hub = new Hub(dir);
  fs.mkdirSync(hub.paths.dir, { recursive: true });
  saveProjectConfig(hub.paths, { version: 2 });
  try { run(hub); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("type edges exist before instances and reach every present and future instance", () => fixture((hub) => {
  hub.putRole({ name: "manager" });
  hub.putRole({ name: "worker" });
  hub.putAgent({ id: "m1", role: "manager" });
  allowRoles(hub, "manager", "dispatch", ["worker"]);
  assert.ok(reaches(roleReach(hub, hub.agent("m1"), "dispatch"), "worker"));
  for (const id of ["w1", "w2"]) {
    hub.putAgent({ id, role: "worker" });
    assert.ok(reaches(capabilities(hub, "m1", "unused").dispatch, id));
    assert.ok(!reaches(capabilities(hub, "m1", "unused").message, id));
  }
  hub.putAgent({ id: "m2", role: "manager" });
  assert.ok(reaches(capabilities(new Hub(hub.paths.project), "m2", "unused").dispatch, "w2"), "edges survive hub restart");
}));

test("roleless instance permissions cannot be inherited by a dynamically created namesake type", () => fixture((hub) => {
  hub.putAgent({ id: "solo" });
  hub.putAgent({ id: "target" });
  allowRoles(hub, roleKey(hub.agent("solo")), "dispatch", [roleKey(hub.agent("target"))]);
  hub.putRole({ name: "solo" });
  hub.putRole({ name: "target" });
  hub.putAgent({ id: "impostor", role: "solo" });
  hub.putAgent({ id: "other-target", role: "target" });
  assert.ok(reaches(capabilities(hub, "solo", "unused").dispatch, "target"));
  assert.ok(!reaches(capabilities(hub, "solo", "unused").dispatch, "other-target"));
  assert.ok(!reaches(capabilities(hub, "impostor", "unused").dispatch, "target"));
}));

test("legacy instance entries migrate, merging canonical entries without changing real type policies", () => fixture((hub) => {
  hub.putAgent({ id: "solo" });
  hub.putAgent({ id: "target" });
  hub.putRole({ name: "manager" });
  saveProjectConfig(hub.paths, { version: 2, permissions: { solo: { dispatch: ["target"] }, "agent:solo": { dispatch: ["manager"] }, manager: { message: ["solo", "*", "retired-role"] } } });
  migratePermissions(hub);
  const expected = { "agent:solo": { dispatch: ["agent:target", "manager"] }, manager: { message: ["agent:solo", "*", "retired-role"] } };
  assert.deepEqual(loadProjectConfig(hub.paths).permissions, expected);
  migratePermissions(hub);
  assert.deepEqual(loadProjectConfig(hub.paths).permissions, expected);
  hub.putRole({ name: "solo" });
  hub.putAgent({ id: "new-solo", role: "solo" });
  assert.ok(!reaches(capabilities(hub, "new-solo", "unused").dispatch, "target"));
}));

test("ambiguous legacy names remain type policy and do not grant the roleless namesake access", () => fixture((hub) => {
  hub.putRole({ name: "same" });
  hub.putRole({ name: "worker" });
  hub.putAgent({ id: "same" });
  hub.putAgent({ id: "typed", role: "same" });
  saveProjectConfig(hub.paths, { version: 2, permissions: { same: { dispatch: ["worker"] } } });
  migratePermissions(hub);
  assert.ok(reaches(roleReach(hub, hub.agent("typed"), "dispatch"), "worker"));
  assert.ok(!reaches(roleReach(hub, hub.agent("same"), "dispatch"), "worker"));
}));
