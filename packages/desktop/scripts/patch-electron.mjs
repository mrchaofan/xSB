// Applies patches/electron@<version>.patch to node_modules/electron after every install.
//
// The app runs on a private Electron build (it has <webview2>). The npm package is the
// official one; the patch teaches its installer to download the binary from the mirror
// that ../.electron.mirror.mjs names, instead of the official release.
// npm has no patches of its own, hence this script (this package's postinstall).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const manifest = createRequire(import.meta.url).resolve("electron/package.json");
const dir = fileURLToPath(new URL(".", `file://${manifest}`));
const { version } = JSON.parse(fs.readFileSync(manifest, "utf8"));
const patch = fileURLToPath(new URL(`../patches/electron@${version}.patch`, import.meta.url));

if (!fs.existsSync(patch)) throw new Error(`electron ${version} is installed, and there is no ${patch}. The patch is made for one exact version: pin that one in package.json.`);
// The patch adds this file; with it there, the patch is already applied.
if (!fs.existsSync(`${dir}mirror-config.js`)) {
  execFileSync("git", ["apply", "--whitespace=nowarn", patch], { cwd: dir, stdio: "inherit" });
  console.log(`patched electron ${version}: its binary is downloaded from the mirror in .electron.mirror.mjs`);
}
