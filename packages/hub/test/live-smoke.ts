/** Opt-in real-model check. --discovery tests unprompted planning; a JSONL path replays a previously generated order graph. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Agents, Connection, History, PROTOCOL_VERSION, Workflow, conversationEntry, isAssistantOnly } from "@xsb/protocol";
import type { HistoryPage, WorkflowView } from "@xsb/protocol";
import { Hub } from "../src/hub.ts";
import { backends, findCommand, setProjectLanguage } from "../src/config.ts";
import { Paths } from "../src/paths.ts";
import { graphJsonl, parseGraph, validateResult } from "../src/workflow-graph.ts";

const backend = process.env.XSB_LIVE_BACKEND;
if (backend !== "codex" && backend !== "claude") throw Error("Set XSB_LIVE_BACKEND=codex or claude. This invokes a real model.");
const discovery = process.argv[2] === "--discovery";
const fixedGraph = !discovery && process.argv[2] ? fs.readFileSync(process.argv[2], "utf8") : undefined;
const expectedGraph = fixedGraph ? parseGraph(fixedGraph) : undefined;
const order = "练习本 3 本，每本 2.75 元；直尺 5 把，每把 1.40 元。";
const legacyRequest = "请现在运行一个两步工作流。第一位同事根据下面的订单原文提取一份明细列表，每行包含品名、数量、以分计的单价。" +
  "第二位同事用这份明细核算总额，交付一个以分计的整数。最后向我显示订单总额。每位同事给人的交付摘要只写“已完成”。订单：" + order;
const markdownRequest = "请现在建图并执行这份订单。入口任务提取 Markdown 明细，每项列出品名、数量及以分计的单价。" +
  "入口交付后由它自行选择下一节点。所有条目齐全就交给核算任务，有缺项就交给另一项任务列出需要补充的信息。" +
  "这两个任务都连到同一个终点。核算任务在收到明细后用 Markdown 交付以分计的总额，写出阿拉伯数字和单位。订单：" + order;
const discoveryRequest = "我要为杭州和苏州两场展览做一份排期。场地组要给出两地的容量和开放时间，财务组同时估算两地的费用。" +
  "排期组等两份材料都齐后再做安排。总费用超过八万元就先出一份缩减方案，否则给我正式排期。请先给我看各部分怎么衔接，我确认前先不要让大家开工。";
const usingMarkdown = !expectedGraph || expectedGraph.format === "markdown";

const project = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-live-smoke-"));
const configured = backends()[backend];
const wrapper = fileURLToPath(new URL(`../../desktop/dist/bin/${backend === "codex" ? "codex-acp" : "claude-agent-acp"}`, import.meta.url));
const spec = findCommand(configured.command) ? configured : { command: process.execPath, args: [wrapper] };
process.env.XSB_HOME = path.join(project, "home");
fs.mkdirSync(process.env.XSB_HOME);
fs.mkdirSync(path.join(project, ".xsb2"));
fs.writeFileSync(path.join(process.env.XSB_HOME, "config.json"), JSON.stringify({ version: 1, backends: { [backend]: spec } }));

const hub = new Hub(project);
if (discovery) setProjectLanguage(hub.paths, "zh-CN");
let sessionId: string | undefined;
let conn: Connection | undefined;
let timer: NodeJS.Timeout | undefined;
let failure: string | undefined;
let output = "";
let publication = "";
let mainEnded = false;
let directReply: { sessionId: string; answer: string; state: WorkflowView["state"] } | undefined;
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

function verifyLegacy(view: WorkflowView) {
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

async function verifyMarkdown(view: WorkflowView, client: Connection) {
  assert.equal(view.format, "markdown");
  const entries = view.nodes.filter(n => n.kind === "task" && !view.edges.some(e => e.to === n.name));
  assert.equal(entries.length, 1, "the user's order is supplied to one entry task");
  const source = entries[0];
  const options = view.edges.filter(e => e.from === source.name && e.case);
  assert.equal(new Set(options.map(e => e.to)).size, 2, "the source decides between calculation and missing details");
  const selected = view.nodes.find(n => n.kind === "task" && n.name === source.markdown?.choice);
  assert.ok(selected?.markdown && source.markdown?.input && source.markdown.output);
  assert.ok(source.markdown.input.includes("练习本") && source.markdown.input.includes("直尺"));
  assert.ok(source.markdown.output.includes("练习本") && source.markdown.output.includes("直尺"));
  assert.match(source.markdown.output, /275/);
  assert.match(source.markdown.output, /140/);
  assert.equal(selected.markdown.input, source.markdown.output, "the chosen task received the producer's full Markdown");
  assert.deepEqual(selected.markdown.sources, [{ node: source.name, delivery: source.target }]);
  assert.ok(selected.markdown.output);
  assert.match(selected.markdown.output, /(?:^|[^\d])1,?525(?!\d)/);
  assert.match(selected.markdown.output, /分/);
  const skipped = view.nodes.find(n => n.kind === "task" && n !== source && n !== selected);
  assert.equal(skipped?.status, "skipped");
  assert.equal(skipped.sessionId, undefined);
  const end = view.nodes.find(n => n.kind === "end" && n.status === "completed");
  assert.deepEqual(end?.markdown?.sources, [{ node: selected.name, delivery: selected.target }]);
  assert.equal(end?.markdown?.output, selected.markdown.output);
  assert.equal(publication, selected.markdown.output, "the end published the exact final Markdown");
  for (const task of [source, selected]) {
    assert.ok(task.agentId && task.sessionId && task.markdown?.input);
    assert.equal(hub.agent(task.agentId).backend, backend);
    const records = hub.state.store.read(Paths.transcript(task.agentId, task.sessionId));
    assert.ok(records.some(r => r.update?.sessionUpdate === "user_message_chunk" &&
      r.update.content?.type === "text" && isAssistantOnly(r.update.content) && r.update.content.text.includes(task.markdown!.input)),
      "the model received the dispatched Markdown as supplemental text");
    const page = await client.request<HistoryPage>(History.page, { sessionId: task.sessionId });
    const inputs = page.updates.filter(u => u.sessionUpdate === "user_message_chunk").map(u => u.content.text);
    assert.equal(inputs.length, 1);
    assert.ok(inputs[0] === "Start " + task.name || inputs[0] === "开始 " + task.name, "the conversation shows the node's start title");
  }
}

async function verifyDirectReply(client: Connection) {
  const { sessionId: id } = await client.request<{sessionId: string}>("session/new", { cwd: project, mcpServers: [], _meta: { [Workflow.backend]: backend } });
  const session = hub.session(id);
  await client.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "杭州属于哪个省？用省名回答。" }] });
  await session.current?.done.promise;
  const answer = hub.state.store.read(Paths.transcript(session.agentId, id))
    .filter(r => r.update?.sessionUpdate === "agent_message_chunk")
    .map(r => r.update.content.text ?? "").join("");
  const view = hub.workflows.get(id);
  directReply = { sessionId: id, answer, state: view.state };
  assert.match(answer, /浙江/);
  assert.equal(view.state, "empty", "a factual request in a fresh chat should be answered directly");
  assert.equal(view.candidate, undefined);
  assert.equal(view.version, undefined);
}

async function run() {
  await hub.start();
  const socket = net.connect(hub.paths.socket("acp"));
  conn = new Connection(socket, socket, "live-smoke");
  conn.onRequest("session/request_permission", p => {
    const name = p.toolCall?.title ?? "";
    const allow = /(?:mcp__workflow__|workflow[./])(?:guide|plan|execute|finish|choose)\b/i.test(name)
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
  const request = discovery ? discoveryRequest : usingMarkdown ? markdownRequest : legacyRequest;
  const prompt = fixedGraph ? request + "\n按以下已审阅的图原样执行。\n" + fixedGraph : request;
  await conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
  let startedNodes = 0;
  for (;;) {
    if (failure) throw Error(failure);
    const view = hub.workflows.get(sessionId);
    if (discovery) {
      assert.equal(view.version, undefined, "the user reserved execution for their review");
      if (mainEnded) {
        const graph = view.candidate?.graph;
        assert.ok(graph, "the real model must save a candidate on the first request without being told about workflow tools. " + output);
        assert.equal(graph.format, "markdown");
        assert.ok(graph.nodes.filter(n => n.kind === "task").length >= 3);
        assert.ok(graph.edges.some(edge => edge.case), "the budget determines which deliverable follows");
        assert.ok(graph.nodes.some(n => n.kind === "task" && new Set(graph.edges.filter(e => e.to === n.node).map(e => e.from)).size >= 2),
          "the scheduling task needs both the venue and budget inputs");
        timer?.refresh();
        await verifyDirectReply(conn);
        return;
      }
    }
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
      if (expectedGraph) {
        const flow = hub.workflows.read(sessionId);
        assert.deepEqual(flow.versions[flow.active!], expectedGraph, "the approved graph ran unchanged");
      }
      if (usingMarkdown) await verifyMarkdown(view, conn);
      else verifyLegacy(view);
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
  console.log("passed:", backend, discovery ? "planned dependent and conditional work from the first natural request and answered a simple question directly in a fresh chat" :
    usingMarkdown ? "delivered a Markdown total through worker-selected routing" : "delivered 1525 cents through legacy named inputs");
} catch (error) {
  failure = (error as Error).message;
  throw error;
} finally {
  if (timer) clearTimeout(timer);
  const flow = sessionId && hub.workflows.read(sessionId);
  if (flow && flow.active) fs.writeFileSync(path.join(project, "graph.jsonl"), graphJsonl(flow.versions[flow.active]) + "\n");
  const view = sessionId && hub.workflows.get(sessionId);
  fs.writeFileSync(path.join(project, "result.json"), JSON.stringify({ backend, sessionId, failure, output, publication, denied, view, directReply }, null, 2));
  conn?.close();
  await hub.shutdown();
}
