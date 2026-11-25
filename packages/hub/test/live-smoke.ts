/** Opt-in model check; never part of npm test. Uses a scratch project and an explicit backend. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Agents, Connection, PROTOCOL_VERSION, Workflow } from "@xsb/protocol";
import { Hub } from "../src/hub.ts";

const backend = process.env.XSB_LIVE_BACKEND;
if (!backend) throw new Error("Set XSB_LIVE_BACKEND=codex or claude explicitly. This check invokes that real model.");
if (!["codex", "claude"].includes(backend)) throw new Error("Supported backends: codex, claude");
const project = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-live-smoke-"));
process.env.XSB_HOME = path.join(project, "home");
fs.mkdirSync(process.env.XSB_HOME);
fs.mkdirSync(path.join(project, ".xsb2"));
const wrapper = fileURLToPath(new URL(`../../desktop/dist/bin/${backend === "codex" ? "codex-acp" : "claude-agent-acp"}`, import.meta.url));
fs.writeFileSync(
  path.join(process.env.XSB_HOME, "config.json"),
  JSON.stringify({ version: 1, backends: { [backend]: { command: process.execPath, args: [wrapper] } } }),
);
const hub = new Hub(project);
let delivered = false;
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
    // ACP v2: a tool call is a run of patches; the first that names it opens it.
    if (update.sessionUpdate === "tool_call_update" && update.title && !calls.includes(`${update.toolCallId} ${update.title}`)) {
      calls.push(`${update.toolCallId} ${update.title}`);
      console.log("tool:", update.title);
    }
  });
  await conn.request("initialize", { protocolVersion: PROTOCOL_VERSION, info: { name: "live-smoke", version: "0" }, capabilities: { _meta: { [Agents.capability]: {} } } });
  const {sessionId} = await conn.request("session/new",{cwd:project,mcpServers:[],_meta:{[Workflow.backend]:backend}});
  timer = setTimeout(() => {
    console.error("live smoke timed out");
    conn?.close();
    void hub.shutdown();
  }, 120000);
  timer.unref();
  const graphJsonl = [{node:"draft",prompt:"Finish with summary DRAFT and assets []"},{node:"check",prompt:"Check the predecessor and finish with summary VERIFIED and assets []"},{node:"end",kind:"end"},{from:"draft",to:"check"},{from:"check",to:"end"}].map(v=>JSON.stringify(v)).join("\n");
  await conn.request("session/prompt", {sessionId,prompt:[{type:"text",text:"Run this two-step workflow with execute and acknowledge its final delivery. Graph JSONL:\n"+graphJsonl}]});
  const deadline = Date.now()+100000;
  while (Date.now()<deadline && !delivered) {
    delivered=!!hub.workflows.read(sessionId).instances.end?.last?.valid;
    if (!delivered) await new Promise(resolve=>setTimeout(resolve,150));
  }
  assert.ok(delivered,"both agents submitted and the end was delivered");
  console.log("live smoke: passed");
} finally {
  if (timer) clearTimeout(timer);
  fs.writeFileSync(path.join(project, "result.json"), JSON.stringify({ backend, delivered, output, calls }, null, 2));
  console.log("evidence:", project);
  conn?.close();
  await hub.shutdown();
}
