// Plugins: tool servers as folders in three places of the same layout, each an npm package (src/plugins.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hub } from "../src/hub.ts";
import { Paths } from "../src/paths.ts";
import { initProject } from "../src/config.ts";
import { PLUGINS_ENV, activePlugins, approvePlugin, listPlugins, setPluginEnabled } from "../src/plugins.ts";

function setup(t: test.TestContext) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xsb-plugins-")));
  const saved = { home: process.env.XSB_HOME, plugins: process.env[PLUGINS_ENV] };
  process.env.XSB_HOME = path.join(dir, "home");
  process.env[PLUGINS_ENV] = path.join(dir, "app-plugins");
  const paths = new Paths(path.join(dir, "project"));
  fs.mkdirSync(paths.dir, { recursive: true });
  initProject(paths);
  t.after(() => {
    for (const [key, value] of [["XSB_HOME", saved.home], [PLUGINS_ENV, saved.plugins]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const roots = { builtin: process.env[PLUGINS_ENV]!, global: path.join(process.env.XSB_HOME, "plugins"), project: path.join(paths.dir, "plugins") };
  /**
   * Put a plugin folder in a place: `pkg` is its package.json (a string is written as it is; null, none), and
   * `files` the other files, by default the main file it names (or index.js).
   */
  const put = (scope: keyof typeof roots, name: string, pkg: object | string | null, files?: Record<string, string>) => {
    const folder = path.join(roots[scope], name);
    fs.mkdirSync(folder, { recursive: true });
    if (pkg !== null) fs.writeFileSync(path.join(folder, "package.json"), typeof pkg === "string" ? pkg : JSON.stringify(pkg));
    const main = typeof pkg === "object" && pkg && typeof (pkg as any).main === "string" ? (pkg as any).main : "index.js";
    for (const [file, text] of Object.entries(files ?? { [main]: "// server" })) {
      fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
      fs.writeFileSync(path.join(folder, file), text);
    }
    return folder;
  };
  return { paths, roots, put };
}
const active = (paths: Paths) => activePlugins(paths).map((p) => p.server.name);
const node = { name: "ELECTRON_RUN_AS_NODE", value: "1" };

test("a plugin is an npm package: its main file runs on the app's Node, its xsb.env filled in", (t) => {
  const { paths, put } = setup(t);
  const browser = put("builtin", "browser", { name: "@xsb/plugin-browser", description: "the side panel browser", main: "dist/server.mjs",
    xsb: { env: { SOCKET: "${env:XSB_TEST_SOCKET}", HERE: "${pluginDir}" } } });
  const plain = put("global", "plain", { name: "plain-mcp" });
  process.env.XSB_TEST_SOCKET = "/tmp/browser.sock";
  t.after(() => delete process.env.XSB_TEST_SOCKET);
  const servers = Object.fromEntries(activePlugins(paths).map((p) => [p.server.name, p]));
  assert.deepEqual(servers.browser.server, { type: "stdio", name: "browser", command: process.execPath, args: [path.join(browser, "dist/server.mjs")],
    env: [node, { name: "SOCKET", value: "/tmp/browser.sock" }, { name: "HERE", value: browser }] });
  assert.equal(servers.browser.about, "the side panel browser");
  assert.deepEqual(servers.plain.server, { type: "stdio", name: "plain", command: process.execPath, args: [path.join(plain, "index.js")], env: [node] },
    "without main, npm's index.js");
  const view = listPlugins(paths).find((v) => v.name === "browser")!;
  assert.equal(view.runs, "SOCKET=${env:XSB_TEST_SOCKET} HERE=${pluginDir} node dist/server.mjs", "what it starts is shown, its variables too");
});

test("the three places have one layout; a later place replaces a plugin of the same name", (t) => {
  const { paths, put } = setup(t);
  put("builtin", "browser", { main: "server.mjs" });
  put("global", "search", { description: "web search" });
  put("project", "search", { main: "local.js" });
  assert.deepEqual(active(paths), ["browser"], "the project's plugin waits for approval; the machine's one it replaces is out");
  approvePlugin(paths, "search");
  assert.deepEqual(active(paths), ["browser", "search"]);
  const search = activePlugins(paths).find((p) => p.server.name === "search")!.server as any;
  assert.deepEqual(search.args, [path.join(paths.dir, "plugins", "search", "local.js")]);
  assert.equal(listPlugins(paths).find((v) => v.scope === "global" && v.name === "search")!.replaced, true);
});

test("turned off on this machine or in the project; a project plugin changed after approval, package or main file, waits again", (t) => {
  const { paths, put } = setup(t);
  put("builtin", "media", {});
  put("global", "docs", {});
  setPluginEnabled("project", "media", false, paths);
  assert.deepEqual(active(paths), ["docs"]);
  setPluginEnabled("project", "media", true, paths);
  setPluginEnabled("global", "docs", false);
  assert.deepEqual(active(paths), ["media"]);
  const folder = put("project", "render", { main: "render.js" });
  approvePlugin(paths, "render");
  assert.ok(active(paths).includes("render"));
  fs.writeFileSync(path.join(folder, "render.js"), "// changed code");
  assert.ok(!active(paths).includes("render"), "the main file it runs is part of what was approved");
  approvePlugin(paths, "render");
  assert.ok(active(paths).includes("render"));
  fs.writeFileSync(path.join(folder, "package.json"), JSON.stringify({ main: "render.js", xsb: { env: { A: "b" } } }));
  assert.ok(!active(paths).includes("render"));
});

test("nothing it finds breaks it: missing folders, broken plugins and config files are skipped and told", (t) => {
  const { paths, roots, put } = setup(t);
  fs.rmSync(roots.builtin, { recursive: true, force: true });
  assert.deepEqual(listPlugins(paths), [], "no folders, no plugins");
  put("global", "good", { main: "server.js" });
  put("global", "empty", null, {});
  put("global", "broken", "{ not json", {});
  put("global", "nomain", { main: "missing.js" }, {});
  put("global", "noindex", {}, {});
  put("global", "outside", { main: "../good/server.js" }, {});
  put("global", "badmain", { main: 5 }, {});
  put("global", "badenv", { xsb: { env: { A: 1 } } });
  put("global", "workflow", {});
  const linked = put("global", "linked", { main: "server.js" }, {});
  fs.symlinkSync(path.join(roots.global, "good", "server.js"), path.join(linked, "server.js"));
  fs.writeFileSync(path.join(roots.global, "a-file.json"), "{}");
  const problems = Object.fromEntries(listPlugins(paths).map((v) => [v.name, v.problem ?? null]));
  assert.deepEqual(problems, { badenv: "bad_field", badmain: "no_main", broken: "bad_json", empty: "no_manifest", good: null, linked: "no_main",
    noindex: "no_main", nomain: "no_main", outside: "no_main", workflow: "bad_name" });
  assert.deepEqual(active(paths), ["good"]);
  fs.writeFileSync(path.join(process.env.XSB_HOME!, "config.json"), "{ broken");
  assert.deepEqual(active(paths), ["good"], "an unreadable config file turns nothing off");
  fs.writeFileSync(path.join(process.env.XSB_HOME!, "config.json"), JSON.stringify({ version: 1, approvedPlugins: 5, plugins: null }));
  assert.deepEqual(active(paths), ["good"], "nor does one of the wrong shape");
  fs.rmSync(roots.global, { recursive: true, force: true });
  assert.deepEqual(active(paths), [], "a deleted folder is no plugin, and no error");
});

test("conversations get the active plugins in name order; only a change restarts their backend", (t) => {
  const { paths, put } = setup(t);
  put("global", "zeta", { description: "zeta tools" });
  put("global", "alpha", {});
  const hub = new Hub(paths.project);
  const session = hub.createConversation("claude", "talk");
  const agent = hub.agent(session.agentId);
  assert.deepEqual(hub.toolServers(agent).map((t) => t.server.name), ["alpha", "zeta"]);
  assert.match(hub.systemPromptFor(agent), /zeta — zeta tools/);
  const stopped: string[] = [];
  (hub as any).backends = { stop: (id: string) => stopped.push(id) };
  session.toolsKey = hub.toolsKeyFor(session);
  put("global", "unused", { main: "nothing.js" }, {});
  setPluginEnabled("global", "nothing-there", false);
  hub.applyTools();
  assert.deepEqual(stopped, [], "the same tools and prompt: left alone, its prompt cache with it");
  put("global", "beta", {});
  hub.applyTools();
  assert.deepEqual(stopped, [session.agentId]);
});
