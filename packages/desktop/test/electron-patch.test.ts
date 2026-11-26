import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";
import { patchElectron } from "../scripts/patch-electron.mjs";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const original = 'module.exports = "original";\n';
const patched = 'module.exports = "patched";\n';
const patchText = `diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1 +1 @@
-module.exports = "original";
+module.exports = "patched";
diff --git a/mirror-config.js b/mirror-config.js
new file mode 100644
--- /dev/null
+++ b/mirror-config.js
@@ -0,0 +1 @@
+module.exports = { mirror: "private" };
`;
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-electron-patch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture(root) {
  const dir = path.join(root, "packages/desktop/node_modules/electron");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.js"), original);
  const patch = path.join(root, "electron.patch");
  fs.writeFileSync(patch, patchText);
  return { dir, patch };
}

test("the pinned Electron has no dependency install hook ahead of our patch", () => {
  const require = createRequire(import.meta.url);
  const electron = require("electron/package.json");
  const declared = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8")).devDependencies.electron;
  assert.equal(electron.version, declared);
  for (const hook of ["preinstall", "install", "postinstall"]) {
    assert.equal(electron.scripts?.[hook], undefined, `Electron must not download through ${hook} before the project's patch`);
  }
  const dir = path.dirname(require.resolve("electron/package.json"));
  assert.ok(fs.existsSync(path.join(dir, "mirror-config.js")), "npm postinstall must patch the installed Electron before tests start");
  assert.equal(patchElectron(dir, path.join(desktop, `patches/electron@${declared}.patch`)), false);
});

test("the downloader patch applies and verifies inside Git repositories, linked worktrees and extracted sources", (t) => {
  const root = temp(t);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init");
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  git("add", ".gitignore");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture");
  const worktree = path.join(root, "linked");
  git("worktree", "add", "--detach", worktree, "HEAD");
  for (const location of [root, worktree, temp(t)]) {
    const { dir, patch } = fixture(location);
    assert.equal(patchElectron(dir, patch), true);
    assert.equal(fs.readFileSync(path.join(dir, "index.js"), "utf8"), patched);
    assert.ok(fs.existsSync(path.join(dir, "mirror-config.js")));
    assert.equal(patchElectron(dir, patch), false);
    fs.writeFileSync(path.join(dir, "index.js"), original);
    assert.throws(() => patchElectron(dir, patch), /verification failed/);
  }
});

test("Windows CRLF patch checkouts apply to the LF files extracted by npm", (t) => {
  const root = temp(t);
  execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["config", "core.autocrlf", "true"], { cwd: root, stdio: "pipe" });
  const { dir, patch } = fixture(root);
  fs.writeFileSync(patch, patchText.replace(/\n/g, "\r\n"));
  assert.equal(patchElectron(dir, patch), true);
  assert.equal(fs.readFileSync(path.join(dir, "index.js"), "utf8"), patched);
  assert.equal(patchElectron(dir, patch), false);
});

test("npm install and npm ci run the root and desktop postinstall hooks and leave the downloader patched", (t) => {
  const root = temp(t);
  const app = path.join(root, "packages/desktop");
  const vendor = path.join(root, "vendor/electron");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(app, "patches"), { recursive: true });
  fs.mkdirSync(vendor, { recursive: true });
  const rootScript = JSON.parse(fs.readFileSync(path.join(desktop, "../../package.json"), "utf8")).scripts.postinstall;
  const desktopScript = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8")).scripts.postinstall;
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "patch-fixture", private: true, workspaces: ["packages/*"], scripts: { postinstall: rootScript },
  }));
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({
    name: "desktop-fixture", version: "1.0.0", private: true, type: "module", scripts: { postinstall: desktopScript },
    devDependencies: { electron: "file:../../vendor/electron" },
  }));
  fs.writeFileSync(path.join(vendor, "package.json"), JSON.stringify({ name: "electron", version: "1.0.0", main: "index.js" }));
  fs.copyFileSync(path.join(desktop, "scripts/patch-electron.mjs"), path.join(app, "scripts/patch-electron.mjs"));
  fs.writeFileSync(path.join(app, "patches/electron@1.0.0.patch"), patchText);
  execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  for (const command of ["install", "ci"]) {
    // A local file dependency is linked: restore its unpatched contents before each fresh installation.
    fs.writeFileSync(path.join(vendor, "index.js"), original);
    fs.rmSync(path.join(vendor, "mirror-config.js"), { force: true });
    const output = execFileSync("npm", [command, "--offline", "--no-audit", "--no-fund", "--foreground-scripts", "--ignore-scripts=false"], {
      cwd: root, encoding: "utf8", timeout: 30000,
      env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" },
    });
    assert.ok(output.includes(`> ${rootScript}`), `${command} runs the root hook`);
    assert.ok(output.includes(`> ${desktopScript}`), `${command} runs the desktop hook`);
    assert.equal(fs.readFileSync(path.join(vendor, "index.js"), "utf8"), patched);
    assert.ok(output.includes("downloader patch applied"));
    assert.ok(output.includes("downloader patch verified"));
  }
});
