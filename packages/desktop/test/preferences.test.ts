import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { TEXT } from "../renderer/text.js";

const values = new Map<string, string>();
const classes = new Set<string>();
const dataset: Record<string, string> = {};
let storageListener: (event: { key: string | null }) => void;
let failWrites = false;
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { if (failWrites) throw new Error("storage unavailable"); values.set(key, value); },
  },
  document: { documentElement: { dataset, classList: { toggle: (key: string, on: boolean) => on ? classes.add(key) : classes.delete(key) } } },
  window: { addEventListener: (_: string, listener: typeof storageListener) => { storageListener = listener; } },
  // Windows/Linux read the theme's colors for the window buttons (syncWindowColors); the test runs on every platform.
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
});
const prefs = await import("../renderer/preferences.js");
beforeEach(() => { values.clear(); classes.clear(); failWrites = false; prefs.applyPreferences(); });

test("appearance survives a reload while each workspace retains its own task filter", async () => {
  prefs.saveGlobalPreferences({ theme: "dark", density: "compact" });
  prefs.saveWorkspacePreferences("/films/one", { showCompleted: true });
  const reloaded = await import("../renderer/preferences.js?reload");
  assert.equal(reloaded.globalPreferences().theme, "dark");
  assert.equal(dataset.theme, "dark");
  assert.equal(dataset.density, "compact");
  assert.equal(reloaded.workspacePreferences("/films/one").showCompleted, true);
  assert.equal(reloaded.workspacePreferences("/films/two").showCompleted, false);
  assert.equal(reloaded.globalPreferences().showTools, true);
});

test("corrupt and obsolete saved preferences fall back to usable defaults", () => {
  values.set("xsb.ui.global", "broken JSON");
  assert.deepEqual(prefs.globalPreferences(), prefs.GLOBAL_DEFAULTS);
  values.set("xsb.ui.global", '{"theme":"removed","density":null,"showTools":"false"}');
  values.set("xsb.ui.workspace:/one", '{"showCompleted":true,"obsolete":123}');
  assert.deepEqual(prefs.globalPreferences(), prefs.GLOBAL_DEFAULTS);
  assert.deepEqual(prefs.workspacePreferences("/one"), { showCompleted: true });
});

test("other windows update appearance and notify the task list, unrelated storage does not", () => {
  let updates = 0;
  prefs.onPreferencesChanged(() => updates++);
  values.set("xsb.ui.global", '{"theme":"dark","showTools":false}');
  storageListener({ key: "unrelated" });
  assert.equal(updates, 0);
  storageListener({ key: "xsb.ui.global" });
  assert.equal(dataset.theme, "dark");
  assert.equal(classes.has("hide-tools"), true);
  storageListener({ key: "xsb.ui.workspace:/one" });
  assert.equal(updates, 2);
  values.clear();
  storageListener({ key: null });
  assert.equal(dataset.theme, "light");
  assert.equal(classes.has("hide-tools"), false);
});

test("a failed preference save remains visible to the caller and leaves appearance unchanged", () => {
  failWrites = true;
  assert.throws(() => prefs.saveGlobalPreferences({ theme: "dark" }), /storage unavailable/);
  assert.equal(dataset.theme, "light");
  assert.equal(prefs.globalPreferences().theme, "light");
});

test("both interface languages have the same keys", () => {
  assert.deepEqual(Object.keys(TEXT.en).sort(), Object.keys(TEXT["zh-CN"]).sort());
});
