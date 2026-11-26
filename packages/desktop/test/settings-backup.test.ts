import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { settingsBundle, restoreSettingsBundle, validateSettingsBundle } from "@xsb/hub";
import { saveGlobalConfig, loadGlobalConfig } from "../../hub/src/config.ts";

test("settings restore preserves local trust, plugin bytes and preferences without executing anything", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-settings-backup-")), previous = process.env.XSB_HOME;
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); if (previous === undefined) delete process.env.XSB_HOME; else process.env.XSB_HOME = previous; });
  process.env.XSB_HOME = path.join(dir, "source");
  saveGlobalConfig({ version: 1, backends: { custom: { command: "custom-acp" } }, approvedPlugins: ["source-trust"] });
  const plugin = path.join(process.env.XSB_HOME, "plugins", "example"); fs.mkdirSync(plugin, { recursive: true }); fs.writeFileSync(path.join(plugin, "index.js"), "throw new Error('must not execute')");
  const bundle = { ...settingsBundle(), ui: { "xsb.ui.global": '{"theme":"dark"}' } };
  assert.equal(bundle.config.approvedPlugins, undefined);
  process.env.XSB_HOME = path.join(dir, "destination");
  saveGlobalConfig({ version: 1, approvedPlugins: ["local-trust"] });
  restoreSettingsBundle(bundle); restoreSettingsBundle(bundle);
  assert.deepEqual(loadGlobalConfig().approvedPlugins, ["local-trust"]);
  assert.equal(loadGlobalConfig().backends?.custom.command, "custom-acp");
  assert.equal(fs.readFileSync(path.join(process.env.XSB_HOME, "plugins", "example", "index.js"), "utf8"), "throw new Error('must not execute')");
  assert.equal(bundle.ui["xsb.ui.global"], '{"theme":"dark"}');
  const escaping = structuredClone(bundle); escaping.plugins[0].path = "example/../../outside";
  assert.throws(() => validateSettingsBundle(escaping), /Invalid plugin/);
  const injected = { ...bundle, ui: { "account.password": "value" } };
  assert.throws(() => validateSettingsBundle(injected), /Invalid UI/);
});
