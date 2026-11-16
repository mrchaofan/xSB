// Packs the app into dist/, one bundle per program that runs:
//
//   dist/app/main.js          Electron's main process (with the hub's client side)
//   dist/app/preload.cjs      the sandboxed preload
//   dist/bin/xsb-hub          the hub daemon, started by main as a process of its own
//   dist/bin/xsb-mcp-bridge   the MCP bridge, started by the hub for each backend session
//   dist/bin/claude-agent-acp, codex-acp   the ACP wrappers of the agents that do not speak ACP themselves
//   dist/bin/xsb-media-mcp    the image and video generation MCP server, for roles to use
//   dist/bin/xsb-browser-mcp  the way for a role's agents to the browser in the side panel (src/browser.ts)
//   dist/presets/             the preset teams of @xsb/hub, copied as they are: the hub finds them next to its code
//   dist/renderer/            the pages, served as app://xsb/…
//
// The layout repeats the sources': code in one directory finds the pages in
// ../renderer and the hub's two programs in ../bin (see daemon.ts and mcp.ts in @xsb/hub).
import fs from "node:fs";
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

/** The pages' files that are not code: copied as they are. mock.js is only loaded outside Electron. */
const pages = {
  name: "pages",
  generateBundle() {
    for (const fileName of ["index.html", "page.html", "styles.css", "mock.js"]) {
      this.emitFile({ type: "asset", fileName, source: fs.readFileSync(`renderer/${fileName}`) });
    }
  },
};

/** The preset teams are files the hub reads at run time (teams.ts in @xsb/hub). */
const presets = {
  name: "presets",
  writeBundle() {
    fs.rmSync("dist/presets", { recursive: true, force: true });
    fs.cpSync("../hub/presets", "dist/presets", { recursive: true });
  },
};

export default defineConfig([
  { ...node, input: "src/main.ts", output: { file: "dist/app/main.js", format: "esm", codeSplitting: false }, plugins: [presets] },
  { ...node, input: "src/preload.cjs", output: { file: "dist/app/preload.cjs", format: "cjs" } },
  program("xsb-hub", "../hub/bin/xsb-hub"),
  program("xsb-mcp-bridge", "../hub/bin/xsb-mcp-bridge"),
  program("claude-agent-acp", wrapper("claude-agent-acp")),
  program("codex-acp", wrapper("codex-acp")),
  program("xsb-media-mcp", "../media-mcp/bin/xsb-media-mcp"),
  program("xsb-browser-mcp", "src/browser-mcp.ts"),
  { platform: "browser", input: "renderer/main.js", output: { dir: "dist/renderer", format: "iife", entryFileNames: "main.js" }, plugins: [pages] },
  // The page of a web page's own window.
  { platform: "browser", input: "renderer/page-window.js", output: { dir: "dist/renderer", format: "iife", entryFileNames: "page-window.js" } },
]);
