/** Opt-in model check; never part of npm test. Uses a scratch project and a free, delayed local tool. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Agents, Connection, Roles, Teams } from "@xsb/protocol";
import { Hub } from "../src/hub.ts";

const backend = process.env.XSB_LIVE_BACKEND;
if (!backend) throw new Error("Set XSB_LIVE_BACKEND=codex or claude explicitly. This check invokes that real model.");
if (!["codex", "claude"].includes(backend)) throw new Error("Supported backends: codex, claude");
const project = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-live-smoke-"));
process.env.XSB_HOME = path.join(project, "home");
fs.mkdirSync(process.env.XSB_HOME);
fs.mkdirSync(path.join(project, ".xsb"));
const wrapper = fileURLToPath(new URL(`../../desktop/dist/bin/${backend === "codex" ? "codex-acp" : "claude-agent-acp"}`, import.meta.url));
fs.writeFileSync(
  path.join(process.env.XSB_HOME, "config.json"),
  JSON.stringify({ version: 1, backends: { [backend]: { command: process.execPath, args: [wrapper] } } }),
);
const hub = new Hub(project);
let joined = false;
let reentered = false;
let output = "";
let calls: string[] = [];
let conn: Connection | undefined;
let timer: NodeJS.Timeout | undefined;
try {
  await hub.start();
  const socket = net.connect(hub.paths.socket("acp"));
  conn = new Connection(socket, socket, "live-smoke");
  conn.onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }));
  conn.onNotification("session/update", ({ update }) => {
    if (update.sessionUpdate === "agent_message_chunk") output += update.content.text ?? "";
    if (update.sessionUpdate === "tool_call") {
      calls.push(update.title ?? "");
      console.log("tool:", update.title);
    }
    if (update.sessionUpdate === "user_message_chunk" && update.content.text?.includes("rendered: cross-turn probe")) reentered = true;
  });
  await conn.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { [Agents.capability]: {} } } });
  await conn.request(Teams.use, { id: "software" });
  const { role } = await conn.request(Roles.get, { name: "developer" });
  await conn.request(Roles.put, {
    role: {
      name: "developer",
      mcpServers: { ...role.mcpServers, "test-delay": { command: process.execPath, args: [fileURLToPath(new URL("./mock-generator.ts", import.meta.url))] } },
    },
  });
  await conn.request(Agents.put, { agent: { id: "developer", name: "Developer", role: "developer", backend } });
  const { sessionId } = await conn.request("session/new", { cwd: project, mcpServers: [], _meta: { [Agents.sessionKey]: "developer" } });
  const observation = setInterval(() => {
    if (hub.state.gates.size) joined = true;
  }, 25);
  timer = setTimeout(() => {
    console.error("live smoke timed out");
    conn?.close();
    void hub.shutdown();
  }, 120000);
  timer.unref();
  try {
    await conn.request("session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text: 'Run only this collaboration probe. Start exactly one background job with start_job: server="test-delay", tool="render", arguments={"prompt":"cross-turn probe","ms":30000}, title="cross-turn probe". Then await_tasks for that task_id and end your turn while waiting. When the result arrives in the later turn, respond with CROSS-TURN-DONE and the render result. Do not run shell commands, edit files, or dispatch other tasks.',
        },
      ],
    });
    const until = Date.now() + 90000;
    while (!output.includes("CROSS-TURN-DONE") && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(joined, "model opened an await_tasks gate");
    assert.ok(reentered, "the result entered a later turn");
    assert.match(output, /CROSS-TURN-DONE/);
    console.log("live smoke: passed");
  } finally {
    clearInterval(observation);
  }
} finally {
  if (timer) clearTimeout(timer);
  fs.writeFileSync(path.join(project, "result.json"), JSON.stringify({ backend, joined, reentered, output, calls }, null, 2));
  console.log("evidence:", project);
  conn?.close();
  await hub.shutdown();
}
