// Packs the app into dist/, one bundle per program that runs:
//
//   dist/app/main.js          Electron's main process (with the hub's client side)
//   dist/app/preload.cjs      the sandboxed preload
//   dist/bin/xsb-hub          the hub daemon, started by main as a process of its own
//   dist/bin/xsb-mcp-bridge   the MCP bridge, started by the hub for each backend session
//   dist/bin/claude-agent-acp, codex-acp   the ACP wrappers of the agents that do not speak ACP themselves
//   dist/plugins/<name>/      the plugins shipped with the app (plugins/<name>/package.json, whose main is server.mjs):
//                             the same layout as a plugin the user adds (the hub's plugins.ts)
//   dist/renderer/            the pages, served as app://xsb/…
//
// The layout repeats the sources': code in one directory finds the pages in
// ../renderer, the hub's two programs in ../bin (see daemon.ts and mcp.ts in @xsb/hub) and the shipped plugins in
// ../plugins: the same in development (packages/desktop/dist) and in the packed app (asar is off).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "rolldown";

const node = { platform: "node", external: ["electron"] };
/** The entry of a wrapper published on npm: what its `bin` names. */
const wrapper = (name) => {
  const manifest = createRequire(import.meta.url).resolve(`@agentclientprotocol/${name}/package.json`);
  return manifest.replace("package.json", JSON.parse(fs.readFileSync(manifest, "utf8")).bin[name]);
};
/** A program started by path: one file, runnable by Node whatever its name. */
const program = (name, entry) => ({
  ...node,
  input: entry,
  output: { file: `dist/bin/${name}`, format: "esm", codeSplitting: false },
});

/** A shipped plugin: an npm package, its folder's package.json, and its server bundled next to it as server.mjs, its main. */
const plugin = (name, entry) => ({
  ...node,
  input: entry,
  output: { file: `dist/plugins/${name}/server.mjs`, format: "esm", codeSplitting: false },
  plugins: [{ name: "manifest", writeBundle: () => {
    fs.copyFileSync(`plugins/${name}/package.json`, `dist/plugins/${name}/package.json`);
    fs.rmSync(`dist/plugins/${name}/plugin.json`, { force: true });
  } }],
});

/** The pages' files that are not code: copied as they are. mock.js is only loaded outside Electron. */
const pages = {
  name: "pages",
  writeBundle() {
    fs.rmSync("dist/presets", { recursive:true,force:true });
    const current = new Set(fs.readdirSync("renderer/avatars"));
    for (const name of fs.readdirSync("dist/renderer/avatars")) {
      if (name.endsWith(".png") && !current.has(name)) fs.unlinkSync(`dist/renderer/avatars/${name}`);
    }
  },
  generateBundle() {
    const avatars = fs.readdirSync("renderer/avatars").filter((name) => name.endsWith(".png")).map((name) => `avatars/${name}`);
    for (const fileName of ["index.html", "page.html", "styles.css", "mock.js", ...avatars]) {
      this.emitFile({ type: "asset", fileName, source: fs.readFileSync(`renderer/${fileName}`) });
    }
  },
};

export default defineConfig([
  { ...node, input: "src/main.ts", output: { file: "dist/app/main.js", format: "esm", codeSplitting: false } },
  { ...node, input: "src/preload.cjs", output: { file: "dist/app/preload.cjs", format: "cjs" } },
  program("xsb-hub", "../hub/bin/xsb-hub"),
  program("xsb-mcp-bridge", "../hub/bin/xsb-mcp-bridge"),
  program("claude-agent-acp", wrapper("claude-agent-acp")),
  program("codex-acp", wrapper("codex-acp")),
  plugin("media", "../media-mcp/bin/xsb-media-mcp"),
  plugin("browser", "src/browser-mcp.ts"),
  { platform: "browser", input: "renderer/main.js", output: { dir: "dist/renderer", format: "iife", entryFileNames: "main.js" }, plugins: [pages] },
  // The page of a web page's own window.
  { platform: "browser", input: "renderer/page-window.js", output: { dir: "dist/renderer", format: "iife", entryFileNames: "page-window.js" } },
]);
