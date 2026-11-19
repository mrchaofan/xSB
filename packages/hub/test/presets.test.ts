import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { catalog, check, derive, presetRoots, teamRole, teamRoleNames } from "../src/presets.ts";
import type { PresetRoot } from "../src/presets.ts";
import { Paths } from "../src/paths.ts";
import { loadRole, saveRole } from "../src/roles.ts";

function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-presets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roots: PresetRoot[] = [
    { source: "builtin", dir: path.join(dir, "builtin") },
    { source: "user", dir: path.join(dir, "user") },
  ];
  const write = (source: "builtin" | "user", file: string, content: unknown) => {
    const target = path.join(roots.find((r) => r.source === source)!.dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
  };
  return { dir, roots, write };
}

test("builtin teams ship as one folder each, with both translations", () => {
  const builtin = presetRoots().filter((r) => r.source === "builtin");
  for (const language of ["en", "zh-CN"] as const) {
    const cat = catalog(language, builtin);
    assert.deepEqual(cat.problems, []);
    assert.deepEqual([...cat.teams.keys()].sort(), ["film", "film-ark", "software"]);
    for (const team of cat.teams.values()) {
      assert.equal(team.dir, path.join(builtin[0].dir, team.id, language));
      assert.ok(teamRoleNames(cat, team.id).length > 0);
      assert.equal(check(cat, team.id).filter((p) => p.severity === "error").length, 0);
    }
  }
});

test("the same reader loads builtin, user, single-language and legacy teams", (t) => {
  const { roots, write } = fixture(t);
  write("builtin", "base/en/team.json", { title: "Base" });
  write("builtin", "base/zh-CN/team.json", { title: "基础" });
  write("user", "custom/en/team.json", { title: "Custom" });
  write("user", "custom/zh-CN/team.json", { title: "自定义" });
  write("user", "plain/team.json", { title: "独立", language: "zh-CN" });
  write("user", "default/team.json", { title: "Default" });
  write("user", "en/old/team.json", { title: "Old" });
  const cat = catalog("zh-CN", roots);
  assert.deepEqual(cat.problems, []);
  assert.equal(cat.teams.get("base")!.title, "基础");
  assert.equal(cat.teams.get("custom")!.title, "自定义");
  assert.equal(cat.teams.get("plain")!.language, "zh-CN");
  assert.equal(cat.teams.get("default")!.language, "en");
  assert.equal(cat.teams.get("old")!.language, "en");
  assert.equal(catalog("en", roots).teams.get("custom")!.title, "Custom");
});

test("modern translations win over duplicate legacy copies and report their path", (t) => {
  const { roots, write } = fixture(t);
  write("user", "custom/en/team.json", { title: "Modern" });
  write("user", "en/custom/team.json", { title: "Legacy" });
  write("user", "custom/zh-CN/team.json", { title: "新" });
  const cat = catalog("en", roots);
  assert.equal(cat.teams.get("custom")!.title, "Modern");
  assert.equal(cat.problems[0].code, "team_duplicate");
  assert.equal(cat.problems[0].path, path.join(roots[1].dir, "en/custom"));
  write("user", "custom/en/team.json", "{");
  assert.ok(!catalog("en", roots).teams.has("custom"), "a broken selected copy must not silently fall back");
});

test("malformed manifests are isolated, including unsafe role ids and nested metadata", (t) => {
  const { roots, write } = fixture(t);
  const invalid = [
    null, [], { title: "" }, { title: "Bad", description: 1 },
    { title: "Bad", roles: [null] }, { title: "Bad", roles: [{ role: "../outside" }] },
    { title: "Bad", roles: [{ role: "poet" }, { role: "poet" }] },
    { title: "Bad", roles: [{ role: "poet", requires: [{}] }] },
    { title: "Bad", roles: [{ role: "poet", name: {} }] },
    { title: "Bad", extends: "../outside" }, { title: "Bad", assets: [] },
    { title: "Bad", assets: { poem: 1 } }, { title: "Bad", language: "xx" },
  ];
  invalid.forEach((manifest, i) => write("user", `bad-${i}/team.json`, manifest));
  write("user", "mismatch/en/team.json", { title: "Bad", language: "zh-CN" });
  write("user", "broken/team.json", "{");
  write("user", "Bad-ID/team.json", { title: "Bad" });
  write("user", "valid/team.json", { title: "Valid", futureMetadata: { version: 1 } });
  const cat = catalog("en", roots);
  assert.deepEqual([...cat.teams.keys()], ["valid"]);
  assert.equal(cat.problems.filter((p) => p.code === "team_json_invalid").length, invalid.length + 2);
  assert.ok(cat.problems.some((p) => p.code === "team_id_invalid"));
});

