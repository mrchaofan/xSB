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
  for (const name of ["page.html", "styles.css"]) fs.copyFileSync(renderer(name), path.join(directory, name));
  await build({ input: renderer("page-window.js"), platform: "browser", output: { file: path.join(directory, "page-window.js"), format: "iife" } });
  await build({ input: renderer("webview.js"), platform: "browser", output: { file: path.join(directory, "webview.js"), format: "esm" } });
  await build({ input: fileURLToPath(new URL("browser-native.electron.ts", import.meta.url)), platform: "node", external: ["electron"], output: { file, format: "cjs" } });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [file, directory], { env, stdio: "inherit" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  const code = await new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  clearTimeout(timer);
  if (code !== 0) throw new Error(`native browser smoke test failed (exit ${code})`);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
