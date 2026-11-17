/**
 * `xsb team eval <team>`: run a team's scenarios against a real backend and say how often each one passes.
 *
 * A scenario is a JSON file in the `evals/` directory of a team (or of a team it extends), one situation in which a
 * role must do the right thing: what it is told, and what it must and must not do. Each run is a project of its own
 * in a temporary directory, so runs do not see each other. What would cost money besides the model is stood in for
 * (eval-stub.ts): the side-panel browser, image and video generation; agents the role works with run on a backend
 * that is not installed, so that work dispatched to them fails at once instead of running.
 *
 *   {
 *     "id": "S9", "title": "...",
 *     "role": "director",                       the role under test
 *     "messages": ["..."],                      what the user says, in order (sent at once: later ones wait their turn)
 *     "peers": ["cinematographer"],             other roles of the team present as agents (not run)
 *     "budget": 100, "spent": 12.5,             the project's budget and what is spent already (optional)
 *     "fixture": "film-basic",                  assets the project starts with: evals/fixtures/<name>.json, a list of
 *                                               { type, name, description, content } (or "file": "png" | "mp4" for a
 *                                               placeholder file); written into the library before the hub starts
 *     "expect": [                               every check must hold
 *       { "firstTool": { "among": "<regex of tool names>", "is": "<regex>" } },
 *       { "calls": "<regex>" }, { "noCalls": "<regex>" }, { "atMost": { "tool": "<regex>", "times": 1 } },
 *       { "says": "<regex>" }, { "saysNot": "<regex>" }
 *     ]
 *   }
 *
 * Tool names are compared without what the agent program puts in front of them, but with their server unless it is
 * xsb's (`bare`); regular expressions are case-insensitive.
 *
 * It runs real models, which costs what the backend's account is charged; the generation tools cost nothing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Paths, catalog, globalConfigPath, initProject, lineage, presetRoots, stopHub } from "@xsb/hub";
import { Agents, Roles } from "@xsb/protocol";
import type { Connection, Language } from "@xsb/protocol";
import { connectHub } from "./client.ts";

const STUB = fileURLToPath(new URL("./eval-stub.ts", import.meta.url));
/** What the desktop app says of its browser to agents (packages/desktop/src/clis.ts); the stand-in is said the same of. */
const BROWSER_ABOUT =
  'It is the browser in the side panel of the xsb app, which the user watches and can take over. When the user says "the browser", "the built-in browser", "the side-panel browser" or "IAB" (浏览器, 内置浏览器, 右栏浏览器), they mean this one: use its tools (browser_navigate first), not a browser or computer-use tool of your agent program, which cannot reach the side panel.';

/** A backend name whose command is not installed: the agents a role works with are there, but do not run. */
const ABSENT = "xsb-eval-absent";

type Check =
  | { firstTool: { among: string; is: string } }
  | { calls: string }
  | { noCalls: string }
  | { atMost: { tool: string; times: number } }
  | { says: string }
  | { saysNot: string };

export type Scenario = { id: string; title: string; role: string; messages: string[]; peers?: string[]; budget?: number; spent?: number; fixture?: string; expect: Check[]; file?: string; fixtures?: string[] };

type FixtureAsset = { type: string; name: string; description: string; content?: string; file?: "png" | "mp4" };

/** Placeholder files: enough for an asset to be one, nothing for a tool to show. */
const PLACEHOLDER: Record<string, Buffer> = {
  png: Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex"),
  mp4: Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"),
};

/** Write a fixture's assets into a project's library, as the hub would have registered them, before it starts. */
function seed(paths: Paths, assets: FixtureAsset[]): void {
  const at = new Date().toISOString();
  for (const a of assets) {
    const dir = path.join(paths.assets, a.type, a.name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, a.file ? `v1.${a.file}` : "v1.md");
    fs.writeFileSync(file, a.file ? PLACEHOLDER[a.file] : (a.content ?? ""));
    const asset = { id: `${a.type}/${a.name}`, type: a.type, name: a.name, version: 1, description: a.description, path: file, by: "user", createdAt: at };
    fs.appendFileSync(path.join(paths.dir, "assets.jsonl"), JSON.stringify({ op: "put", asset }) + "\n");
  }
}

/** What a run left behind: the tools the role called, in order, and everything it said. */
type Seen = { tools: string[]; said: string };

/**
 * A tool's name without what the agent program puts in front of it, but with the server it is of, unless that is
 * xsb's own: `mcp__xsb__dispatch_task` and `mcp.xsb.dispatch_task` are `dispatch_task`, `mcp.cua_repl.js` is
 * `cua_repl.js`, `mcp__browser__browser_navigate` is `browser.browser_navigate`.
 */