test("an unreadable root is reported without losing other sources", (t) => {
  const { dir, roots, write } = fixture(t);
  write("user", "valid/team.json", { title: "Valid" });
  fs.writeFileSync(path.join(dir, "file"), "not a directory");
  const cat = catalog("en", [{ source: "builtin", dir: path.join(dir, "file") }, roots[1]]);
  assert.ok(cat.teams.has("valid"));
  assert.equal(cat.problems[0].code, "preset_directory_unreadable");
});

test("inheritance merges role instructions, servers and skills and reads edits and removal live", (t) => {
  const { roots, write } = fixture(t);
  write("builtin", "base/en/team.json", { title: "Base", roles: [{ role: "poet" }], assets: { poem: "Poem" } });
  write("builtin", "base/en/roles/poet/role.json", { description: "Base poet", mcpServers: { base: { command: "base" } } });
  write("builtin", "base/en/roles/poet/instructions.md", "BASE");
  write("builtin", "base/en/roles/poet/skills/write/SKILL.md", "---\ndescription: write\nproduces: poem\n---\nBASE SKILL");
  write("user", "mine/zh-CN/team.json", { title: "Mine", extends: "base", roles: [{ role: "poet" }] });
  write("user", "mine/zh-CN/roles/poet/role.json", { description: "Mine", mcpServers: { extra: { command: "extra" } } });
  write("user", "mine/zh-CN/roles/poet/instructions.md", "EXTRA");
  write("user", "mine/zh-CN/roles/poet/skills/write/SKILL.md", "---\ndescription: custom\nproduces: poem\n---\nCUSTOM SKILL");
  const cat = catalog("zh-CN", roots);
  const role = teamRole(cat, "mine", "poet")!;
  assert.equal(role.description, "Mine");
  assert.equal(role.instructions, "BASE\n\nEXTRA");
  assert.deepEqual(Object.keys(role.servers), ["base", "extra"]);
  assert.equal(role.skills.length, 1);
  assert.equal(role.skills[0].description, "custom");
  assert.equal(cat.teams.get("mine")!.assets.poem, "Poem");
  write("user", "mine/zh-CN/roles/poet/instructions.md", "EDITED");
  assert.equal(teamRole(cat, "mine", "poet")!.instructions, "BASE\n\nEDITED");
  fs.rmSync(path.join(roots[1].dir, "mine"), { recursive: true });
  assert.ok(!catalog("zh-CN", roots).teams.has("mine"));
});

test("user extensions cannot shadow builtins; missing bases and cycles stay isolated", (t) => {
  const { roots, write } = fixture(t);
  write("builtin", "base/en/team.json", { title: "Builtin" });
  write("user", "base/team.json", { title: "User" });
  write("user", "a/team.json", { title: "A", extends: "b" });
  write("user", "b/team.json", { title: "B", extends: "a" });
  write("user", "orphan/team.json", { title: "Orphan", extends: "absent" });
  const cat = catalog("en", roots);
  assert.deepEqual([...cat.teams.keys()], ["base"]);
  assert.equal(cat.teams.get("base")!.source, "builtin");
  assert.ok(cat.problems.some((p) => p.code === "team_shadows_builtin"));
  assert.ok(cat.problems.some((p) => p.code === "team_extends_cycle"));
  assert.ok(cat.problems.some((p) => p.code === "team_extends_missing"));
});

test("derived teams use XSB_HOME and the team-first layout; project overrides restore the template", (t) => {
  const { dir } = fixture(t);
  const prior = process.env.XSB_HOME;
  process.env.XSB_HOME = path.join(dir, "home");
  t.after(() => { if (prior === undefined) delete process.env.XSB_HOME; else process.env.XSB_HOME = prior; });
  const team = derive(catalog("zh-CN"), "software-mine", "software", "zh-CN");
  assert.equal(team.dir, path.join(process.env.XSB_HOME, "presets/software-mine/zh-CN"));
  assert.equal(catalog("en").teams.get(team.id)!.language, "zh-CN");
  const paths = new Paths(path.join(dir, "project"));
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.config, JSON.stringify({ version: 2, language: "zh-CN", teams: [team.id] }));
  const original = loadRole(paths, "reviewer");
  saveRole(paths, { name: "reviewer", description: "Project reviewer" });
  assert.equal(loadRole(paths, "reviewer").description, "Project reviewer");
  assert.equal(loadRole(paths, "reviewer").instructions, original.instructions);
  fs.rmSync(paths.roleDir("reviewer"), { recursive: true });
  assert.equal(loadRole(paths, "reviewer").description, original.description);
  assert.throws(() => derive(catalog("zh-CN"), "en", "software", "en"));
  fs.mkdirSync(path.join(process.env.XSB_HOME, "presets/broken"));
  assert.throws(() => derive(catalog("en"), "broken", "software", "en"), /exists already/);
});
