// Run after building the desktop app. The child opens the actual Electron app,
// the real Hub daemon and a scripted ACP backend in an isolated workspace.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-window-"));
  try {
    const env = { ...process.env, XSB_TEST_NODE: process.execPath, XSB_TEST_PROFILE: scratch };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require("node:child_process").spawnSync(require("electron"), [__filename], {
      env,
      stdio: "inherit",
      timeout: 65000,
    });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } finally {
    const info = path.join(scratch, "project", ".xsb2", "run", "hub.json");
    if (fs.existsSync(info)) {
      try {
        process.kill(JSON.parse(fs.readFileSync(info, "utf8")).pid);
      } catch {}
    }
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 4 });
  }
  return;
}
const { app, BrowserWindow } = require("electron");
const root = path.resolve(__dirname, "../../.."),
  scratch = process.env.XSB_TEST_PROFILE;
app.setPath("userData", path.join(scratch, "profile"));
const workspace = path.join(scratch, "project");
fs.mkdirSync(path.join(workspace, ".xsb2"), { recursive: true });
process.env.XSB_HOME = path.join(scratch, "home");
fs.mkdirSync(process.env.XSB_HOME);
fs.writeFileSync(
  path.join(process.env.XSB_HOME, "config.json"),
  JSON.stringify({
    version: 1,
    backends: {
      mock: { command: process.env.XSB_TEST_NODE, args: [path.join(root, "packages/hub/test/mock-agent.ts")] },
    },
  }),
);
process.argv.splice(2, Infinity, workspace);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
async function until(check, label) {
  for (let n = 0; n < 200; n++) {
    const v = await check();
    if (v) return v;
    await wait(100);
  }
  throw Error("Timeout " + label + " " + (win ? await js("document.body.innerText.slice(0,3000)") : "no window"));
}
const js = (code) => win.webContents.executeJavaScript(code).catch(error => { throw new Error(code + " → " + error.message); });
const q = (sel) => "document.querySelector(" + JSON.stringify(sel) + ")";
const click = (sel) => js(q(sel) + ".click()");
const draft = async (lane, msg) => {
  await js(
    "(()=>{const e=" +
      q(lane + " .editor") +
      "; e.focus(); e.textContent=" +
      JSON.stringify(msg) +
      '; e.dispatchEvent(new InputEvent("input",{bubbles:true}));})()',
  );
};
const send = async (lane, msg) => {
  await draft(lane, msg);
  await click(lane + " .send");
};
const has = (sel) => js("!!" + q(sel));
const untilJS = (expr, label) => until(() => js(expr), label);
(async () => {
  await import(pathToFileURL(path.join(root, "packages/desktop/dist/app/main.js")).href);
  win = await until(() => BrowserWindow.getAllWindows()[0], "window");
  await untilJS('document.querySelector("#ws-name")?.textContent==="project"', "workspace");
  // A new conversation takes the backend of the last one (app.js `defaultBackend`); the first is asked for by name,
  // so that it is the scripted one, not an agent of the machine.
  const create = async () => {
    await js('xsb.newSession("mock")');
    await untilJS('!!document.querySelector("#lanes .lane")', "created session");
  };
  await create();
  const main = "#lanes .lane",
    panel = "#task-conversation .lane";
  assert.equal(await has("#overview"), false);
  assert.equal(await js(q(main + " .context-ring") + ".dataset.known"), "false");
  await click(main + " .model-settings");
  const pick = async (name, value) => {
    const control = q(main + " select[data-setting=" + name + "]");
    await untilJS("!" + control + ".disabled", "available " + name);
    await js(control + ".value=" + JSON.stringify(value) + ";" + control + ".dispatchEvent(new Event('change'))");
    await untilJS(q(main + " .model-settings") + ".textContent.includes(" + JSON.stringify(value) + ")", "applied " + value);
  };
  await pick("model", "studio");
  await pick("effort", "high");
  await click(main + " .model-settings");
  await send(main, "!model\n!usage 50000\n!say DIRECT");
  await untilJS(q(main + " .context-ring") + ".getAttribute('aria-valuenow')==='5'", "reported context");
  await untilJS(q(main + " .entries") + ".textContent.includes('model: studio')", "backend model selection");
  await untilJS(q(main + " .entries") + '.textContent.includes("DIRECT")', "direct conversation");
  await untilJS(
    '!document.querySelector("#tabs .tab button")?.innerText.includes("Workflow")',
    "simple task tabs",
  );
  fs.writeFileSync(path.join(workspace, "brief.md"), "Red coat");
  await send(main, '!call asset_put {"name":"costume","path":"brief.md"}');
  await until(() => has(".artifact-card"), "registered artifact");
  await click(".reference-action");
  assert.equal(await js(q(main + " .asset-ref") + ".textContent"), "costume · v1");
  await click(main + " .remove-ref");
  await click(".artifact-card");
  await untilJS('!document.querySelector("#asset-reference").hidden', "asset receipt");
  await click("#asset-reference");
  assert.equal(await js(q(main + " .asset-ref") + ".textContent"), "costume · v1");
  await click(main + " .send");
  const receipt = '<asset>{"name":"costume","version":"v1"}</asset>';
  await untilJS(q(main + " .entry.input .said .chip") + "?.textContent==='costume · v1'", "sent version chip");
  const snapshot = await js("xsb.load()");
  assert.ok(Object.values(snapshot.transcripts).flat().some(e => e.kind === "input" && e.content.some(b => b.text?.includes(receipt))));
  await draft(main, "  line one\n\nline two  ");
  await click("#asset-reference");
  await click("#artifact-info");
  await create();
  const first = "#agents .row:first-child", second = "#agents .row:nth-child(2)";
  assert.equal(await has(".artifact-card"), false);
  assert.equal(await js(q(".catalog-controls") + ".hidden"), true);
  assert.equal(await js(q(main + " .editor") + ".textContent"), "");
  await send(main, "!say [Brief](brief.md)");
  await until(() => has(main + " .output a"), "ordinary file link");
  await click(main + " .output a");
  await untilJS(q("#artifact-name") + ".textContent==='brief.md'", "file preview");
  await click("#asset-reference");
  assert.equal(await js(q(main + " .editor .chip") + ".textContent"), "brief.md");
  await click(main + " .send");
  await until(() => has(main + " .said .chip"), "ordinary file sent");
  const ordinary = await js("xsb.load()");
  assert.ok(Object.values(ordinary.transcripts).flat().some(e => e.kind === "input" && e.content.some(b => b.type === "resource_link" && b.uri === pathToFileURL(path.join(workspace, "brief.md")).href)));
  await draft(main, "second session draft");
  await click(first);
  assert.equal(await js(q("#artifact-name") + ".textContent"), "costume.md");
  assert.equal(await js(q("#artifact-details") + ".hidden"), false);
  assert.equal(await js(q(main + " .editor") + ".textContent.replace('costume · v1','')"), "  line one\n\nline two  ");
  await untilJS(q(main + " .model-settings") + ".textContent.includes('studio · high')", "restored settings");
  assert.equal(await js(q(main + " .context-ring") + ".getAttribute('aria-valuenow')"), "5");
  await click("#artifact-details-close");
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
  const finish = (s) => "!call finish " + JSON.stringify({ summary: s, assets: [] });
  const rows = [
    { node: "A", prompt: "!sleep 9000\n" + finish("A done") },
    { node: "B", prompt: finish("B done") },
    { node: "end", kind: "end" },
    { from: "A", to: "B" },
    { from: "B", to: "end" },
  ];
  await send(
    main,
    "!call execute " + JSON.stringify({ graphJsonl: rows.map((v) => JSON.stringify(v)).join("\n") }),
  );
  await untilJS(
    'document.querySelectorAll(".dag-node").length===3 && !document.querySelector(".dag-node").disabled',
    "DAG",
  );
  assert.equal(await js('document.querySelectorAll(".dag-node")[1].disabled'), true);
  await click(".dag-node:disabled");
  assert.equal(await has(panel), false);
  await click(".dag-node:not(:disabled)");
  await until(() => has(panel), "task chat");
  await click(panel + " .task-control");
  await untilJS(q(panel + " .task-control") + ".innerText.match(/Resume|继续/)!=null", "task stop");
  await send(panel, "!say SIDE-ONLY");
  await untilJS(q(panel + " .entries") + '.innerText.includes("SIDE-ONLY")', "task conversation");
  assert.equal(await js(q(main + " .entries") + '.innerText.includes("SIDE-ONLY")'), false);
  await click(panel + " .task-control");
  await untilJS(q(panel + " .task-control") + ".innerText.match(/Stop|停止/)!=null", "task resume");
  await draft(main, "main-only");
  await draft(panel, "task-only");
  await click(".catalog-tab button");
  await click(".reference-action");
  await untilJS("!" + q("#side-workflow") + ".hidden", "reference opens task composer");
  assert.equal(await has(panel + " .asset-ref"), true);
  assert.equal(await has(main + " .asset-ref"), false);
  await click(second);
  assert.equal(await has(panel), false);
  await click("#agents .row");
  await untilJS('!!document.querySelector("#task-conversation .editor")', "task restored");
  assert.equal(await js(q(panel + " .editor") + ".textContent.replace('costume · v1','')"), "task-only");
  assert.equal(await js(q(main + " .editor") + ".textContent"), "main-only");
  const loaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  win.webContents.reload();
  await loaded;
  await until(() => has(panel + " .asset-ref"), "window reload restores task and asset draft");
  assert.equal(await js(q(main + " .editor") + ".textContent"), "main-only");
  await click(second);
  assert.equal(await js(q(main + " .editor") + ".textContent"), "second session draft");
  if (page) assert.equal(await js(q("#side-web") + ".hidden"), false);
  console.log(
    "Electron + real Hub/ACP: new session, direct chat, DAG, disabled nodes, isolated task prompt, stop/resume, session-scoped artifacts, web tabs, drafts, exact references, model/effort and usage passed",
  );
})().then(
  () => app.exit(0),
  (e) => {
    console.error(e);
    app.exit(1);
  },
);
