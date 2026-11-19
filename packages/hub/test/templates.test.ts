import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { catalog, teamRole } from "../src/presets.ts";
import { Paths } from "../src/paths.ts";
import { loadRole, saveRole } from "../src/roles.ts";
import { copyTemplate, planSync, projectCatalog, snapshot, syncTemplate } from "../src/templates.ts";

function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-template-copy-"));
  const prior = process.env.XSB_HOME;
  process.env.XSB_HOME = path.join(dir, "home");
  t.after(() => {
    if (prior === undefined) delete process.env.XSB_HOME; else process.env.XSB_HOME = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const root = path.join(process.env.XSB_HOME, "presets");
  const write = (file: string, body: unknown) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof body === "string" ? body : JSON.stringify(body));
  };
  const paths = new Paths(path.join(dir, "project"));
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.config, '{"version":2,"language":"en","teams":["writers"]}');
  write("writers/en/team.json", { title: "Writers", roles: [{ role: "poet", name: "Poet" }] });
  write("writers/en/roles/poet/role.json", { description: "original", mcpServers: { tools: { command: "original-tool" } } });
  write("writers/en/roles/poet/instructions.md", "ORIGINAL");
  write("writers/en/roles/poet/skills/write/SKILL.md", "---\ndescription: write\n---\nORIGINAL SKILL");
  write("writers/en/roles/poet/skills/write/example.txt", "ORIGINAL RESOURCE");
  return { paths, root, write };
}

test("first use materializes a copy; source changes, deletion, and repeated use leave it intact", (t) => {
  const { paths, root, write } = fixture(t);
  copyTemplate(paths, catalog("en"), "writers");
  const role = loadRole(paths, "poet");
  assert.equal(role.dir, path.join(paths.templates, "writers/roles/poet"));
  assert.equal(role.instructions, "ORIGINAL");
  write("writers/en/roles/poet/instructions.md", "SOURCE UPDATE");
  write("writers/en/roles/poet/skills/write/example.txt", "SOURCE RESOURCE UPDATE");
  assert.equal(loadRole(paths, "poet").instructions, "ORIGINAL");
  assert.equal(fs.readFileSync(path.join(role.skills[0].dir, "example.txt"), "utf8"), "ORIGINAL RESOURCE");
  copyTemplate(paths, catalog("en"), "writers");
  assert.equal(loadRole(paths, "poet").instructions, "ORIGINAL");
  fs.rmSync(path.join(root, "writers"), { recursive: true });
  assert.equal(loadRole(paths, "poet").instructions, "ORIGINAL");
  assert.throws(() => planSync(paths, "writers"), /unavailable/);
});

test("inheritance is frozen together, without later reads from the base template", (t) => {
  const { paths, root, write } = fixture(t);
  write("writers/en/team.json", { title: "Writers", extends: "software", roles: [{ role: "reviewer", name: "Reviewer" }] });
  write("writers/en/roles/reviewer/role.json", { description: "Custom reviewer" });
  write("writers/en/roles/reviewer/instructions.md", "EXTRA");
  const before = teamRole(catalog("en"), "writers", "reviewer")!;
  copyTemplate(paths, catalog("en"), "writers");
  fs.rmSync(path.join(root, "writers"), { recursive: true });
  const copied = loadRole(paths, "reviewer");
  assert.equal(copied.instructions, before.instructions);
  assert.ok(copied.instructions.endsWith("EXTRA"));
  assert.ok(copied.skills.every((skill) => skill.dir.startsWith(paths.templates)));
  assert.equal(copied.layers, undefined);
});

test("preview is read-only; synchronization requires confirmation and replaces matched project edits", (t) => {
  const { paths, write } = fixture(t);
  copyTemplate(paths, catalog("en"), "writers");
  saveRole(paths, { name: "poet", instructions: "CUSTOM", mcpServers: { custom: { command: "custom-tool" } }, skills: [{ name: "custom", content: "CUSTOM SKILL" }] });
  saveRole(paths, { name: "independent", instructions: "KEEP THIS" });
  write("writers/en/roles/poet/instructions.md", "UPDATED");
  write("writers/en/roles/poet/role.json", { mcpServers: { replacement: { command: "new-tool" } } });
  const plan = planSync(paths, "writers");
  assert.deepEqual(plan.overwritten, ["poet"]);
  assert.equal(loadRole(paths, "poet").instructions, "CUSTOM");
  assert.throws(() => syncTemplate(paths, "writers", plan.revision, false), /explicit confirmation/);
  syncTemplate(paths, "writers", plan.revision, true);
  const updated = loadRole(paths, "poet");
  assert.equal(updated.instructions, "UPDATED");
  assert.deepEqual(Object.keys(updated.servers), ["replacement"]);
  assert.deepEqual(updated.skills.map((s) => s.name), ["write"]);
  assert.equal(loadRole(paths, "independent").instructions, "KEEP THIS");
  assert.ok(!fs.existsSync(paths.roleDir("poet")));
});

