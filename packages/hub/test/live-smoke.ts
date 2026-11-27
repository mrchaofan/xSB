/** Opt-in real-model check. Set XSB_LIVE_BACKEND to claude or codex. An optional JSONL path replays a previously generated order graph. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Agents, Connection, PROTOCOL_VERSION, Workflow, conversationEntry } from "@xsb/protocol";
import type { WorkflowView } from "@xsb/protocol";
import { Hub } from "../src/hub.ts";
import { backends, findCommand } from "../src/config.ts";
import { Paths } from "../src/paths.ts";
import { graphJsonl, parseGraph, validateResult } from "../src/workflow-graph.ts";

const backend = process.env.XSB_LIVE_BACKEND;
if (backend !== "codex" && backend !== "claude") throw Error("Set XSB_LIVE_BACKEND=codex or claude. This invokes a real model.");
const fixedGraph = process.argv[2] && fs.readFileSync(process.argv[2], "utf8");
const order = "练习本 3 本，每本 2.75 元；直尺 5 把，每把 1.40 元。";
const request = "请现在运行一个两步工作流。第一位同事根据下面的订单原文提取一份明细列表，每行包含品名、数量、以分计的单价。" +
  "第二位同事用这份明细核算总额，交付一个以分计的整数。最后向我显示订单总额。每位同事给人的交付摘要只写“已完成”。订单：" + order;

const project = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-live-smoke-"));
const configured = backends()[backend];
const wrapper = fileURLToPath(new URL(`../../desktop/dist/bin/${backend === "codex" ? "codex-acp" : "claude-agent-acp"}`, import.meta.url));
const spec = findCommand(configured.command) ? configured : { command: process.execPath, args: [wrapper] };
process.env.XSB_HOME = path.join(project, "home");
fs.mkdirSync(process.env.XSB_HOME);
fs.mkdirSync(path.join(project, ".xsb2"));
fs.writeFileSync(path.join(process.env.XSB_HOME, "config.json"), JSON.stringify({ version: 1, backends: { [backend]: spec } }));

const hub = new Hub(project);
let sessionId: string | undefined;
let conn: Connection | undefined;
let timer: NodeJS.Timeout | undefined;
let failure: string | undefined;
let output = "";
let publication = "";
let mainEnded = false;
const denied: string[] = [];

function values(value: unknown): unknown[] {
  return value !== null && typeof value === "object" ? [value, ...Object.values(value).flatMap(values)] : [value];
}

function hasOrderLines(value: unknown) {
  return values(value).some(rows => Array.isArray(rows) && rows.length === 2 &&
    [[3, 275], [5, 140]].every(([count, price]) => rows.some(row => {
      const fields = values(row);
      return fields.includes(count) && fields.includes(price);
    })));
}

function verify(view: WorkflowView) {
  const tasks = view.nodes.filter(n => n.kind === "task");
  assert.equal(tasks.length, 2, "the request calls for two working nodes");
  const source = tasks.find(n => hasOrderLines(n.contract?.result));
  const sum = tasks.find(n => n.contract?.result === 1525);
  const end = view.nodes.find(n => n.kind === "end" && n.status === "completed");
  assert.ok(source?.contract?.input, "first task received named inputs and delivered two typed order lines");
  assert.ok(values(source.contract.input).some(v => typeof v === "string" && v.includes("练习本") && v.includes("直尺")), "first task received the user's order");
  assert.ok(sum?.contract && hasOrderLines(sum.contract.input), "calculation received numeric quantities and unit prices and delivered integer 1525");
  assert.ok(end?.contract?.result && values(end.contract.result).includes(1525), "the end published the numeric total");
  const stringifyNumbers = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "number" ? String(item) : item));
  assert.ok(source.contract.schema && sum.contract.schema);
  assert.throws(() => validateResult(source.contract!.schema!, stringifyNumbers(source.contract!.result)), "producer schema requires typed line items");
  assert.throws(() => validateResult(sum.contract!.inputSchema, stringifyNumbers(sum.contract!.input)), "consumer schema requires typed line items");
  assert.throws(() => validateResult(sum.contract!.schema!, "1525"), "total schema requires a number");
  for (const [producer, consumer] of [[source, sum], [sum, end]]) {
    assert.ok(Object.values(consumer.contract!.inputSources ?? {}).some(s => s.node === producer.name && s.delivery === producer.target),
      "the input came from this predecessor's accepted delivery");
  }
  for (const task of tasks) {
    assert.equal(task.summary, "已完成", "the human summary carries no order data");
    assert.ok(task.contract?.schema && task.agentId && task.sessionId);
    const inputs = hub.state.store.read(Paths.transcript(task.agentId, task.sessionId)).map(r => r.update)
      .filter(u => u?.sessionUpdate === "user_message_chunk" && u.content?.type === "text");
    assert.ok(inputs.some(u => u.content.text.includes(JSON.stringify(task.contract!.input, null, 2))), "the ACP transcript includes the exact named inputs");
    assert.equal(hub.agent(task.agentId).backend, backend);
  }
  assert.match(publication, /1525/);
}

async function run() {
  await hub.start();
  const socket = net.connect(hub.paths.socket("acp"));
  conn = new Connection(socket, socket, "live-smoke");
  conn.onRequest("session/request_permission", p => {
    const name = p.toolCall?.title ?? "";
    const allow = /(?:mcp__workflow__|workflow[./])(?:plan|execute|finish)\b/i.test(name)
      && p.options.find((o: { kind: string }) => o.kind === "allow_once");
    if (allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
    denied.push(name);
    return { outcome: { outcome: "cancelled" } };
  });
  conn.onNotification("session/update", ({ sessionId: id, update }) => {
    if (id !== sessionId) return;
    if (update.sessionUpdate === "agent_message_chunk") output += update.content.text ?? "";
    if (update.sessionUpdate === "state_update" && update.state === "idle") {
      mainEnded = true;
      if (update.error) failure = update.error.message;
    }
    const entry = conversationEntry(update, id);
    if (entry?.source.id === "workflow") publication = entry.markdown;
  });
  await conn.request("initialize", { protocolVersion: PROTOCOL_VERSION, info: { name: "live-smoke", version: "0" }, capabilities: { _meta: { [Agents.capability]: {} } } });
  sessionId = (await conn.request("session/new", { cwd: project, mcpServers: [], _meta: { [Workflow.backend]: backend } })).sessionId as string;
  const prompt = fixedGraph ? request + "\n按以下已审阅的图原样执行。\n" + fixedGraph : request;
  await conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
  let startedNodes = 0;
  for (;;) {
    if (failure) throw Error(failure);
    const view = hub.workflows.get(sessionId);
    const started = view.nodes.filter(node => node.sessionId).length;
    if (started > startedNodes) {
      startedNodes = started;
      timer?.refresh();
    }
    if (mainEnded && !view.version) throw Error("Main agent ended without running a graph. " + output);
    if (view.state === "paused" || view.nodes.some(n => n.status === "suspended" || n.status === "input_error")) {
      throw Error("Graph stopped before completion: " + JSON.stringify(view.nodes.map(n => [n.name, n.status, n.contract?.error])));
    }
    if (view.state === "completed" && publication) {
      if (fixedGraph) {
        const flow = hub.workflows.read(sessionId);
        assert.deepEqual(flow.versions[flow.active!], parseGraph(fixedGraph), "the approved graph ran unchanged");
      }
      verify(view);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

try {
  console.log("evidence:", project);
  await Promise.race([
    run(),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Live order workflow timed out after 4 minutes without reaching another node")), 240_000); }),
  ]);
  console.log("passed:", backend, "delivered 1525 cents through named inputs");
} catch (error) {
  failure = (error as Error).message;
  throw error;
} finally {
  if (timer) clearTimeout(timer);
  const flow = sessionId && hub.workflows.read(sessionId);
  if (flow && flow.active) fs.writeFileSync(path.join(project, "graph.jsonl"), graphJsonl(flow.versions[flow.active]) + "\n");
  const view = sessionId && hub.workflows.get(sessionId);
  fs.writeFileSync(path.join(project, "result.json"), JSON.stringify({ backend, sessionId, failure, output, publication, denied, view }, null, 2));
  conn?.close();
  await hub.shutdown();
}
