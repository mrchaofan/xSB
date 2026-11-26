// Applies patches/electron@<version>.patch to node_modules/electron after every install.
//
// The app runs on a private Electron build (it has <webview2>). The npm package is the
// official one; the patch teaches its installer to download the binary from the mirror
// that ../.electron.mirror.mjs names, instead of the official release.
// Both the root and desktop postinstall run this idempotent check after dependency installation.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Apply outside Git's subdirectory filtering, then verify every installed hunk, including on repeat installs. */
export function patchElectron(dir, patch) {
  if (!fs.existsSync(patch)) throw new Error(`No Electron patch at ${patch}. Pin the version supported by patches/.`);
  dir = fs.realpathSync(dir);
  const repository = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" });
  if (repository.error) throw repository.error;
  const cwd = repository.status === 0 ? fs.realpathSync(repository.stdout.trim()) : dir;
  const target = path.relative(cwd, dir).split(path.sep).join("/");
  // Git for Windows can check out the patch as CRLF, while npm's tarball sources retain LF.
  const input = fs.readFileSync(patch, "utf8").replace(/\r\n/g, "\n");
  const apply = (args) => execFileSync("git", ["-c", "core.autocrlf=false", "apply", ...(target ? ["--directory", target] : []), ...args], { cwd, stdio: "pipe", input });
  const alreadyPatched = fs.existsSync(path.join(dir, "mirror-config.js"));
  if (!alreadyPatched) {
    apply(["--check"]);
    apply(["--whitespace=nowarn"]);
  }
  try { apply(["--reverse", "--check"]); }
  catch (cause) { throw new Error(`Electron downloader patch verification failed in ${dir}; reinstall dependencies before running the app.`, { cause }); }
  return !alreadyPatched;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = createRequire(import.meta.url).resolve("electron/package.json");
  const dir = path.dirname(manifest);
  const { version } = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const patch = fileURLToPath(new URL(`../patches/electron@${version}.patch`, import.meta.url));
  const applied = patchElectron(dir, patch);
  console.log(`electron ${version}: downloader patch ${applied ? "applied" : "verified"}`);
}
