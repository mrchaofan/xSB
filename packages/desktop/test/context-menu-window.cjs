// Run after building the desktop app (window-harness.cjs): the right-click menus of the session rows and the
// side panel's tabs. Real mouse and key input, so Esc and a click outside are what close them. A tab's menu is drawn in the
// window's overlay (src/overlay.ts), a view over the window and its web pages, which closes itself.
// XSB_SCREENSHOTS=<folder> saves pictures of the menus there.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");

require("./window-harness.cjs").windowTest(__filename, async ({ win, js, q, click, send, has, until, untilJS, root, workspace }) => {
  const text = (await import(pathToFileURL(path.join(root, "packages/desktop/renderer/text.js")).href)).TEXT[await js("xsb.language")];
  const shots = process.env.XSB_SCREENSHOTS;
  // Session menus use a real Electron Menu. Control only popup completion so this test
  // verifies IPC/item routing without depending on the OS's nested menu event loop.
  const { BrowserWindow, Menu, webContents } = require("electron");
  let nativeMenu, finishMenu;
  Menu.prototype.popup = function(options) {
    nativeMenu = this;
    assert.equal(options.window, win);
    assert.ok(Number.isInteger(options.x) && Number.isInteger(options.y));
    finishMenu = () => { nativeMenu = null; options.callback(); };
  };
  const shoot = async (name) => {
    if (!shots) return;
    await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    fs.writeFileSync(path.join(shots, name + ".png"), (await win.capturePage()).toPNG());
  };
  // sendInputEvent bypasses the native hit test. A click in the window chrome first activates its document.
  const mouse = (type, x, y, button = "left") => {
    if (type === "mouseDown") { win.focus(); win.webContents.focus(); }
    win.webContents.sendInputEvent({ type, x, y, button, clickCount: 1 });
  };
  const leftClick = async (sel) => {
    const [x, y] = await js("(()=>{const r=" + q(sel) + ".getBoundingClientRect();return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)]})()");
    await mouse("mouseMove", x, y);
    await mouse("mouseDown", x, y);
    await mouse("mouseUp", x, y);
  };
  const rightClick = async (sel) => {
    const [x, y] = await js("(()=>{const r=" + q(sel) + ".getBoundingClientRect();return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)]})()");
    await mouse("mouseMove", x, y);
    await mouse("mouseDown", x, y, "right");
    await mouse("mouseUp", x, y, "right");
    await until(async () => sel.startsWith("#agents") ? nativeMenu : overlay() && !overlay().webContents.isLoadingMainFrame() && await inOverlay("!!document.querySelector('.overlay-menu')"), "context menu on " + sel);
    if (sel.startsWith("#agents")) assert.equal(!!overlay(), false, "session menu uses the OS");
    else assert.equal(win.contentView.children.at(-1), overlay(), "the menu is over everything, web pages included");
  };
  const overlay = () => win.contentView.children.find((view) => view.webContents.getURL().endsWith("overlay.html"));
  const inOverlay = (code) => overlay().webContents.executeJavaScript(code);
  const items = () => nativeMenu ? nativeMenu.items.map(item => item.label + (item.enabled ? "" : "(off)")) : inOverlay('[...document.querySelectorAll(".context-menu [role=menuitem]")].map(b=>b.querySelector(".session-menu-name").textContent+(b.disabled?"(off)":""))');
  const choose = (label) => {
    if (nativeMenu) {
      const item = nativeMenu.items.find(item => item.label === label);
      assert.ok(item?.enabled);
      item.click(item, win, {});
      finishMenu();
      return;
    }
    return inOverlay('[...document.querySelectorAll(".context-menu [role=menuitem]")].find(b=>b.querySelector(".session-menu-name").textContent===' + JSON.stringify(label) + ").click()");
  };
  const closed = (label) => until(() => !overlay(), label);
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
  assert.ok(overlay().webContents.isFocused(), "the menu takes the keyboard");
  assert.deepEqual(await items(), [text["web.reload"], text["tabs.copyUrl"] + "(off)", text["web.external"] + "(off)", text["web.detach"],
    text["tabs.close"], text["tabs.closeOthers"], text["tabs.closeRight"]], "web tab menu");
  overlay().webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  await closed("Esc closes the menu");
  await until(() => win.webContents.isFocused(), "the keyboard back in the window");
  await rightClick(pageTab);
  // Outside the menu is the overlay's own backdrop: the click closes it and lands nowhere else.
  for (const type of ["mouseDown", "mouseUp"]) overlay()?.webContents.sendInputEvent({ type, x: 700, y: 600, button: "left", clickCount: 1 });
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
  const pageWin = await until(() => BrowserWindow.getAllWindows().find((w) => w !== win && w.webContents.getURL().endsWith("page.html")), "page window");
  await until(() => pageWin.webContents.executeJavaScript("!!document.querySelector('#title') && document.readyState === 'complete'"), "page window ready");
  const header = await pageWin.webContents.executeJavaScript("(() => { const r = document.querySelector('.titlebar').getBoundingClientRect(), b = document.querySelector('#restore').getBoundingClientRect(); const mac = document.documentElement.dataset.platform === 'mac'; return [r.height, document.querySelector('#title').getBoundingClientRect().left >= (mac ? 72 : 0), b.right <= innerWidth, getComputedStyle(document.querySelector('.titlebar')).display] })()");
  // On macOS the title clears the window buttons (preferences.js sets data-platform for both windows).
  assert.deepEqual(header, [52, true, true, "flex"], "page window header");
  if (shots) fs.writeFileSync(path.join(shots, "page-window.png"), (await pageWin.capturePage()).toPNG());
  await pageWin.webContents.executeJavaScript("document.querySelector('#restore').click()");
  await until(() => pageWin.isDestroyed() || !pageWin.isVisible(), "page back in the main window");

  // A modal in the window's document covers the page, including its cutout.
  const site = await until(() => win.contentView.children.find(v => v.webContents.getURL() === "about:blank"), "restored web page");
  const hole = () => js("getComputedStyle(document.body).maskImage");
  assert.match(await hole(), /linear-gradient/);
  await click("#tabs button[aria-label=" + JSON.stringify(text["tabs.opened"]) + "]");
  await until(() => !win.contentView.children.includes(site), "the page yields to the open tab list");
  assert.equal(await hole(), "none");
  await click("dialog.tabs-dialog .actions button");
  await until(() => win.contentView.children.includes(site), "closing the tab list restores the same page");
  assert.match(await hole(), /linear-gradient/);

  // HTML previews and browser tabs share the native page slot. Keep the preview's live document across switches.
  fs.writeFileSync(path.join(workspace, "preview.html"), '<!doctype html><input id="draft">');
  await send("#lanes .lane", "!say [Preview](preview.html)");
  const link = "#lanes .lane .output a";
  await until(() => has(link), "HTML file link");
  await click(link);
  const artifactTab = '#tabs .tab[data-id^="artifact:"]';
  const previewView = await until(() => win.contentView.children.find(v => v.webContents.getURL().startsWith("xsb-artifact:")), "HTML preview shown");
  const previewId = previewView.webContents.id;
  await previewView.webContents.executeJavaScript("document.querySelector('#draft').value = 'retained'");
  await click(pageTab + " .tab-main");
  await until(() => win.contentView.children.includes(site), "browser tab shown");
  await click(artifactTab + " .tab-main");
  await until(() => win.contentView.children.includes(previewView), "HTML preview reattached");
  assert.equal(await previewView.webContents.executeJavaScript("document.querySelector('#draft').value"), "retained");

  const { shell } = require("electron");
  const originalReveal = shell.showItemInFolder;
  let revealed;
  try {
    shell.showItemInFolder = file => { revealed = file; };
    assert.equal(await js(q(".artifact-toolbar #artifact-reveal") + ".title"), text["artifact.reveal"]);
    await click(".artifact-toolbar #artifact-reveal");
    await until(() => revealed, "revealing a supported file directly from the preview toolbar");
    assert.equal(fs.realpathSync(revealed), fs.realpathSync(path.join(workspace, "preview.html")));
  } finally { shell.showItemInFolder = originalReveal; }

  // Leave before the new preview's IPC reply. The visible browser tab must still track layout changes.
  await click('#artifact-modes [data-mode="source"]');
  await until(() => has("#artifact-body pre.source"), "HTML source loaded");
  await js(q('#artifact-modes [data-mode="preview"]') + ".click(); " + q(pageTab + " .tab-main") + ".click()");
  await until(() => webContents.getAllWebContents().some(contents =>
    contents.id !== previewId && contents.getURL().startsWith("xsb-artifact:") && !contents.isLoading()), "new HTML preview finished opening in the background");
  await until(() => win.contentView.children.includes(site), "browser tab kept after leaving a pending preview");
  const width = site.getBounds().width;
  await js(q("#web-body") + ".style.maxWidth = " + JSON.stringify((width - 32) + "px"));
  await until(() => win.contentView.children.includes(site) && site.getBounds().width < width, "browser tab follows its slot after the late preview");
  await js(q("#web-body") + ".style.removeProperty('max-width')");
  await click(artifactTab + " .icon-btn");

  await rightClick(pageTab);
  await choose(text["tabs.close"]);
  await until(async () => !(await has(pageTab)), "tab closed");

  // An empty conversation goes without asking; one that has talked asks first, and the question is only that.
  const before = await count();
  const fresh = await js('xsb.newSession("mock")');
  await until(async () => (await count()) === before + 1, "empty conversation listed");
  await rightClick(await rowOf(fresh.id));
  await shoot("session-menu");
  assert.deepEqual(await items(), [text["rail.delete"]], "sidebar menu only offers deletion");
  finishMenu();
  await until(() => !nativeMenu, "cancelled native session menu");
  await click(await rowOf(fresh.id));
  // A new conversation connects its backend at once: its model is known without opening the settings menu.
  await untilJS('document.querySelector("#lanes .lane .model-settings").textContent.startsWith("default")', "settings fetched without opening the menu");
  const title = "#lanes .lane .lane-title-button", titleInput = "#lanes .lane .lane-title-input";
  assert.equal(await js("getComputedStyle(" + q(title) + ").getPropertyValue('-webkit-app-region')"), "no-drag", "title is clickable in the draggable header");
  await leftClick(title);
  await untilJS(q(titleInput) + ".hidden===false && document.activeElement===" + q(titleInput), "title click starts inline editing");
  assert.equal(await has("dialog[open]"), false, "rename stays in the header");
  assert.deepEqual(await js("[" + q(titleInput) + ".value," + q(titleInput) + ".selectionStart," + q(titleInput) + ".selectionEnd]"), [fresh.name, 0, fresh.name.length], "current name is selected");
  await js(q(titleInput) + ".value='cancel this change'");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await untilJS(q(titleInput) + ".hidden", "Esc cancels inline rename");
  assert.equal((await js("xsb.load()")).agents.find(a => a.id === fresh.id).name, fresh.name);
  await js(q("#lanes .lane .editor") + ".textContent='keep this draft';" + q("#lanes .lane .editor") + ".dispatchEvent(new InputEvent('input',{bubbles:true}))");
  await leftClick(title);
  await untilJS(q(titleInput) + ".hidden===false", "rename again");
  await js(q(titleInput) + ".value='   '");
  await leftClick("#lanes .lane .editor");
  await untilJS(q("#lanes .lane .lane-title-error") + ".textContent===" + JSON.stringify(text["lane.rename.empty"]), "empty name rejected on blur");
  assert.equal((await js("xsb.load()")).agents.find(a => a.id === fresh.id).name, fresh.name);
  const renamed = "改名后的对话";
  await js(q(titleInput) + ".value=" + JSON.stringify("  " + renamed + "  ") + ";" + q(titleInput) + ".focus();" + q(titleInput) + ".dispatchEvent(new InputEvent('input',{bubbles:true}))");
  await js("xsb.setAvatar(" + JSON.stringify(fresh.id) + ", '')");
  assert.equal(await js(q(titleInput) + ".value"), "  " + renamed + "  ", "agent updates preserve the title being edited");
  await js(q(titleInput) + ".dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))");
  assert.equal(await js(q(titleInput) + ".hidden"), false, "IME Enter does not save");
  await shoot("title-edit");
  await leftClick("#lanes .lane .editor");
  await untilJS(q(titleInput) + ".hidden", "blur saves rename");
  await untilJS(q(await rowOf(fresh.id)) + ".querySelector('strong').textContent===" + JSON.stringify(renamed), "renamed row");
  assert.equal(await js(q("#lanes .lane header strong") + ".textContent"), renamed, "open header updates");
  assert.equal(await js(q("#lanes .lane .editor") + ".textContent"), "keep this draft", "draft survives rename");
  await leftClick(title);
  await untilJS(q(titleInput) + ".hidden===false", "keyboard rename");
  const finalName = renamed + " Enter";
  await js(q(titleInput) + ".value=" + JSON.stringify(finalName));
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await untilJS(q(titleInput) + ".hidden", "Enter saves rename");
  const loaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  win.webContents.reload(); await loaded;
  await untilJS(q("#lanes .lane header strong") + "?.textContent===" + JSON.stringify(finalName), "rename survives reload");
  assert.equal(await js(q("#lanes .lane .editor") + ".textContent"), "keep this draft");
  // Deleting the open conversation opens the one that takes its place in the list, or the new last one.
  const roots = () => js("xsb.load().then(s=>s.agents.filter(a=>!a.workflowOwner).map(a=>a.id))");
  const shown = () => js('document.querySelector("#lanes .lane")?.dataset.agent ?? null');
  const successor = async (id) => { const ids = await roots(), i = ids.indexOf(id), rest = ids.filter(x => x !== id); return rest[Math.min(i, rest.length - 1)] ?? null; };
  assert.equal(await shown(), fresh.id);
  const afterFresh = await successor(fresh.id);
  await rightClick(await rowOf(fresh.id));
  await choose(text["rail.delete"]);
  await until(async () => (await count()) === before, "empty conversation deleted at once");
  assert.equal(await has("dialog[open]"), false);
  await until(async () => (await shown()) === afterFresh, "the next conversation is shown");
  await js("document.querySelector('#agents .row:nth-child(" + ((await roots()).indexOf(talker.id) + 1) + ")').click()");
  await until(async () => (await shown()) === talker.id, "talker shown");
  const afterTalker = await successor(talker.id);
  await rightClick(await rowOf(talker.id));
  await choose(text["rail.delete"]);
  await until(() => has("dialog[open]"), "a used conversation asks first");
  await shoot("delete-confirm");
  assert.equal(await js(q("dialog[open] p") + ".textContent"), text["rail.delete.body"]);
  await js(q("dialog[open] .btn.primary") + ".click()");
  await until(async () => (await count()) === before - 1, "used conversation deleted after confirming");
  await until(async () => (await shown()) === afterTalker, "the next conversation is shown after confirming");
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
  console.log("Electron + real Hub/ACP: delete-only session menus, native no-drag title editing, blur/Enter saves, Esc/IME/validation, live updates and reload with drafts passed");
  console.log("Electron renderer: concise backend settings, removed execution limits and explicit-only Ark checks passed");
});
