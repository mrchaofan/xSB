import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
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
});
