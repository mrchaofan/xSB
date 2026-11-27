// Run after building the desktop app (window-harness.cjs): new session, direct chat, workflow DAG, task chat, drafts.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
require("./window-harness.cjs").windowTest(__filename, async ({ win, js, q, click, draft, send, has, until, untilJS, workspace }) => {
  // A new conversation takes the backend of the last one (app.js `defaultBackend`); the first is asked for by name,
  // so that it is the scripted one, not an agent of the machine.
  let created = false;
  const create = async () => {
    await untilJS('!!document.querySelector("#lanes .lane")', "initial session");
    if (!created) {
      await js('xsb.setBackend(document.querySelector("#lanes .lane").dataset.agent,"mock")');
      created = true;
    } else {
      const prior = await js(q("#lanes .lane") + ".dataset.agent");
      await click("#new-agent");
      await untilJS(q("#lanes .lane") + ".dataset.agent!==" + JSON.stringify(prior), "created session");
    }
  };
  await create();
  const main = "#lanes .lane",
    panel = "#task-conversation .lane";
  assert.equal(await has("#overview"), false);
  assert.equal(await js(q(main + " .context-ring") + ".dataset.known"), "false");
  await click(main + " .model-settings");
  const pick = async (name, value) => {
    if (!(await has(main + " .composer-menu:popover-open"))) await click(main + " .model-settings");
    const row = main + " .cascade-row[data-name=" + name + "]";
    await until(() => has(row + " .cascade-sub button:not(:disabled)"), "available " + name);
    await click(row + " .cascade-parent");
    await js('[...document.querySelectorAll(' + JSON.stringify(row + " .cascade-sub button") + ')].find(b=>b.textContent.trim()===' + JSON.stringify(value) + ').click()');
    await untilJS(q(main + " .model-settings") + ".textContent.includes(" + JSON.stringify(value) + ")", "applied " + value);
  };
  await pick("model", "studio");
  await pick("effort", "high");
  await send(main, "!model\n!usage 50000\n!say DIRECT");
  await untilJS(q(main + " .context-ring") + ".getAttribute('aria-valuenow')==='5'", "reported context");
  await untilJS(q(main + " .entries") + ".textContent.includes('model: studio')", "backend model selection");
  await untilJS(q(main + " .entries") + '.textContent.includes("DIRECT")', "direct conversation");
  await untilJS(
    '!document.querySelector("#tabs .tab button")?.innerText.includes("Workflow")',
    "simple task tabs",
  );
  const costume = path.join(fs.realpathSync(workspace), "costume.md");
  const ignored = path.join(fs.realpathSync(workspace), "read-only.md");
  fs.writeFileSync(costume, "Red coat");
  fs.writeFileSync(ignored, "Input only");
  const tool = (id, fields) => "!update " + JSON.stringify({ sessionUpdate: "tool_call_update", toolCallId: id, ...fields });
  const report = (id, changes) => tool(id, { title: "Edit files", kind: "edit", status: "completed", content: [{ type: "diff", changes }] });
  const add = { type: "diff", changes: [{ operation: "add", path: costume }], patch: { format: "git_patch", text: "" } };
  await send(main, [
    tool("read", { title: "Read", kind: "read", status: "completed", locations: [{ path: ignored }] }),
    tool("failed", { title: "Edit", kind: "edit", status: "failed", content: [{ ...add, changes: [{ operation: "modify", path: ignored }] }] }),
    tool("write", { title: "Edit", kind: "edit", status: "in_progress", content: [add] }),
    tool("write", { status: "completed" }),
  ].join("\n"));
  await untilJS(q(main + " .changed-file") + "?.innerText.includes('costume.md')", "successful ACP edit appears in the conversation");
  await click("#side-launcher .launcher-item:nth-of-type(2)");
  await untilJS(q(".artifact-card") + "?.innerText.includes('costume.md')", "Files lists the edited file");
  assert.equal(await js('document.querySelectorAll(".artifact-card").length'), 1);
  await click(".artifact-card");
  await untilJS(q("#artifact-body .md") + "?.textContent.includes('Red coat')", "preview the written file");
  fs.writeFileSync(costume, "Blue coat");
  await send(main, report("edit-preview", [{ operation: "modify", path: costume }]));
  await untilJS(q("#artifact-body .md") + "?.textContent.includes('Blue coat')", "editing a file refreshes the open preview");
  await click("#file-reference");
  assert.equal(await js(q(main + " .editor .file-ref") + ".title"), costume);
  await click(main + " .send");
  await until(() => has(main + " .said .file-ref"), "send a normal file attachment");
  await draft(main, "  line one\n\nline two  ");
  await click("#file-reference");
  await create();
  const first = "#agents .row:first-child", second = "#agents .row:nth-child(2)";
  assert.equal(await has(".artifact-card"), false);

  assert.equal(await js(q(main + " .editor") + ".textContent"), "");
  fs.writeFileSync(path.join(workspace, "notes.md"), "Working notes");
  const zip = path.join(workspace, "bundle.zip");
  fs.writeFileSync(zip, Buffer.from([0x50, 0x4b, 3, 4, 0xff, 0]));
  await send(main, "!say [Archive](bundle.zip) [Notes](notes.md:12) [Drive](C:/docs/notes.md)");
  const archiveLink = main + ' .output a[href="bundle.zip"]';
  await until(() => has(archiveLink), "ordinary file links");
  assert.ok(await has(main + ' .output a[data-file-href="C:/docs/notes.md"]'), "Windows paths survive Markdown sanitization");
  const { shell } = require("electron");
  let revealed;
  const showItem = shell.showItemInFolder;
  shell.showItemInFolder = file => { revealed = file; };
  try {
    await click("#toggle-artifact");
    await click(archiveLink);
    const revealAction = "#artifact-body .web-note .btn.primary";
    await until(() => has(revealAction), "primary folder action in the sidebar content");
    assert.ok(await js(q("#artifact-body") + ".checkVisibility()"), "the link reveals the side panel");
    assert.equal(await js(q("#artifact-name") + ".textContent"), "bundle.zip");
    assert.equal(await has("#artifact-body pre"), false);
    assert.equal(revealed, undefined);
    await click(revealAction);
    await until(() => revealed, "showing the selected file in its folder");
    assert.equal(fs.realpathSync(revealed), fs.realpathSync(zip));
  } finally { shell.showItemInFolder = showItem; }
  await click(main + ' .output a[data-file-href="notes.md:12"]');
  await untilJS(q("#artifact-name") + ".textContent==='notes.md'", "file preview");
  await untilJS(q("#artifact-body .md") + "?.textContent.includes('Working notes')", "rendered Markdown in sidebar");
  assert.equal(await has("#artifact-details"), false);
  assert.ok(await js(q("#artifact-reveal") + ".checkVisibility()"), "folder action is on the preview toolbar");
  await click("#file-reference");
  assert.equal(await js(q(main + " .editor .chip") + ".textContent"), "notes.md");
  await click(main + " .send");
  await until(() => has(main + " .said .chip"), "ordinary file sent");
  const ordinary = await js("xsb.load()");
  assert.ok(Object.values(ordinary.transcripts).flat().some(e => e.kind === "input" && e.content.some(b => b.type === "resource_link" && b.uri === pathToFileURL(fs.realpathSync(path.join(workspace, "notes.md"))).href)));
  await draft(main, "second session draft");
  await click(first);
  assert.equal(await js(q("#artifact-name") + ".textContent"), "costume.md");
  assert.equal(await js(q(main + " .editor") + ".textContent.replace('costume.md','')"), "  line one\n\nline two  ");
  await untilJS(q(main + " .model-settings") + ".textContent.includes('studio · high')", "restored settings");
  assert.equal(await js(q(main + " .context-ring") + ".getAttribute('aria-valuenow')"), "5");
  await click("#artifact-list");
  await js(q(".artifact-search") + ".value='costume';" + q(".artifact-search") + ".dispatchEvent(new Event('input'))");
  await click(second);
  assert.equal(await js(q(main + " .editor") + ".textContent"), "second session draft");
  assert.equal(await js(q(main + " .context-ring") + ".dataset.known"), "false");
  const page = await js("xsb.openPage('about:blank', false, document.querySelector('#lanes .lane').dataset.session)");
  if (page) await untilJS("!" + q("#side-web") + ".hidden", "web tab");
  await click(first);
  assert.equal(await js(q(".artifact-search") + ".value"), "costume");
  assert.equal(await js(q("#side-web") + ".hidden"), true);
  await click(second);
  if (page) assert.equal(await js(q("#side-web") + ".hidden"), false);
  await click(first);
  await js("(()=>{const editor=" + q(main + " .editor") + ";const old=File.prototype.arrayBuffer;File.prototype.arrayBuffer=async function(){await new Promise(r=>window.releaseDrop=r);return old.call(this)};window.restoreFile=()=>File.prototype.arrayBuffer=old;const dt=new DataTransfer();dt.items.add(new File([new Uint8Array([137,80,78,71,13,10,26,10])],'draft.png',{type:'image/png'}));editor.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true}));})()");
  await untilJS("typeof window.releaseDrop==='function'", "paste reading");
  await click(second); await click(first);
  await draft(main, "typed while reading");
  await js("window.releaseDrop();void window.restoreFile()");
  await until(() => has(main + " .editor img"), "image restored to original draft");
  assert.equal(await js(q(main + " .editor") + ".textContent"), "typed while reading");
  const finish = (s) => "!call finish " + JSON.stringify({ summary: s });
  const rows = [
    { node: "起草", prompt: "!sleep 9000\n" + finish("起草完成") },
    { node: "审阅", prompt: finish("审阅完成") },
    { node: "完成", kind: "end" },
    { from: "起草", to: "审阅" },
    { from: "审阅", to: "完成" },
  ];
  await send(
    main,
    "!call execute " + JSON.stringify({ graphJsonl: rows.map((v) => JSON.stringify(v)).join("\n") }),
  );
  await untilJS(
    'document.querySelectorAll(".dag-node").length===3 && !!document.querySelector(".dag-node:not(:disabled)")',
    "DAG",
  );
  // The global icon size must not clip the DAG's curved edges to a 16 × 16 viewport.
  const drawing = await js(`(() => {
    const surface = document.querySelector(".dag-surface"), svg = surface.querySelector("svg");
    return {
      surface: [surface.clientWidth, surface.clientHeight],
      viewport: [svg.clientWidth, svg.clientHeight],
      edges: [...svg.querySelectorAll("path")].map(path => {
        const box = path.getBBox(), style = getComputedStyle(path);
        return { curved: path.getAttribute("d").includes("C"), right: box.x + box.width, bottom: box.y + box.height,
          stroke: style.stroke, width: parseFloat(style.strokeWidth) };
      }),
    };
  })()`);
  assert.deepEqual(drawing.viewport, drawing.surface);
  assert.equal(drawing.edges.length, 2);
  for (const edge of drawing.edges) {
    assert.ok(edge.curved && edge.stroke !== "none" && edge.width > 0);
    assert.ok(edge.right <= drawing.viewport[0] && edge.bottom <= drawing.viewport[1], "edge is inside the SVG viewport");
  }
  assert.equal(await js('document.querySelectorAll(".dag-node")[1].disabled'), true);
  await click(".dag-node:disabled");
  assert.equal(await has(panel), false);
  await click(".dag-node:not(:disabled)");
  await until(() => has(panel), "task chat");
  await untilJS(q(panel + " .input .said h1") + "?.textContent.match(/Workflow task|工作流任务/)!=null", "readable assignment title");
  const assignmentSource = await js(`xsb.load().then(snapshot => snapshot.transcripts[${q(panel)}.dataset.agent].find(entry => entry.kind === "input" && entry.origin.kind === "system").content[0].text)`);
  assert.ok(assignmentSource.includes(rows[0].prompt), "the exact task instructions remain in the sent Markdown");
  assert.equal(await js(q(panel + " .input .said details") + ".open"), false, "internal assignment identifiers start collapsed");
  await click(panel + " .task-control");
  await untilJS(q(panel + " .task-control") + ".innerText.match(/Resume|继续/)!=null", "task stop");
  await send(panel, "!say SIDE-ONLY");
  await untilJS(q(panel + " .entries") + '.innerText.includes("SIDE-ONLY")', "task conversation");
  assert.equal(await js(q(main + " .entries") + '.innerText.includes("SIDE-ONLY")'), false);
  await click(panel + " .task-control");
  await untilJS(q(panel + " .task-control") + ".innerText.match(/Stop|停止/)!=null", "task resume");
  // 空闲又无可继续时 syncLane 把按钮设成 hidden；.btn 的 display 不能盖过 [hidden]，否则“空闲”旁边还挂着“停止任务”。
  assert.equal(await js(`(b => { const was = b.hidden; b.hidden = true; const shown = getComputedStyle(b).display; b.hidden = was; return shown; })(${q(panel + " .task-control")})`), "none", "hidden task control is not displayed");
  await draft(main, "main-only");
  await draft(panel, "task-only");
  await click('#tabs .tab[data-id="catalog"] .tab-main');
  await click(".artifact-card");
  await untilJS("!" + q("#file-reference") + ".hidden && !" + q("#reference-destination") + ".hidden", "reference controls together");
  const referenceLayout = await js(`(() => {
    const row = document.querySelector("#artifact-references"), button = document.querySelector("#file-reference"), target = document.querySelector("#reference-destination");
    const r = row.getBoundingClientRect(), b = button.getBoundingClientRect(), t = target.getBoundingClientRect();
    return { grouped: button.parentElement === row && target.parentElement === row, aligned: Math.abs(b.top + b.height / 2 - t.top - t.height / 2) < 1, fits: b.right <= r.right && t.left >= r.left, capture: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } };
  })()`);
  assert.ok(referenceLayout.grouped && referenceLayout.aligned && referenceLayout.fits, "reference target and action share one row without overflow");
  if (process.env.XSB_SCREENSHOTS) fs.writeFileSync(path.join(process.env.XSB_SCREENSHOTS, "references.png"), (await win.capturePage(referenceLayout.capture)).toPNG());
  await click("#file-reference");
  await untilJS("!" + q("#side-workflow") + ".hidden", "reference opens task composer");
  assert.equal(await has(panel + " .editor .file-ref"), true);
  assert.equal(await has(main + " .editor .file-ref"), false);
  await click(second);
  assert.equal(await has(panel), false);
  await click("#agents .row");
  await untilJS('!!document.querySelector("#task-conversation .editor")', "task restored");
  assert.equal(await js(q(panel + " .editor") + ".textContent.replace('costume.md','')"), "task-only");
  assert.equal(await js(q(main + " .editor") + ".textContent"), "main-only");
  const loaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  win.webContents.reload();
  await loaded;
  await until(() => has(panel + " .editor .file-ref"), "window reload restores task and file reference draft");
  assert.equal(await js(q(main + " .editor") + ".textContent"), "main-only");
  await click(second);
  assert.equal(await js(q(main + " .editor") + ".textContent"), "second session draft");
  if (page) assert.equal(await js(q("#side-web") + ".hidden"), false);
  const result = { checked: false, evidence: ["<strong>plain data</strong>", null], count: 2 };
  const summary = "Evidence checked in [notes](notes.md).";
  const nodeFile = path.join(fs.realpathSync(workspace), "review.md");
  fs.writeFileSync(nodeFile, "Node review");
  const graph = [
    { node: "Inspect", prompt: [report("task-write", [{ operation: "add", path: nodeFile }]),
        "!call finish " + JSON.stringify({ summary, result })].join("\n"), input: { material: "notes.md" } },
    { node: "End", kind: "end" }, { from: "Inspect", to: "End" },
  ];
  await send(main, '!call execute ' + JSON.stringify({ graphJsonl: graph.map(row => JSON.stringify(row)).join("\n") }));
  const publication = main + ' .publication[data-origin="plugin"][data-source="workflow"]';
  await until(() => has(publication), "finished workflow publishes to the owner's transcript");
  assert.ok((await js(q(publication + " .publication-source") + ".textContent")).trim());
  const displayed = await js(q(publication + " .content") + ".innerText");
  assert.match(displayed, /Inspect/);
  assert.match(displayed, /Evidence checked/);
  assert.ok(["checked", "false", "<strong>plain data</strong>", "null"].every(value => displayed.includes(value)), "nested structured values are fully readable");
  const follow = label => js(`[...document.querySelectorAll(${JSON.stringify(publication + " a")})].find(a => a.textContent === ${JSON.stringify(label)}).click()`);
  await follow("notes");
  await untilJS(q("#artifact-name") + ".textContent==='notes.md'", "published Markdown link selects the source file");
  await untilJS(q("#artifact-body .md") + "?.textContent.includes('Working notes')", "published Markdown link opens file preview");
  const reloaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  win.webContents.reload();
  await reloaded;
  await until(() => has(publication), "published body survives a renderer reload");
  assert.equal(await js(q(publication + " .content") + ".innerText"), displayed);
  assert.equal(await js(`document.querySelectorAll(${JSON.stringify(publication)}).length`), 1);
  await click("#artifact-list");
  const listed = (name) => js('[...document.querySelectorAll(".artifact-card strong")].some(el => el.textContent === ' + JSON.stringify(name) + ')');
  await until(() => listed("review.md"), "the Files panel reconstructs a task agent's edit after reload");
  assert.equal(await listed("notes.md"), false, "file links opened from chat do not enter Files");
  const renamed = path.join(path.dirname(nodeFile), "final review.md");
  await js(`(() => {
    const search = document.querySelector(".artifact-search");
    search.value = "review";
    search.dispatchEvent(new Event("input"));
    search.focus();
  })()`);
  fs.renameSync(nodeFile, renamed);
  const move = report("move", [{ operation: "move", oldPath: nodeFile, path: renamed }]);
  await js('xsb.send(' + q(main) + '.dataset.agent,' + JSON.stringify([{ type: "text", text: move }]) + ')');
  await until(() => listed("final review.md"), "move updates the open Files panel");
  assert.equal(await js('document.activeElement === document.querySelector(".artifact-search")'), true);
  assert.equal(await js(q(".artifact-search") + ".value"), "review");
  assert.equal(await listed("review.md"), false);
  await click(".artifact-card");
  await untilJS(q("#artifact-body .md") + "?.textContent.includes('Node review')", "preview the moved file");
  fs.unlinkSync(renamed);
  await send(main, report("remove", [{ operation: "delete", path: renamed }]));
  await until(() => has("#artifact-body .file-unavailable"), "deleting the open file clears the preview");
  assert.equal(await has("#artifact-body .md"), false);
  assert.ok(await js(q("#artifact-references") + ".hidden && " + q("#artifact-reveal") + ".disabled"));
  await click("#artifact-list");
  await until(() => has("#artifact-body .artifact-browser"), "file list restored");
  await until(async () => !(await listed("final review.md")), "delete removes the file");

  const shape = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
  const cents = { type: "integer", description: "Amount in cents" };
  const contracts = [
    { node: "Calculate", prompt: '!call finish {"summary":"Checked the order","result":{"amount":0}}',
      input: { order: "Free sample" }, inputSchema: shape({ order: { type: "string" } }), schema: shape({ amount: cents }) },
    { node: "Bill", kind: "end", inputSchema: shape({ cents }) },
    { from: "Calculate", to: "Bill", bind: { cents: "/amount" } },
  ];
  const graphArgs = rows => JSON.stringify({ graphJsonl: rows.map(row => JSON.stringify(row)).join("\n") });
  await send(main, "!call plan " + graphArgs(contracts));
  await click('#tabs .tab[data-id="workflow"] .tab-main');
  await until(() => has(".flow-plans button:last-child"), "candidate contract plan");
  await click(".flow-plans button:last-child");
  const bill = '.dag-node[data-node="Bill"]';
  const rawContract = () => js("JSON.parse(" + q("#flow-contract .contract-raw pre") + ".textContent)");
  await click(bill);
  const version = await js(q("#flow-contract") + ".dataset.version");
  assert.match(await js(q("#flow-contract .contract-source") + ".textContent"), /Calculate.*\/amount/);
  assert.deepEqual((await rawContract()).bindings[0].bind, { cents: "/amount" });
  assert.equal((await rawContract()).input, undefined, "planned input has no invented value");
  await click('.dag-node[data-node="Calculate"]');
  assert.match(await js(q("#flow-contract .contract-field pre") + ".textContent"), /Free sample/);
  assert.match(await js(q('#flow-contract [data-part="expected"]') + ".innerText"), /amount/);
  await send(main, "!call execute {}");
  const atEnd = bill + '[data-state="completed"]';
  await until(() => has(atEnd), "end node publishes its bound input");
  await click(atEnd);
  const accepted = await rawContract();
  assert.deepEqual(accepted.input, { cents: 0 });
  assert.deepEqual(accepted.result, { cents: 0 });
  assert.equal(accepted.inputSources.cents.node, "Calculate");
  assert.equal(accepted.inputSources.cents.pointer, "/amount");
  assert.ok(accepted.inputSources.cents.delivery);
  await untilJS(`[...document.querySelectorAll(${JSON.stringify(publication + " .content")})].some(el => el.innerText.includes("cents") && el.innerText.includes("0") && el.querySelector("details"))`, "named final result is visible before collapsed contributing tasks");
  const missingAmount = [
    { ...contracts[0], node: "ReadAmount", prompt: '!call finish {"summary":"Checked","result":{}}', schema: { ...shape({ amount: cents }), required: [] } },
    { ...contracts[1], node: "Quote" }, { from: "ReadAmount", to: "Quote", bind: { cents: "/amount" } },
  ];
  await send(main, "!call execute " + graphArgs(missingAmount));
  const invalid = '.dag-node[data-node="Quote"][data-state="input_error"]';
  await until(() => has(invalid), "binding error is visible on the blocked node");
  await click(invalid);
  const errorMessage = await js(q('#flow-contract [role="alert"]') + ".textContent");
  assert.ok(["ReadAmount", "/amount", "Quote", "cents"].every(field => errorMessage.includes(field)));
  assert.equal((await rawContract()).result, undefined);
  await untilJS(`[...document.querySelectorAll("#flow-heading select option")].some(o => o.value === ${JSON.stringify(version)})`, "contract snapshot kept in history");
  await js(`(() => { const select = document.querySelector("#flow-heading select"); select.value = ${JSON.stringify(version)}; select.dispatchEvent(new Event("change")); })()`);
  await click(bill);
  assert.deepEqual(await rawContract(), accepted, "history shows the same exact input, delivery and provenance");
  console.log(
    "Electron + real Hub/ACP: direct chat, DAG, task prompts, stop/resume, native files, web tabs, drafts, model/effort, usage, publication and candidate/active/history node contracts passed",
  );
});
