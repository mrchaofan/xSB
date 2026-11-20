import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { incrementVersion } from "../../../scripts/release-version.mjs";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-release-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifests = {
    "": { name: "xsb", version: "1.2.3", workspaces: ["packages/*"] },
    "packages/desktop": { name: "@xsb/desktop", version: "1.2.3", dependencies: { "@xsb/hub": "1.2.3", external: "^5.0.0" } },
    "packages/hub": { name: "@xsb/hub", version: "1.2.3", devDependencies: { "@xsb/desktop": "1.2.3" } },
  };
  const files = new Map<string, string>();
  for (const [location, manifest] of Object.entries(manifests)) files.set(path.join(location, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  files.set("package-lock.json", JSON.stringify({
    name: "xsb", version: "1.2.3", lockfileVersion: 3,
    packages: { ...manifests, "node_modules/@xsb/hub": { resolved: "packages/hub", link: true }, "node_modules/external": { version: "5.1.0", integrity: "unchanged" } },
  }, null, 2) + "\n");
  for (const [file, source] of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  return { root, files, read };
}

for (const [bump, version] of [["patch", "1.2.4"], ["minor", "1.3.0"], ["major", "2.0.0"]]) {
  test(`${bump} synchronizes workspace versions, internal pins and lockfile`, (t) => {
    const { root, read } = fixture(t);
    assert.equal(incrementVersion(root, bump), version);
    assert.equal(read("package.json").version, version);
    assert.equal(read("packages/desktop/package.json").version, version);
    assert.equal(read("packages/hub/package.json").version, version);
    assert.equal(read("packages/desktop/package.json").dependencies["@xsb/hub"], version);
    assert.equal(read("packages/hub/package.json").devDependencies["@xsb/desktop"], version);
    assert.equal(read("packages/desktop/package.json").dependencies.external, "^5.0.0");
    const lock = read("package-lock.json");
    assert.equal(lock.version, version);
    for (const location of ["", "packages/desktop", "packages/hub"]) assert.equal(lock.packages[location].version, version);
    assert.equal(lock.packages["packages/desktop"].dependencies["@xsb/hub"], version);
    assert.equal(lock.packages["packages/hub"].devDependencies["@xsb/desktop"], version);
    assert.deepEqual(lock.packages["node_modules/external"], { version: "5.1.0", integrity: "unchanged" });
    assert.deepEqual(lock.packages["node_modules/@xsb/hub"], { resolved: "packages/hub", link: true });
  });
}

test("invalid increment and inconsistent versions fail before any file is written", (t) => {
  const { root, files, read } = fixture(t);
  assert.throws(() => incrementVersion(root, "invalid"), /Invalid version increment/);
  for (const [file, source] of files) assert.equal(fs.readFileSync(path.join(root, file), "utf8"), source);
  const hub = read("packages/hub/package.json");
  hub.version = "1.2.2";
  const changed = JSON.stringify(hub, null, 2) + "\n";
  fs.writeFileSync(path.join(root, "packages/hub/package.json"), changed);
  files.set("packages/hub/package.json", changed);
  assert.throws(() => incrementVersion(root), /Version mismatch/);
  for (const [file, source] of files) assert.equal(fs.readFileSync(path.join(root, file), "utf8"), source);
});

test("an out-of-sync internal dependency is rejected without partial writes", (t) => {
  const { root, read, files } = fixture(t);
  const lock = read("package-lock.json");
  lock.packages["packages/desktop"].dependencies["@xsb/hub"] = "1.2.2";
  const changed = JSON.stringify(lock, null, 2) + "\n";
  fs.writeFileSync(path.join(root, "package-lock.json"), changed);
  files.set("package-lock.json", changed);
  assert.throws(() => incrementVersion(root), /Internal dependency mismatch/);
  for (const [file, source] of files) assert.equal(fs.readFileSync(path.join(root, file), "utf8"), source);
});
