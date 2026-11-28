// Electron, the real Hub and a scripted backend exchanging blocking and async ACP forms.
// XSB_SCREENSHOTS=<folder> saves pictures of the same cards used by the app.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");

require("./window-harness.cjs").windowTest(__filename, async ({ win, js, q, click, send, has, until, untilJS, root }) => {
  const text = (await import(pathToFileURL(path.join(root, "packages/desktop/renderer/text.js")).href)).TEXT[await js("xsb.language")];
  const shots = process.env.XSB_SCREENSHOTS;
  const shoot = async (name) => {
    if (!shots) return;
    await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    fs.writeFileSync(path.join(shots, name + ".png"), (await win.capturePage()).toPNG());
  };
  const lane = "#lanes .lane";
  const card = (state) => lane + ` .entry.question[data-state="${state}"]`;
  const rowOf = async (agent) => "#agents .row:nth-child(" + ((await js("xsb.load().then(s=>s.agents.filter(a=>!a.workflowOwner).map(a=>a.id))")).indexOf(agent) + 1) + ")";
  const ask = (message, properties, required = []) => "!elicit " + JSON.stringify({ message, requestedSchema: { type: "object", properties, required } });
  const echoed = (words) => untilJS(q(lane + " .entries") + ".innerText.includes(" + JSON.stringify(words) + ")", "echo " + words);
  win.show();

  await until(() => has(lane), "first conversation");
  // Real settings UI -> preload -> main -> durable Hub preference, with workspace inheritance.
  await click("#settings");
  const preference = 'dialog [data-setting="consultation"]';
  await until(() => has(preference), "global consultation setting");
  assert.equal(await js(q(preference) + ".checked"), false);
  await click(preference);
  await untilJS('xsb.consultationSettings().then(s=>s.global===true)', "global preference saved");
  await untilJS(q(preference) + ".disabled===false", "global save completed");
  await shoot("consultation-global-settings");
  await js('[...document.querySelectorAll(".settings-nav-item")].find(e=>e.textContent===' + JSON.stringify(text["settings.workspace"]) + ').click()');
  await untilJS(q(preference) + '?.tagName==="SELECT"', "workspace consultation setting");
  assert.equal(await js(q(preference) + ".value"), "inherit");
  assert.ok((await js(q(preference) + ".selectedOptions[0].textContent")).includes(text["settings.consultation.enabled"]));
  const setPreference = (value) => js('(()=>{const e=' + q(preference) + ';e.value=' + JSON.stringify(value) + ';e.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await setPreference("disabled");
  await untilJS('xsb.consultationSettings().then(s=>s.project===false&&s.effective===false)', "workspace override saved");
  await untilJS(q(preference) + ".disabled===false", "workspace save completed");
  await setPreference("inherit");
  await untilJS('xsb.consultationSettings().then(s=>s.project===null&&s.effective===true)', "inheritance restored");
  await untilJS(q(preference) + ".disabled===false", "inheritance save completed");
  const projectConfig = JSON.parse(fs.readFileSync(path.join((await js("xsb.load()")).workspace.path, ".xsb2/config.json"), "utf8"));
  assert.equal(Object.hasOwn(projectConfig, "consultUser"), false, "inheritance removes the persisted override");
  await shoot("consultation-workspace-settings");
  await js('document.querySelector("dialog.settings-dialog").close()');
  const agent = await js('xsb.newSession("mock")');
  await untilJS('document.querySelectorAll("#agents .row").length>=2', "listed");
  await click(await rowOf(agent.id));
  const row = await rowOf(agent.id);
  const enabled = (await js("xsb.projectLanguage()")) === "zh-CN" ? "当前偏好：开启" : "Current preference: enabled";
  const disabled = (await js("xsb.projectLanguage()")) === "zh-CN" ? "当前偏好：关闭" : "Current preference: disabled";
  await send(lane, "!consultation");
  await echoed(enabled);
  await untilJS(q(row + " .state") + ".dataset.state==='idle'", "initial instructions completed");
  await js('xsb.setConsultation("project",false)');
  await send(lane, "!consultation");
  await echoed(disabled);
  await untilJS(q(row + " .state") + ".dataset.state==='idle'", "updated instructions completed");

  // Three kinds in one call.
  await send(lane, ask("出行计划", {
    budget: { type: "string", title: "预算多少？", _meta: { codex: { isOther: true } }, oneOf: ["5000 以内", "5000–10000", "不限", "None of the above"].map(label => ({ const: label, title: label })) },
    budget_note: { type: "string", title: "Additional answer or note", _meta: { codex: { role: "user_note", questionId: "budget" } } },
    views: { type: "array", title: "想看哪些风景？", items: { anyOf: ["海边", "雪山", "草原", "古镇"].map(label => ({ const: label })) } },
    city: { type: "string", title: "从哪里出发？" },
  }, ["budget", "views", "city"]));
  const panel = lane + " .ask-panel";
  await until(() => has(panel), "question panel above the composer");
  await untilJS(q(row + " .state") + ".dataset.state==='asking'", "the row says it waits for the answer");
  assert.equal(await js(q(lane + " .lane-state span") + ".textContent"), text["state.asking"]);
  assert.equal(await js(q(panel + " .ask-head small") + ".textContent"), "1/3");
  assert.equal(await js(q(panel + " .ask-next") + ".disabled"), true, "nothing goes on before the question has an answer");
  assert.equal(await js("document.querySelectorAll(" + JSON.stringify(panel + " .ask-row") + ").length"), 4, "three options and one of your own");
  await shoot("ask-open");
  await new Promise(r => setTimeout(r, 150));
  assert.equal(await js(q(row + " .state") + ".dataset.state"), "asking");
  assert.equal(await js(q(lane + " .entries") + ".innerText.includes('native answer:')"), false, "the request is still open");

  // 1/3: an answer of one's own.
  await click(panel + " .ask-row:last-child");
  await js("(()=>{const o=document.querySelector(" + JSON.stringify(panel + " .ask-other-input") + ");o.value='8000 左右';o.dispatchEvent(new InputEvent('input',{bubbles:true}));})()");
  assert.equal(await js(q(panel + " .ask-row:last-child") + ".getAttribute('aria-checked')"), "true");
  await click(panel + " .ask-next");
  // 2/3: two sceneries, by number keys.
  await untilJS(q(panel + " .ask-head small") + ".textContent.includes('2/3')", "second page");
  await js(q(panel) + ".focus()");
  for (const key of ["1", "2"]) win.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
  await untilJS("[...document.querySelectorAll(" + JSON.stringify(panel + " .ask-row[aria-checked=true]") + ")].length===2", "picked by keys");
  await shoot("ask-multi");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  // 3/3: a city, then Enter submits.
  await untilJS(q(panel + " .ask-head small") + "?.textContent.includes('3/3')", "third page");
  await js("(()=>{const t=document.querySelector(" + JSON.stringify(panel + " .ask-text") + ");t.value='杭州';t.dispatchEvent(new InputEvent('input',{bubbles:true}));t.focus();})()");
  assert.equal(await js(q(panel + " .ask-next") + ".textContent"), text["ask.submit"]);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  await until(() => has(card("answered")), "answered");
  assert.equal(await has(panel), false, "the panel goes once answered");
  assert.equal(await js(q(card("answered") + " .ask-answers") + ".innerText.includes('8000 左右')"), true);
  assert.equal(await js(q(card("answered") + " .ask-answers") + ".innerText.includes('海边、雪山')"), true);
  await echoed('"budget_note":"8000 左右"');
  await echoed('"budget":"None of the above"');
  await echoed('"city":"杭州"');
  assert.equal(await js("[...document.querySelectorAll(" + JSON.stringify(lane + " .entry.input[data-origin=user]") + ")].filter(e=>!e.hidden).some(e=>e.textContent.includes('杭州'))"), false,
    "the answer is shown by the record, not as a message of its own");
  await untilJS(q(row + " .state") + ".dataset.state==='idle'", "no longer waiting");
  await shoot("ask-answered");

  // Skipped.
  await send(lane, ask("旅行计划", { hotel: { type: "string", title: "要不要住民宿？", enum: ["要", "不要"] } }));
  await until(() => has(lane + " .ask-panel"), "second question");
  await click(lane + " .ask-foot .btn:not(.primary)");
  await until(() => has(card("skipped")), "skipped");
  await echoed('native answer: {"action":"decline"}');

  // A message instead of an answer.
  await send(lane, ask("几天？", { days: { type: "string" } }));
  await until(() => has(lane + " .ask-panel"), "third question");
  await send(lane, "先看看天气再说");
  await until(() => has(card("cancelled")), "superseded blocking form was cancelled");
  await echoed('native answer: {"action":"cancel"}');
  await echoed("先看看天气再说");
  assert.equal(await has(lane + " .ask-panel"), false);
  // Backend-native ACP forms share the same UI, but return through the request rather than session/prompt.
  const native = { message: "原生提问：使用哪个数据库？", requestedSchema: { type: "object", properties: {
    question_0: { type: "string", title: "数据库", oneOf: [{ const: "sqlite", title: "SQLite", description: "本地保存" }, { const: "pg", title: "Postgres" }] },
    question_0_custom: { type: "string", title: "Other" },
  } } };
  await send(lane, "!elicit " + JSON.stringify(native));
  await until(() => has(panel), "native ACP form reuses ask panel");
  assert.equal(await js(q(panel + " .ask-head strong") + ".textContent"), native.message);
  await js('xsb.setConsultation("project",true)');
  assert.equal(await has(panel), true, "preference changes do not cancel the active native callback");
  assert.equal(await js("document.querySelectorAll(" + JSON.stringify(panel + " .ask-row") + ").length"), 3);
  await click(panel + " .ask-row:first-child");
  await shoot("ask-native");
  await click(panel + " .ask-next");
  await echoed('"question_0":"sqlite"');
  assert.equal(await has(panel), false);

  await untilJS(q(row + " .state") + ".dataset.state==='idle'", "native turn ended before further work");
  assert.ok((await js("xsb.load()")).transcripts[agent.id].some(e => e.kind === "question" && e.source === "acp" && e.state === "answered"), "native question answered");

  // Codex publishes each async request separately and does other work. Idle leaves both forms answerable.
  const asyncForm = (title) => "!elicitAsync " + JSON.stringify({
    message: "Codex keeps working while you answer.", _meta: { codex: { delivery: "async" } },
    requestedSchema: { type: "object", properties: { question_0: { type: "string", title, _meta: { codex: { isOther: false, isSecret: false } } } } },
  });
  await send(lane, [asyncForm("下次出发日期？"), asyncForm("补充行程？"), "!say OTHER WORK"].join("\n"));
  const count = "document.querySelectorAll(" + JSON.stringify(panel) + ").length";
  await untilJS(count + "===2", "two independently answerable async forms");
  await echoed("OTHER WORK");
  await untilJS(q(row + " .state") + ".dataset.state==='idle'", "pending async forms permit idle");
  const second = lane + " .ask-panel:nth-child(2)";
  await js("(()=>{const e=" + q(second + " .ask-text") + ";e.value='周五';e.dispatchEvent(new InputEvent('input',{bubbles:true}));})()");
  await click(panel + " .ask-foot .btn");
  await untilJS(count + "===1", "only skipped form closed");
  assert.equal(await js(q(panel + " .ask-text") + ".value"), "周五", "closing another form preserves the draft");
  const expired = await js(q(panel) + ".dataset.question");
  await click(panel + " .ask-next");
  await echoed('"question_0":"周五"');
  await untilJS(count + "===0", "async answer returned");
  await assert.rejects(js('xsb.answerQuestion(' + JSON.stringify(agent.id) + ',{questionId:' + JSON.stringify(expired) + ',skipped:true})'), /expired/);

  // Two simultaneous node requests surface in their owning conversation, including while the sidebar is closed.
  const graph = [
    { node: "审阅", prompt: ask("审阅范围？", { scope: { type: "string", enum: ["全文", "摘要"] } }) + '\n!call finish {"summary":"已审阅"}' },
    { node: "写入", prompt: '!perm\n!call finish {"summary":"已写入"}' },
    { node: "完成", kind: "end" }, { from: "审阅", to: "完成" }, { from: "写入", to: "完成" },
  ].map(v => JSON.stringify(v)).join("\n");
  await send(lane, '!call execute ' + JSON.stringify({ graphJsonl: graph }));
  const request = (kind) => lane + ' .workflow-request[data-kind="' + kind + '"]';
  const dot = (name) => '.dag-node[data-node="' + name + '"] .dag-attention';
  const taskChat = "#task-conversation .lane";
  await until(() => has(request("question")), "node question in the main conversation");
  await until(() => has(request("permission")), "node permission in the main conversation");
  assert.match(await js(q(request("question")) + ".textContent"), /审阅/);
  assert.match(await js(q(request("permission")) + ".textContent"), /写入.*Write a file/);
  assert.ok(await has(dot("审阅")) && await has(dot("写入")), "both DAG nodes need attention");
  await shoot("workflow-node-requests");
  await click('#tabs .tab[data-id="workflow"] .icon-btn');
  await click("#toggle-artifact");
  const askAgent = await js(q(request("question")) + ".dataset.agent");
  await click(request("question"));
  await untilJS(q(taskChat) + "?.dataset.agent===" + JSON.stringify(askAgent), "the question opens its node");
  assert.ok(await js(q(taskChat + " .ask-panel") + ".checkVisibility()"), "clicking the card reveals the form");
  await click(taskChat + " .ask-row");
  await click(taskChat + " .ask-next");
  await until(async () => !await has(request("question")) && !await has(dot("审阅")), "answered question cleared");
  assert.ok(await has(request("permission")) && await has(dot("写入")), "the other node is still awaiting approval");
  const permissionAgent = await js(q(request("permission")) + ".dataset.agent");
  await click(request("permission"));
  await untilJS(q(taskChat) + "?.dataset.agent===" + JSON.stringify(permissionAgent), "the permission opens its node");
  assert.ok(await js(q(taskChat + " .permission .actions") + ".checkVisibility()"), "the pending decision is visible");
  await click(taskChat + " .permission .btn.primary");
  await until(async () => !await has(lane + " .workflow-requests") && !await has(dot("写入")), "handled workflow requests cleared");
  // Delivered workflows expose no meaningless pause/resume control.
  // Loading the startup snapshot suspends live events. Observe delivery in the UI before reading it.
  await untilJS('document.querySelector("#flow-heading")?.textContent.includes(' + JSON.stringify(text["flow.finished"]) + ')', "completed workflow badge");
  assert.equal(await js('document.querySelectorAll("#flow-heading .btn").length'), 0);
  assert.equal((await js("xsb.load()")).workflows[agent.mainSessionId].state, "completed");

  await send(lane, '!say | 日期 | 推荐安排 |\n!say | --- | --- |\n!say | 1月1日：抵达与休息 | 北京直飞珠海，入住后在附近散步。 |\n!say | 1月2日：东澳岛 | 上午去、下午回，午餐与安静休息。 |');
  await until(() => has(lane + " .md tbody td"), "markdown table");
  const sizes = await js('(()=>{const cell=document.querySelector(' + JSON.stringify(lane + " .md tbody td") + ');const c=getComputedStyle(cell);const b=document.querySelector("#settings");return {left:c.paddingLeft,top:c.paddingTop,button:b.getBoundingClientRect().height,icon:b.querySelector("svg").getBoundingClientRect().width};})()');
  assert.deepEqual(sizes, { left: "12px", top: "8px", button: 36, icon: 16 });
  await shoot("workflow-completed-table");
  const tool = lane + " .entry.tool";
  assert.equal(await js("getComputedStyle(" + q(tool + " > summary") + ", '::before').content"), "none", "tool rows do not get a second generic disclosure arrow");
  assert.ok(await js('[...document.querySelectorAll(' + JSON.stringify(tool) + ')].every(e=>e.tagName==="DETAILS"&&!e.open)'), "tools are one-line collapsed details");
  assert.equal(await js('getComputedStyle(document.querySelector(' + JSON.stringify(tool + " summary") + ')).height'), "24px");
  await click(tool + " summary");
  await untilJS('document.querySelector(' + JSON.stringify(tool) + ').open', "tool expanded on request");
  assert.equal(await js('document.querySelector(' + JSON.stringify(tool + " .tool-status") + ').textContent'), text["tool.status.done"]);
  await click(tool + " summary");
  await send(lane, "!titlelater 120 珠海亲子旅行");
  await untilJS(q(row + " .row-text strong") + '.textContent==="珠海亲子旅行"', "native title update after idle");
  assert.equal((await js("xsb.load()")).agents.find(a => a.id === agent.id).name, "珠海亲子旅行");
  console.log("Electron + real Hub/ACP: consultation settings and native blocking and asynchronous forms passed");
});