const bare = (name: string): string => {
  const mcp = /^mcp(?:__|\.)(.+?)(?:__|\.)(.+)$/.exec(name);
  return !mcp ? name : mcp[1] === "xsb" ? mcp[2] : `${mcp[1]}.${mcp[2]}`;
};
const re = (pattern: string): RegExp => new RegExp(pattern, "i");

/** Whether one check holds of what was seen, and if not, what was seen instead. */
export function judge(check: Check, seen: Seen): string | undefined {
  if ("firstTool" in check) {
    const first = seen.tools.find((tool) => re(check.firstTool.among).test(tool));
    return first && re(check.firstTool.is).test(first) ? undefined : `first of /${check.firstTool.among}/ was ${first ?? "none"}`;
  }
  if ("calls" in check) return seen.tools.some((tool) => re(check.calls).test(tool)) ? undefined : `no call of /${check.calls}/`;
  if ("noCalls" in check) {
    const called = seen.tools.find((tool) => re(check.noCalls).test(tool));
    return called ? `called ${called}` : undefined;
  }
  if ("atMost" in check) {
    const times = seen.tools.filter((tool) => re(check.atMost.tool).test(tool)).length;
    return times <= check.atMost.times ? undefined : `/${check.atMost.tool}/ ${times} times`;
  }
  if ("says" in check) return re(check.says).test(seen.said) ? undefined : `did not say /${check.says}/`;
  return re(check.saysNot).test(seen.said) ? `said /${check.saysNot}/` : undefined;
}

/** The scenarios of a team: its own and those of the teams it extends (a scenario of its own replaces one of the same id). */
export function scenariosOf(language: Language, id: string): Scenario[] {
  const cat = catalog(language);
  if (!cat.teams.has(id)) throw new Error(`no team "${id}"`);
  const found = new Map<string, Scenario>();
  const dirs = lineage(cat, id).reverse().map((team) => path.join(team.dir, "evals"));
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      const scenario = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Scenario;
      // A fixture is looked for in the scenario's own team first, then in the teams it builds on.
      found.set(scenario.id, { ...scenario, file: path.join(dir, name), fixtures: [dir, ...dirs.filter((d) => d !== dir).reverse()].map((d) => path.join(d, "fixtures")) });
    }
  }
  return [...found.values()];
}

/**
 * The machine's settings for the runs: the user's backends and preset teams, plus the backend that is not installed.
 * In a directory of its own, so that the user's ~/.xsb/config.json is left as it is.
 */
function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-eval-home-"));
  const config = fs.existsSync(globalConfigPath()) ? JSON.parse(fs.readFileSync(globalConfigPath(), "utf8")) : { version: 1 };
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ ...config, backends: { ...config.backends, [ABSENT]: { command: ABSENT } } }));
  const presets = presetRoots().find((root) => root.source === "user")!.dir;
  if (fs.existsSync(presets)) fs.symlinkSync(presets, path.join(dir, "presets"));
  return dir;
}

async function until(probe: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await probe()) return true;
    await sleep(500);
  }
  return false;
}

