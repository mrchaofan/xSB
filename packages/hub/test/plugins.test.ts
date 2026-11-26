// Plugins: folders in three plugin folders of the same layout, each with a `.mcp.json` of its tool servers (src/plugins.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hub } from "../src/hub.ts";
import { Paths } from "../src/paths.ts";
import { initProject } from "../src/config.ts";
import { activePlugins, approvePlugin, listPlugins, pluginRoot, setPluginEnabled } from "../src/plugins.ts";

function setup(t: test.TestContext) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xsb-plugins-")));
  const home = process.env.XSB_HOME;
  process.env.XSB_HOME = path.join(dir, "home");
  const paths = new Paths(path.join(dir, "project"));
  fs.mkdirSync(paths.dir, { recursive: true });
  initProject(paths);
  t.after(() => {
    if (home === undefined) delete process.env.XSB_HOME; else process.env.XSB_HOME = home;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const roots = { global: pluginRoot("global")!, project: pluginRoot("project", paths)! };
  /**
   * Put a plugin folder in a place: `servers` is the `mcpServers` of its `.mcp.json` (a string is the file as it is;
   * null, no file), and `files` its other files.
   */
  const put = (scope: keyof typeof roots, name: string, servers: object | string | null = { [name]: { command: "node", args: ["./index.js"] } }, files: Record<string, string> = { "index.js": "// server" }) => {
    const folder = path.join(roots[scope], name);
    fs.mkdirSync(folder, { recursive: true });
    if (servers !== null) fs.writeFileSync(path.join(folder, ".mcp.json"), typeof servers === "string" ? servers : JSON.stringify({ mcpServers: servers }));
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
      fs.writeFileSync(path.join(folder, file), text);
    }
    return folder;
  };
  return { paths, roots, put };
}
const active = (paths: Paths) => activePlugins(paths).map((p) => p.server.name);
const node = { name: "ELECTRON_RUN_AS_NODE", value: "1" };

test("a plugin's .mcp.json names its servers; nothing in it says where the plugin is", (t) => {
  const { paths, put } = setup(t);
  const tools = put("global", "tools", {
    local: { command: "node", args: ["./dist/server.mjs", "--root", "${CLAUDE_PLUGIN_ROOT}"], env: { SOCKET: "${XSB_TEST_SOCKET}", MODE: "${XSB_TEST_UNSET:-quiet}" } },
    other: { type: "stdio", command: "npx", args: ["-y", "some-mcp"] },
    remote: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer ${XSB_TEST_SOCKET}" } },
  });
  process.env.XSB_TEST_SOCKET = "/tmp/browser.sock";
  t.after(() => delete process.env.XSB_TEST_SOCKET);
  assert.deepEqual(activePlugins(paths).map((p) => p.server), [
    { type: "stdio", name: "local", command: process.execPath, args: [path.join(tools, "dist/server.mjs"), "--root", tools],
      env: [node, { name: "SOCKET", value: "/tmp/browser.sock" }, { name: "MODE", value: "quiet" }] },
    { type: "stdio", name: "other", command: "npx", args: ["-y", "some-mcp"], env: [] },
    { type: "http", name: "remote", url: "https://example.test/mcp", headers: [{ name: "Authorization", value: "Bearer /tmp/browser.sock" }] },
  ], "`node` is the app's Node; ./ and ${CLAUDE_PLUGIN_ROOT} are the plugin's folder; ${NAME} the hub's environment");
  assert.equal(listPlugins(paths).find((v) => v.name === "tools")!.runs,
    "SOCKET=${XSB_TEST_SOCKET} MODE=${XSB_TEST_UNSET:-quiet} node ./dist/server.mjs --root ${CLAUDE_PLUGIN_ROOT}\nnpx -y some-mcp\nhttps://example.test/mcp",
    "what it starts is shown as written");
  put("global", "flat", JSON.stringify({ flat: { command: "uvx", args: ["flat-mcp"] } }));
  assert.ok(active(paths).includes("flat"), "a .mcp.json may be the servers themselves");
});

