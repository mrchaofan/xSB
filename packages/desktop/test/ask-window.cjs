// Run after building the desktop app (window-harness.cjs): an agent asks the user with the ask tool. The card shows in
// the conversation, the agent waits for the answer, and the user answers, skips, or writes something else instead.
// The scripted backend echoes what it is given, so the test sees what the model got. XSB_SCREENSHOTS=<folder> saves pictures.
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
  const ask = (questions) => "!call ask " + JSON.stringify({ questions });
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
  await send(lane, ask([
    { question: "预算多少？", kind: "single", options: ["5000 以内", "5000–10000", "不限"], other: true },
    { question: "想看哪些风景？", kind: "multi", options: ["海边", "雪山", "草原", "古镇"] },
    { question: "从哪里出发？", kind: "text" },
  ]));
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
  assert.equal(await js(q(lane + " .entries") + ".innerText.includes('result(ask)')"), false, "ask has not returned before submission");

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
  await echoed("[xSB] The user's answers to the questions you asked (ask).");
  await echoed("杭州");
  assert.equal(await js("[...document.querySelectorAll(" + JSON.stringify(lane + " .entry.input[data-origin=user]") + ")].filter(e=>!e.hidden).some(e=>e.textContent.includes('杭州'))"), false,
    "the answer is shown by the record, not as a message of its own");
  await untilJS(q(row + " .state") + ".dataset.state==='idle'", "no longer waiting");
  await shoot("ask-answered");

  // Skipped.
  await send(lane, ask([{ question: "要不要住民宿？", kind: "single", options: ["要", "不要"] }]));
  await until(() => has(lane + " .ask-panel"), "second question");
  await click(lane + " .ask-foot .btn:not(.primary)");
  await until(() => has(card("skipped")), "skipped");
  await echoed("[xSB] The user skipped the questions you asked (ask).");

  // A message instead of an answer.
  await send(lane, ask([{ question: "几天？", kind: "text" }]));
  await until(() => has(lane + " .ask-panel"), "third question");
  await send(lane, "先看看天气再说");
  await until(() => has(card("superseded")), "superseded");
  await echoed("[xSB] The user did not answer the questions you asked (ask) and wrote this instead.");
  assert.equal(await js(q(card("superseded") + " .ask-record-head small") + ".textContent"), text["ask.state.superseded"]);
  assert.equal(await has(lane + " .ask-panel"), false);
  // Backend-native ACP forms share the same UI, but return through the request rather than session/prompt.
  const native = { message: "原生提问：使用哪个数据库？", requestedSchema: { type: "object", properties: {
    question_0: { type: "string", oneOf: [{ const: "sqlite", title: "SQLite", description: "本地保存" }, { const: "pg", title: "Postgres" }] },
    question_0_custom: { type: "string", title: "Other" },
  } } };
  await send(lane, "!elicit " + JSON.stringify(native));
  await until(() => has(panel), "native ACP form reuses ask panel");
  await js('xsb.setConsultation("project",true)');
  assert.equal(await has(panel), true, "preference changes do not cancel the active native callback");
  assert.equal(await js("document.querySelectorAll(" + JSON.stringify(panel + " .ask-row") + ").length"), 3);
  await click(panel + " .ask-row:first-child");
  await shoot("ask-native");
  await click(panel + " .ask-next");
  await echoed('"question_0":"sqlite"');
  await untilJS('xsb.load().then(s=>s.transcripts[' + JSON.stringify(agent.id) + '].some(e=>e.kind==="question"&&e.source==="acp"&&e.state==="answered"))', "native question answered");
  assert.equal(await has(panel), false);

  await untilJS(q(row + " .state") + ".dataset.state==='idle'", "native turn ended before further work");

  // Delivered workflows expose no meaningless pause/resume control.
  const graph = [{ node: "审阅", prompt: '!call finish {"summary":"已审阅","assets":[]}' }, { node: "完成", kind: "end" }, { from: "审阅", to: "完成" }].map(v => JSON.stringify(v)).join("\n");
  await send(lane, '!call execute ' + JSON.stringify({ graphJsonl: graph }));
  await untilJS('xsb.load().then(s=>Object.values(s.workflows).some(f=>f.state==="completed"))', "workflow delivered and queried as completed");
  await untilJS('document.querySelector("#flow-heading")?.textContent.includes(' + JSON.stringify(text["flow.finished"]) + ')', "completed workflow badge");
  assert.equal(await js('document.querySelectorAll("#flow-heading .btn").length'), 0);

  await send(lane, '!say | 日期 | 推荐安排 |\n!say | --- | --- |\n!say | 1月1日：抵达与休息 | 北京直飞珠海，入住后在附近散步。 |\n!say | 1月2日：东澳岛 | 上午去、下午回，午餐与安静休息。 |');
  await until(() => has(lane + " .md tbody td"), "markdown table");
  const sizes = await js('(()=>{const cell=document.querySelector(' + JSON.stringify(lane + " .md tbody td") + ');const c=getComputedStyle(cell);const b=document.querySelector("#settings");return {left:c.paddingLeft,top:c.paddingTop,button:b.getBoundingClientRect().height,icon:b.querySelector("svg").getBoundingClientRect().width};})()');
  assert.deepEqual(sizes, { left: "12px", top: "8px", button: 36, icon: 16 });
  await shoot("workflow-completed-table");
  const tool = lane + " .entry.tool";
  assert.ok(await js('[...document.querySelectorAll(' + JSON.stringify(tool) + ')].every(e=>e.tagName==="DETAILS"&&!e.open)'), "tools are one-line collapsed details");
  assert.equal(await js('getComputedStyle(document.querySelector(' + JSON.stringify(tool + " summary") + ')).height'), "24px");
  await click(tool + " summary");
  await untilJS('document.querySelector(' + JSON.stringify(tool) + ').open', "tool expanded on request");
  assert.equal(await js('document.querySelector(' + JSON.stringify(tool + " .tool-status") + ').textContent'), text["tool.status.done"]);
  await click(tool + " summary");
  await send(lane, "!titlelater 120 珠海亲子旅行");
  await untilJS('xsb.load().then(s=>s.agents.find(a=>a.id===' + JSON.stringify(agent.id) + ').name==="珠海亲子旅行")', "native title update after idle");
  assert.equal(await js(q(row + " .row-text strong") + '.textContent'), "珠海亲子旅行");
  console.log("Electron + real Hub/ACP: consultation settings, persisted inheritance, updated model instructions and both ask paths passed");
});