test("a preview cannot authorize newer source files or subsequent project edits", (t) => {
  const { paths, write } = fixture(t);
  copyTemplate(paths, catalog("en"), "writers");
  const sourcePlan = planSync(paths, "writers");
  write("writers/en/roles/poet/skills/write/example.txt", "CHANGED RESOURCE");
  assert.throws(() => syncTemplate(paths, "writers", sourcePlan.revision, true), /changed since preview/);
  const projectPlan = planSync(paths, "writers");
  fs.writeFileSync(path.join(paths.templates, "writers/roles/poet/instructions.md"), "NEW CUSTOM EDIT");
  assert.throws(() => syncTemplate(paths, "writers", projectPlan.revision, true), /changed since preview/);
  assert.equal(loadRole(paths, "poet").instructions, "NEW CUSTOM EDIT");
});

test("complete replacement removes old skill files and retired template roles", (t) => {
  const { paths, root, write } = fixture(t);
  copyTemplate(paths, catalog("en"), "writers");
  fs.rmSync(path.join(root, "writers/en/roles/poet/skills"), { recursive: true });
  write("writers/en/roles/editor/role.json", {});
  write("writers/en/roles/editor/instructions.md", "EDIT");
  write("writers/en/team.json", { title: "Writers", roles: [{ role: "editor", name: "Editor" }] });
  fs.rmSync(path.join(root, "writers/en/roles/poet"), { recursive: true });
  const plan = planSync(paths, "writers");
  assert.deepEqual(plan.removed, ["poet"]);
  syncTemplate(paths, "writers", plan.revision, true);
  assert.ok(!fs.existsSync(path.join(paths.templates, "writers/roles/poet")));
  assert.equal(loadRole(paths, "editor").instructions, "EDIT");
});

test("failed installation restores both the previous snapshot and project overrides", (t) => {
  const { paths, write } = fixture(t);
  copyTemplate(paths, catalog("en"), "writers");
  saveRole(paths, { name: "poet", instructions: "CUSTOM" });
  write("writers/en/roles/poet/instructions.md", "UPDATED");
  const plan = planSync(paths, "writers");
  const rename = fs.renameSync;
  fs.renameSync = ((from, to) => {
    if (String(from).includes(".staged-") && String(to) === path.join(paths.templates, "writers")) throw new Error("simulated disk error");
    return rename(from, to);
  }) as typeof fs.renameSync;
  try { assert.throws(() => syncTemplate(paths, "writers", plan.revision, true), /simulated disk error/); }
  finally { fs.renameSync = rename; }
  assert.equal(loadRole(paths, "poet").instructions, "CUSTOM");
  assert.equal(teamRole(projectCatalog(paths), "writers", "poet")!.instructions, "ORIGINAL");
  assert.ok(!fs.readdirSync(paths.templates).some((name) => name.startsWith(".")));
});

test("broken snapshots never fall back to live templates; directory renames do not change origin", (t) => {
  const { paths, root } = fixture(t);
  copyTemplate(paths, catalog("en"), "writers");
  fs.renameSync(path.join(root, "writers"), path.join(root, "renamed"));
  assert.throws(() => planSync(paths, "writers"), /unavailable/);
  assert.equal(snapshot(paths, "writers")!.id, "writers");
  fs.writeFileSync(path.join(paths.templates, "writers/team.json"), "{");
  const cat = projectCatalog(paths);
  assert.ok(!cat.teams.has("writers"));
  assert.equal(cat.problems.find((p) => p.code === "template_snapshot_invalid")!.team, "writers");
});

test("parent team folders distinguish equal role names; independent project roles keep their origin", (t) => {
  const { paths, write } = fixture(t);
  // Created before a template is used: an unrelated role of the same leaf name has a different origin.
  fs.writeFileSync(paths.config, '{"version":2,"language":"en","teams":[]}');
  saveRole(paths, { name: "poet", instructions: "INDEPENDENT POET" });
  copyTemplate(paths, catalog("en"), "writers");
  fs.writeFileSync(paths.config, '{"version":2,"language":"en","teams":["writers"]}');
  write("writers/en/roles/poet/instructions.md", "UPDATED TEMPLATE");
  const plan = planSync(paths, "writers");
  assert.deepEqual(plan.overwritten, []);
  syncTemplate(paths, "writers", plan.revision, true);
  assert.equal(loadRole(paths, "poet").instructions, "INDEPENDENT POET");
  assert.equal(teamRole(projectCatalog(paths), "writers", "poet")!.instructions, "UPDATED TEMPLATE");
  write("others/en/team.json", { title: "Others", roles: [{ role: "poet", name: "Other poet" }] });
  write("others/en/roles/poet/role.json", {});
  write("others/en/roles/poet/instructions.md", "OTHER ORIGIN");
  assert.equal(teamRole(catalog("en"), "others", "poet")!.instructions, "OTHER ORIGIN");
});

test("synchronization refuses new collisions with other project teams", (t) => {
  const { paths, write } = fixture(t);
  copyTemplate(paths, catalog("en"), "writers");
  write("others/en/team.json", { title: "Others", roles: [{ role: "editor", name: "Editor" }] });
  write("others/en/roles/editor/role.json", {});
  copyTemplate(paths, catalog("en"), "others");
  fs.writeFileSync(paths.config, '{"version":2,"language":"en","teams":["writers","others"]}');
  write("writers/en/roles/editor/role.json", {});
  assert.throws(() => planSync(paths, "writers"), /duplicate role "editor"/);
  assert.equal(loadRole(paths, "poet").instructions, "ORIGINAL");
});
