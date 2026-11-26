// Run after building the desktop app (window-harness.cjs): the right-click menus of the session rows and the
// side panel's tabs. Real mouse and key input, so Esc and a click outside are what close them.
// XSB_SCREENSHOTS=<folder> saves pictures of the menus there.
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
  const mouse = (type, x, y, button = "left") => win.webContents.sendInputEvent({ type, x, y, button, clickCount: 1 });
  const rightClick = async (sel) => {
    const [x, y] = await js("(()=>{const r=" + q(sel) + ".getBoundingClientRect();return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)]})()");
    await mouse("mouseMove", x, y);
    await mouse("mouseDown", x, y, "right");
    await mouse("mouseUp", x, y, "right");
    await until(() => has(".context-menu:popover-open"), "context menu on " + sel);
  };
  const items = () => js('[...document.querySelectorAll(".context-menu [role=menuitem]")].map(b=>b.querySelector(".session-menu-name").textContent+(b.disabled?"(off)":""))');
  const choose = (label) => js('[...document.querySelectorAll(".context-menu [role=menuitem]")].find(b=>b.querySelector(".session-menu-name").textContent===' + JSON.stringify(label) + ").click()");
  const closed = (label) => until(async () => !(await has(".context-menu")), label);
  const count = () => js('document.querySelectorAll("#agents .row").length');
  const rowOf = async (agent) => "#agents .row:nth-child(" + ((await js("xsb.load().then(s=>s.agents.filter(a=>!a.workflowOwner).map(a=>a.id))")).indexOf(agent) + 1) + ")";
  win.show();
  win.focus();

  // A conversation on the scripted backend that has talked (the one the window opens with uses the machine's default).
  await until(() => has("#lanes .lane"), "first conversation");
  const talker = await js('xsb.newSession("mock")');
  await until(async () => (await count()) >= 2, "conversation listed");
  await click(await rowOf(talker.id));
  await send("#lanes .lane", "!say HELLO");
  await untilJS(q("#lanes .lane .entries") + '.innerText.includes("HELLO\\n")||' + q("#lanes .lane .output") + "?.textContent.includes('HELLO')", "reply");
  await untilJS(q(await rowOf(talker.id)) + ".querySelector('.state').dataset.state==='idle'", "turn over");
  assert.equal(await has(".session-delete"), false, "rows have no delete button");

  // Two web pages in the side panel.
  const open = () => js("xsb.openPage('about:blank', false, document.querySelector('#lanes .lane').dataset.session)");
  const page = await open(), other = await open();
  const pageTab = "#tabs .tab[data-id=" + JSON.stringify(page.id) + "]";
  await untilJS('document.querySelectorAll("#tabs .tab").length===2', "two tabs");
  await rightClick(pageTab);
  await shoot("tab-menu");
  assert.deepEqual(await items(), [text["web.reload"], text["tabs.copyUrl"] + "(off)", text["web.external"] + "(off)", text["web.detach"],
    text["tabs.close"], text["tabs.closeOthers"], text["tabs.closeRight"]], "web tab menu");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  await closed("Esc closes the menu");
  await rightClick(pageTab);
  await mouse("mouseDown", 700, 600);
  await mouse("mouseUp", 700, 600);
  await closed("a click outside closes the menu");
  assert.equal(await js('document.querySelectorAll("#tabs .tab").length'), 2, "the click outside did nothing else");
  // The tab that stays eases to its new width: a CSS transition on the same element (styles.css .tab, pages.js syncTabs).
  await js("(window.__kept = document.querySelector(" + JSON.stringify(pageTab) + "), document.head.append(Object.assign(document.createElement('style'), { id: 'slow', textContent: '.tab { transition-duration: 3s !important }' })), 0)");
  await rightClick(pageTab);
  await choose(text["tabs.closeOthers"]);
  await until(async () => !(await has("#tabs .tab[data-id=" + JSON.stringify(other.id) + "]")), "other tab closed");
  assert.equal(await js(q(pageTab) + ".getAttribute('aria-current')"), "true");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(await js("window.__kept.isConnected && window.__kept.getAnimations().some((a) => a.transitionProperty === 'flex-basis')"), "the remaining tab eases to its new width");
  await js("document.getElementById('slow').remove()");
  await rightClick(pageTab);
  assert.deepEqual((await items()).slice(-2), [text["tabs.closeOthers"] + "(off)", text["tabs.closeRight"] + "(off)"]);
  // The page in a window of its own (page.html): one header row as high as the main window's, then the page.
  await choose(text["web.detach"]);
  const { BrowserWindow } = require("electron");
  const pageWin = await until(() => BrowserWindow.getAllWindows().find((w) => w !== win && w.webContents.getURL().endsWith("page.html")), "page window");
  await until(() => pageWin.webContents.executeJavaScript("!!document.querySelector('#title') && document.readyState === 'complete'"), "page window ready");
  const header = await pageWin.webContents.executeJavaScript("(() => { const r = document.querySelector('.titlebar').getBoundingClientRect(), b = document.querySelector('#restore').getBoundingClientRect(); const mac = document.documentElement.dataset.platform === 'mac'; return [r.height, document.querySelector('#title').getBoundingClientRect().left >= (mac ? 72 : 0), b.right <= innerWidth, getComputedStyle(document.querySelector('.titlebar')).display] })()");
  // On macOS the title clears the window buttons (preferences.js sets data-platform for both windows).
  assert.deepEqual(header, [52, true, true, "flex"], "page window header");
  if (shots) fs.writeFileSync(path.join(shots, "page-window.png"), (await pageWin.capturePage()).toPNG());
  await pageWin.webContents.executeJavaScript("document.querySelector('#restore').click()");
  await until(() => pageWin.isDestroyed() || !pageWin.isVisible(), "page back in the main window");
  await rightClick(pageTab);
  await choose(text["tabs.close"]);
  await until(async () => !(await has(pageTab)), "tab closed");

  // An empty conversation goes without asking; one that has talked asks first, and the question is only that.
  const before = await count();
  const fresh = await js('xsb.newSession("mock")');
  await until(async () => (await count()) === before + 1, "empty conversation listed");
  await rightClick(await rowOf(fresh.id));
  await shoot("session-menu");
  assert.deepEqual(await items(), [text["rail.rename"], text["rail.delete"]]);
  await choose(text["rail.rename"]);
  await until(() => has("dialog[open] input"), "rename dialog");
  assert.equal(await js(q("dialog[open] input") + ".value"), fresh.name);
  assert.equal(await js(q("dialog[open] input") + ".selectionEnd"), fresh.name.length, "current name is selected");
  await closed("rename closes its context menu");
  win.focus();
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await until(async () => !(await has("dialog[open]")), "cancel rename with Esc");
  assert.equal((await js("xsb.load()")).agents.find(a => a.id === fresh.id).name, fresh.name);
  await click(await rowOf(fresh.id));
  await js(q("#lanes .lane .editor") + ".textContent='keep this draft';" + q("#lanes .lane .editor") + ".dispatchEvent(new InputEvent('input',{bubbles:true}))");
  await rightClick(await rowOf(fresh.id));
  await choose(text["rail.rename"]);
  await until(() => has("dialog[open] input"), "rename again");
  await js(q("dialog[open] input") + ".value='   '");
  await click("dialog[open] .primary");
  await untilJS(q("dialog[open] .error") + ".textContent===" + JSON.stringify(text["rail.rename.empty"]), "empty name rejected");
  const renamed = "改名后的对话";
  await js(q("dialog[open] input") + ".value=" + JSON.stringify(renamed) + ";" + q("dialog[open] input") + ".focus()");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  await until(async () => !(await has("dialog[open]")), "Enter saves rename");
  await untilJS(q(await rowOf(fresh.id)) + ".querySelector('strong').textContent===" + JSON.stringify(renamed), "renamed row");
  assert.equal(await js(q("#lanes .lane header strong") + ".textContent"), renamed, "open header updates");
  assert.equal(await js(q("#lanes .lane .editor") + ".textContent"), "keep this draft", "draft survives rename");
  const loaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  win.webContents.reload(); await loaded;
  await untilJS(q("#lanes .lane header strong") + "?.textContent===" + JSON.stringify(renamed), "rename survives reload");
  assert.equal(await js(q("#lanes .lane .editor") + ".textContent"), "keep this draft");
  await rightClick(await rowOf(fresh.id));
  await choose(text["rail.delete"]);
  await until(async () => (await count()) === before, "empty conversation deleted at once");
  assert.equal(await has("dialog[open]"), false);
  await rightClick(await rowOf(talker.id));
  await choose(text["rail.delete"]);
  await until(() => has("dialog[open]"), "a used conversation asks first");
  await shoot("delete-confirm");
  assert.equal(await js(q("dialog[open] p") + ".textContent"), text["rail.delete.body"]);
  await js(q("dialog[open] .btn.primary") + ".click()");
  await until(async () => (await count()) === before - 1, "used conversation deleted after confirming");
  // A renderer preview counts service calls: opening settings is passive; only its Check button probes Ark.
  const preview = new BrowserWindow({ show: false, width: 1100, height: 800 });
  try {
    await preview.loadFile(path.join(root, "packages/desktop/dist/renderer/index.html"), { query: { lang: "zh-CN" } });
    const pjs = code => preview.webContents.executeJavaScript(code);
    await until(() => pjs('!!document.querySelector("#lanes .lane")'), "settings preview ready");
    await pjs('window.arkChecks=0; window.cliChecks=0; const arkCheck=xsb.arkStatus, cliCheck=xsb.checkCli; xsb.arkStatus=(...args)=>{arkChecks++; return arkCheck(...args)}; xsb.checkCli=(...args)=>{cliChecks++; return cliCheck(...args)}; document.querySelector("#settings").click(); [...document.querySelectorAll(".settings-nav-item")].find(b=>b.textContent==="模型后端").click()');
    await until(() => pjs('!!document.querySelector(".ark-card")'), "Ark settings card");
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.deepEqual(await pjs('[arkChecks,cliChecks]'), [0, 0], "settings never start readiness probes");
    assert.equal(await pjs('document.querySelector(".ark-card .backend-badge").textContent'), "未检测");
    assert.equal(await pjs('document.querySelector(".ark-card").getAttribute("aria-busy")'), "false");
    assert.equal(await pjs('!!document.querySelector(".backend-check")'), false, "no repeated check assurances");
    assert.equal(await pjs('!!document.querySelector(".advanced-limits")'), false, "execution limits are removed from settings");
    await pjs('document.querySelector(".ark-card > .backend-actions > button.primary").click()');
    await until(() => pjs('document.querySelector(".ark-card .backend-badge").textContent==="已就绪"'), "explicit Ark check");
    assert.equal(await pjs('arkChecks'), 1);
    await pjs('document.querySelector(".settings-head .icon-btn").click(); document.querySelector("#settings").click(); [...document.querySelectorAll(".settings-nav-item")].find(b=>b.textContent==="模型后端").click()');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(await pjs('arkChecks'), 1, "reopening settings keeps the previous result without rechecking");
  } finally { preview.destroy(); }
  console.log("Electron + real Hub/ACP: session and tab context menus, rename/cancel/validation/reload with drafts, Esc and click-outside, delete with and without confirmation passed");
  console.log("Electron renderer: concise backend settings, removed execution limits and explicit-only Ark checks passed");
});
