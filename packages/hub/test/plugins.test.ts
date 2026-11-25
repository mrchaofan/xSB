// Plugins: tool servers as folders in three places of the same layout (src/plugins.ts).
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
  /** Put a plugin folder in a place; a string is written as plugin.json as it is. */
  const put = (scope: keyof typeof roots, name: string, manifest: object | string | null) => {
    const folder = path.join(roots[scope], name);
    fs.mkdirSync(folder, { recursive: true });
    if (manifest !== null) fs.writeFileSync(path.join(folder, "plugin.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    return folder;
  };
  return { paths, roots, put };
}
const active = (paths: Paths) => activePlugins(paths).map((p) => p.server.name);

test("the three places have one layout; a later place replaces a plugin of the same name", (t) => {
  const { paths, put } = setup(t);
  const browser = put("builtin", "browser", { description: "the side panel browser", command: "${node}", args: ["${pluginDir}/server.js"], env: { SOCKET: "${env:XSB_TEST_SOCKET}" } });
  put("global", "search", { command: "search-mcp", description: "web search" });
  put("project", "search", { command: "./local-search" });
  process.env.XSB_TEST_SOCKET = "/tmp/browser.sock";
  t.after(() => delete process.env.XSB_TEST_SOCKET);
  assert.deepEqual(active(paths), ["browser"], "the project's plugin waits for approval; the machine's one it replaces is out");
  approvePlugin(paths, "search");
  assert.deepEqual(active(paths), ["browser", "search"]);
  const servers = Object.fromEntries(activePlugins(paths).map((p) => [p.server.name, p.server]));
  assert.deepEqual(servers.browser, { type: "stdio", name: "browser", command: process.execPath, args: [path.join(browser, "server.js")],
    env: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }, { name: "SOCKET", value: "/tmp/browser.sock" }] });
  assert.equal((servers.search as any).command, path.join(paths.dir, "plugins", "search", "local-search"));
  assert.equal(listPlugins(paths).find((v) => v.scope === "global" && v.name === "search")!.replaced, true);
});

test("turned off on this machine or in the project; a project plugin changed after approval waits again", (t) => {
  const { paths, put } = setup(t);
  put("builtin", "media", { command: "media-mcp" });
  put("global", "docs", { type: "http", url: "https://docs.example/mcp" });
  setPluginEnabled("project", "media", false, paths);
  assert.deepEqual(active(paths), ["docs"]);
  setPluginEnabled("project", "media", true, paths);
  setPluginEnabled("global", "docs", false);
  assert.deepEqual(active(paths), ["media"]);
  const folder = put("project", "render", { command: "./render" });
  approvePlugin(paths, "render");
  assert.ok(active(paths).includes("render"));
  fs.writeFileSync(path.join(folder, "plugin.json"), JSON.stringify({ command: "./render", args: ["--other"] }));
  assert.ok(!active(paths).includes("render"));
});

test("nothing it finds breaks it: missing folders, broken plugins and config files are skipped and told", (t) => {
  const { paths, roots, put } = setup(t);
  fs.rmSync(roots.builtin, { recursive: true, force: true });
  assert.deepEqual(listPlugins(paths), [], "no folders, no plugins");
  put("global", "good", { command: "good-mcp" });
  put("global", "empty", null);
  put("global", "broken", "{ not json");
  put("global", "nocommand", { description: "x" });
  put("global", "badurl", { type: "http", url: "file:///etc/passwd" });
  put("global", "workflow", { command: "x" });
  fs.writeFileSync(path.join(roots.global, "a-file.json"), "{}");
  const problems = Object.fromEntries(listPlugins(paths).map((v) => [v.name, v.problem ?? null]));
  assert.deepEqual(problems, { badurl: "bad_url", broken: "bad_json", empty: "no_manifest", good: null, nocommand: "no_command", workflow: "bad_name" });
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
  put("global", "zeta", { command: "z", description: "zeta tools" });
  put("global", "alpha", { command: "a" });
  const hub = new Hub(paths.project);
  const session = hub.createConversation("claude", "talk");
  const agent = hub.agent(session.agentId);
  assert.deepEqual(hub.toolServers(agent).map((t) => t.server.name), ["alpha", "zeta"]);
  assert.match(hub.systemPromptFor(agent), /zeta — zeta tools/);
  const stopped: string[] = [];
  (hub as any).backends = { stop: (id: string) => stopped.push(id) };
  session.toolsKey = hub.toolsKeyFor(session);
  put("global", "unused", { description: "broken: no command" });
  setPluginEnabled("global", "nothing-there", false);
  hub.applyTools();
  assert.deepEqual(stopped, [], "the same tools and prompt: left alone, its prompt cache with it");
  put("global", "beta", { command: "b" });
  hub.applyTools();
  assert.deepEqual(stopped, [session.agentId]);
});