test("the places have one layout and differ in their folder only; a later place replaces a plugin of the same name", (t) => {
  const { paths, put } = setup(t);
  assert.equal(path.basename(pluginRoot("builtin")!), "plugins", "the app's own are beside its code");
  assert.equal(path.relative(paths.project, pluginRoot("project", paths)!), path.join(".xsb2", "plugins"));
  put("global", "browser");
  put("global", "search");
  put("project", "search", { search: { command: "node", args: ["./local.js"] }, extra: { command: "node", args: ["./local.js"] } }, { "local.js": "" });
  assert.deepEqual(active(paths), ["browser"], "the project's plugin waits for approval; the machine's one it replaces is out");
  approvePlugin(paths, "search");
  assert.deepEqual(active(paths), ["browser", "extra", "search"]);
  const search = activePlugins(paths).find((p) => p.server.name === "search")!.server as any;
  assert.deepEqual(search.args, [path.join(paths.dir, "plugins", "search", "local.js")]);
  assert.equal(listPlugins(paths).find((v) => v.scope === "global" && v.name === "search")!.replaced, true);
  put("project", "zz", { browser: { command: "node", args: ["./index.js"] } });
  approvePlugin(paths, "zz");
  assert.deepEqual((activePlugins(paths).find((p) => p.server.name === "browser")!.server as any).args, [path.join(paths.dir, "plugins", "zz", "index.js")],
    "of two servers of one name, the later plugin's");
});

test("turned off on this machine or in the project; a project plugin changed after approval, .mcp.json or a file it starts, waits again", (t) => {
  const { paths, put } = setup(t);
  put("global", "media");
  put("global", "docs");
  setPluginEnabled("project", "media", false, paths);
  assert.deepEqual(active(paths), ["docs"]);
  setPluginEnabled("project", "media", true, paths);
  setPluginEnabled("global", "docs", false);
  assert.deepEqual(active(paths), ["media"]);
  const folder = put("project", "render", { render: { command: "node", args: ["./render.js"] } }, { "render.js": "" });
  approvePlugin(paths, "render");
  assert.ok(active(paths).includes("render"));
  fs.writeFileSync(path.join(folder, "render.js"), "// changed code");
  assert.ok(!active(paths).includes("render"), "the file it starts is part of what was approved");
  approvePlugin(paths, "render");
  assert.ok(active(paths).includes("render"));
  fs.writeFileSync(path.join(folder, ".mcp.json"), JSON.stringify({ mcpServers: { render: { command: "node", args: ["./render.js"], env: { A: "b" } } } }));
  assert.ok(!active(paths).includes("render"));
});

test("nothing it finds breaks it: missing folders, broken plugins and config files are skipped and told", (t) => {
  const { paths, roots, put } = setup(t);
  assert.deepEqual(listPlugins(paths).filter((v) => v.scope !== "builtin"), [], "no folders, no plugins");
  put("global", "good");
  put("global", "empty", null, {});
  put("global", "broken", "{ not json", {});
  put("global", "list", "[]", {});
  put("global", "nocommand", { nocommand: { args: ["x"] } });
  put("global", "badargs", { badargs: { command: "node", args: [5] } });
  put("global", "badenv", { badenv: { command: "node", env: { A: 1 } } });
  put("global", "badtype", { badtype: { type: "pipe", command: "node" } });
  put("global", "nourl", { nourl: { type: "http" } });
  put("global", "badserver", { "has space": { command: "node" } });
  put("global", "takes", { xsb: { command: "node" } });
  put("global", "workflow");
  fs.writeFileSync(path.join(roots.global, "a-file.json"), "{}");
  const problems = Object.fromEntries(listPlugins(paths).filter((v) => v.scope !== "builtin").map((v) => [v.name, v.problem ?? null]));
  assert.deepEqual(problems, { badargs: "bad_field", badenv: "bad_field", badserver: "bad_name", badtype: "bad_field", broken: "bad_json", empty: "no_manifest",
    good: null, list: "bad_json", nocommand: "bad_field", nourl: "bad_field", takes: "bad_name", workflow: "bad_name" });
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
  put("global", "zeta");
  put("global", "alpha");
  const hub = new Hub(paths.project);
  const session = hub.createConversation("claude", "talk");
  const agent = hub.agent(session.agentId);
  assert.deepEqual(hub.toolServers(agent).map((t) => t.server.name), ["alpha", "zeta"]);
  assert.match(hub.systemPromptFor(agent), /alpha\nzeta/);
  const stopped: string[] = [];
  (hub as any).backends = { stop: (id: string) => stopped.push(id) };
  session.toolsKey = hub.toolsKeyFor(session);
  put("global", "unused", null, {});
  setPluginEnabled("global", "nothing-there", false);
  hub.applyTools();
  assert.deepEqual(stopped, [], "the same tools and prompt: left alone, its prompt cache with it");
  put("global", "beta");
  hub.applyTools();
  assert.deepEqual(stopped, [session.agentId]);
});