/** One run of one scenario, in a project of its own. */
async function runOnce(scenario: Scenario, team: string, backend: string, language: Language, timeoutMs: number, keep: boolean): Promise<Seen & { dir?: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-eval-"));
  const paths = new Paths(dir);
  initProject(paths);
  fs.writeFileSync(paths.config, JSON.stringify({ version: 2, language, teams: [team] }));
  if (scenario.fixture) {
    const file = (scenario.fixtures ?? []).map((d) => path.join(d, `${scenario.fixture}.json`)).find((f) => fs.existsSync(f));
    if (!file) throw new Error(`no fixture "${scenario.fixture}" for scenario ${scenario.id}`);
    seed(paths, JSON.parse(fs.readFileSync(file, "utf8")));
  }
  if (scenario.budget !== undefined) fs.appendFileSync(paths.spend, JSON.stringify({ op: "budget", at: new Date().toISOString(), amount: scenario.budget }) + "\n");
  // What was spent before, as drafts of a few yuan each (one record of the whole would read as one costly call).
  for (let left = scenario.spent ?? 0, n = 1; left > 0; n++) {
    const amount = Math.min(left, 4.5);
    fs.appendFileSync(paths.spend, JSON.stringify({ op: "spend", at: new Date().toISOString(), tool: "generate_video", output: `earlier-${n}.mp4`, usage: "a 480p draft", amount, basis: "the scenario's" }) + "\n");
    left -= amount;
  }
  let conn: Connection | undefined;
  try {
    conn = await connectHub(paths, true);
    const role = (await conn.request(Roles.get, { name: scenario.role })).role;
    if (role.mcpServers.media) {
      const servers = { ...role.mcpServers, media: { command: process.execPath, args: [STUB, "media"] } };
      await conn.request(Roles.put, { role: { name: scenario.role, mcpServers: servers } });
    }
    for (const peer of scenario.peers ?? []) await conn.request(Agents.put, { agent: { id: peer, role: peer, backend: ABSENT } });
    await conn.request(Agents.put, { agent: { id: scenario.role, role: scenario.role, backend } });
    const { sessionId } = await conn.request("session/new", { cwd: dir, mcpServers: [], _meta: { [Agents.sessionKey]: scenario.role } });
    const sent = scenario.messages.map((message, i) => sleep(i * 300).then(() => conn!.request("session/prompt", { sessionId, prompt: [{ type: "text", text: message }] })));
    await Promise.race([Promise.allSettled(sent), sleep(timeoutMs)]);
    // Done when the role has been idle a while (results of what it dispatched may start more turns).
    const idle = async (): Promise<boolean> => (await conn!.request(Agents.list)).agents.find((a: any) => a.id === scenario.role)?.state === "idle";
    await until(async () => (await idle()) && (await sleep(3000), await idle()), timeoutMs);
    const sessions = path.join(paths.agentDir(scenario.role), "sessions");
    const updates = fs.readdirSync(sessions).flatMap((file) => fs.readFileSync(path.join(sessions, file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).update));
    return {
      ...(keep ? { dir } : {}),
      tools: updates.filter((u) => u?.sessionUpdate === "tool_call").map((u) => bare(String(u._meta?.claudeCode?.toolName ?? u.name ?? u.title ?? ""))),
      said: updates.filter((u) => u?.sessionUpdate === "agent_message_chunk").map((u) => u.content?.text ?? "").join(""),
    };
  } finally {
    conn?.close();
    stopHub(paths, true);
    await sleep(500);
    if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** `dir`: the run's project, kept for a look when asked (`--keep`). */
export type Outcome = { scenario: Scenario; runs: { passed: boolean; failures: string[]; dir?: string }[] };

/** Run every scenario `runs` times; report as each one finishes. */
export async function evaluate(
  scenarios: Scenario[],
  options: { team: string; backend: string; runs: number; language: Language; timeoutMs: number; keep?: boolean },
  report: (outcome: Outcome) => void,
): Promise<Outcome[]> {
  const previous = { home: process.env.XSB_HOME, servers: process.env.XSB_MCP_SERVERS };
  // The hubs the runs start inherit these: the machine's settings with the absent backend, and the stand-in browser
  // and computer-use tools every agent is given (as the app gives its browser).
  process.env.XSB_HOME = home();
  process.env.XSB_MCP_SERVERS = JSON.stringify({
    // With what the app says of its browser (desktop clis.ts), for the agents choose between browsers by it.
    browser: { command: process.execPath, args: [STUB, "browser"], about: BROWSER_ABOUT },
    desktop: { command: process.execPath, args: [STUB, "desktop"] },
  });
  const outcomes: Outcome[] = [];
  try {
    for (const scenario of scenarios) {
      const runs: Outcome["runs"] = [];
      for (let i = 0; i < options.runs; i++) {
        try {
          const seen = await runOnce(scenario, options.team, options.backend, options.language, options.timeoutMs, !!options.keep);
          const failures = scenario.expect.map((check) => judge(check, seen)).filter((f): f is string => !!f);
          runs.push({ passed: failures.length === 0, failures, ...(seen.dir ? { dir: seen.dir } : {}) });
        } catch (e) {
          runs.push({ passed: false, failures: [`the run failed: ${(e as Error).message}`] });
        }
      }
      const outcome = { scenario, runs };
      outcomes.push(outcome);
      report(outcome);
    }
  } finally {
    fs.rmSync(process.env.XSB_HOME!, { recursive: true, force: true });
    process.env.XSB_HOME = previous.home;
    process.env.XSB_MCP_SERVERS = previous.servers;
    if (previous.home === undefined) delete process.env.XSB_HOME;
    if (previous.servers === undefined) delete process.env.XSB_MCP_SERVERS;
  }
  return outcomes;
}

