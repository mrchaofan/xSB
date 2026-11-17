import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Hub, Paths } from "@xsb/hub";
import { readRole, saveRole } from "../../hub/src/roles.ts";
import { teams, teamRoles } from "../../hub/src/teams.ts";
import { roleInput, roleView } from "../src/roles.ts";
import { AVATARS, DEFAULT_AVATAR, LEGACY_AVATARS, avatarSource, resolveAvatar } from "../renderer/avatar-catalog.js";

const assets = fileURLToPath(new URL("../renderer/avatars/", import.meta.url));

test("avatar fallback is local and covers old workspaces, roles and overrides", () => {
  assert.equal(resolveAvatar(), DEFAULT_AVATAR);
  assert.equal(resolveAvatar({ avatar: "person-qa" }), "person-satya-nadella");
  assert.equal(avatarSource("person-art-director"), "./avatars/person-huang-le.png");
  assert.equal(avatarSource("toString"), `./avatars/${DEFAULT_AVATAR}.png`);
  assert.equal(resolveAvatar({}, { avatar: "person-director" }), "person-larry-page");
  assert.equal(resolveAvatar({ avatar: "animal-cat" }, { avatar: "person-director" }), "animal-cat");
  assert.equal(resolveAvatar({ avatar: "" }, { avatar: "person-director" }), "person-larry-page");
  assert.equal(resolveAvatar({ avatar: "removed" }, { avatar: "removed" }), DEFAULT_AVATAR);
  assert.equal(avatarSource("https://example.com/a.png"), `./avatars/${DEFAULT_AVATAR}.png`);
});

test("every choice and both languages' preset roles have bundled PNG artwork", () => {
  assert.equal(AVATARS.length, 28);
  assert.equal(AVATARS.filter((a) => a.group === "people").length, 16);
  assert.equal(fs.readdirSync(assets).filter((name) => name.endsWith(".png")).length, AVATARS.length);
  assert.equal(new Set(AVATARS.map((a) => a.id)).size, AVATARS.length);
  for (const { id } of AVATARS) {
    const png = fs.readFileSync(path.join(assets, `${id}.png`));
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), 192);
    assert.equal(png.readUInt32BE(20), 192);
  }
  for (const language of ["en", "zh-CN"] as const) {
    for (const team of teams(language)) for (const entry of team.roles) {
      const role = readRole(path.join(teamRoles(team.id, language), entry.role), entry.role);
      assert.equal(role.avatar, LEGACY_AVATARS[`person-${entry.role}`]);
      assert.ok(AVATARS.some((a) => a.id === role.avatar));
    }
  }
});

test("agent and role avatars survive persistence, partial edits and clearing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-avatars-"));
  try {
    const paths = new Paths(dir);
    saveRole(paths, { name: "artist", avatar: "person-art-director", description: "Draw" });
    saveRole(paths, { name: "artist", description: "Paint" });
    let role = readRole(paths.roleDir("artist"), "artist");
    assert.equal(role.avatar, "person-art-director");
    assert.equal(roleInput(roleView(role)).avatar, "person-art-director");
    const hub = new Hub(dir);
    const a = hub.putAgent({ id: "a", backend: "claude", role: "artist", avatar: "animal-fox" });
    assert.equal(a.avatar, "animal-fox");
    hub.putAgent({ id: "a", name: "Renamed" });
    assert.equal(new Hub(dir).agent("a").avatar, "animal-fox");
    hub.putAgent({ id: "a", avatar: "" });
    assert.equal(new Hub(dir).agent("a").avatar, "");
    assert.equal(resolveAvatar(hub.agent("a"), role), "person-huang-le");
    saveRole(paths, { name: "artist", avatar: "" });
    role = readRole(paths.roleDir("artist"), "artist");
    assert.equal(resolveAvatar(hub.agent("a"), role), DEFAULT_AVATAR);
    assert.throws(() => hub.putAgent({ id: "a", avatar: "../x" }));
    assert.throws(() => saveRole(paths, { name: "artist", avatar: "https://example.com" }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
