// Isolated real-Electron smoke test. No production workspace, profile or network is used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "rolldown";

const require = createRequire(import.meta.url);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-native-browser-"));
const file = path.join(directory, "main.cjs");
try {
  // The app's own page window, and the module that shows a page, as the app runs them.
  const renderer = (name) => fileURLToPath(new URL("../renderer/" + name, import.meta.url));
  for (const name of ["page.html", "overlay.html", "annotation.html", "styles.css"]) fs.copyFileSync(renderer(name), path.join(directory, name));
  for (const name of ["page-window.js", "overlay.js", "annotation.js"]) {
    await build({ input: renderer(name), platform: "browser", output: { file: path.join(directory, name), format: "iife" } });
  }
  await build({ input: renderer("page-slot.js"), platform: "browser", output: { file: path.join(directory, "page-slot.js"), format: "esm" } });
  await build({ input: Object.fromEntries(["content", "drafts", "web-annotation"].map(name => [name, renderer(name + ".js")])),
    platform: "browser", output: { dir: directory, format: "esm", entryFileNames: "[name].js" } });
  // Exercise the real tab/focus routing with only unrelated app state and panels stubbed.
  const panelStubs = {
    "./app.js": `export const state = window.auditState; export const rootSession = () => 'sa'; export const rememberPosition = () => {}; export const renderArtifact = () => {}; export const revealArtifacts = () => {};`,
    "./workflow.js": `export const currentFlow = () => null; export const renderWorkflow = () => {};`,
    "./artifacts.js": `export const artifactLabel = () => '';`,
    "./file-icons.js": `export const fileIcon = () => null;`,
    "./menu.js": `export const openContextMenu = () => {};`,
  };
  await build({ input: renderer("pages.js"), platform: "browser", plugins: [{
    name: "tab-panel-fixture",
    resolveId(source, importer) { if (importer === renderer("pages.js") && panelStubs[source]) return `\0${source}`; },
    load(id) { if (id.startsWith("\0")) return panelStubs[id.slice(1)]; },
  }], output: { file: path.join(directory, "pages-audit.js"), format: "esm" } });
  await build({ input: fileURLToPath(new URL("browser-native.electron.ts", import.meta.url)), platform: "node", external: ["electron"], output: { file, format: "cjs" } });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // The user-only composer fixture runs without the agent driver's windows, page registry or debugger handles.
  const args = process.argv.slice(2);
  for (const flags of args.length ? [args] : [[], ["--annotations-only"]]) {
    const passed = path.join(directory, "passed");
    fs.rmSync(passed, { force: true });
    const child = spawn(require("electron"), [file, directory, ...flags], { env, stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
    const code = await new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    clearTimeout(timer);
    if (code !== 0) throw new Error(`native browser smoke test failed (exit ${code})`);
    if (!fs.existsSync(passed)) throw new Error("native browser smoke test exited before completing its assertions");
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
