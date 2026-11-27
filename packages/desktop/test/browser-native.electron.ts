/** Run through browser-native.mjs, with the private Electron binary, not node --test. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { app, BrowserWindow, ipcMain, nativeImage } from "electron";
import type { WebContents, WebContentsView } from "electron";
import { PageHost } from "../src/page-host.ts";
import { Pages } from "../src/pages.ts";
import { BrowserSession } from "../src/browser.ts";

const cwd = process.argv[2];
app.setPath("userData", path.join(cwd, "user-data"));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, label = String(check)) {
  for (let end = Date.now() + 10000; Date.now() < end; ) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error(`native browser condition timed out: ${label}`);
}
/** Record native and DOM blur throughout agent work so that temporarily stealing and restoring focus fails. */
async function whileEditing(contents: WebContents, selector: string, action: () => Promise<void>, draft = '未提交的草稿') {
  const js = (code: string) => contents.executeJavaScript(code);
  host!.show();
  host!.focus();
  await until(() => host!.isFocused());
  contents.focus();
  await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    el.focus();
    if (el.isContentEditable) el.textContent = ${JSON.stringify(draft)}; else el.value = ${JSON.stringify(draft)};
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    window.editorBlurred = false;
    el.addEventListener('blur', window.onEditorBlur = () => { window.editorBlurred = true; });
  })()`);
  const blurs: string[] = [];
  const windowBlur = () => { blurs.push('window'); };
  const contentsBlur = () => { blurs.push('webContents'); };
  host!.on('blur', windowBlur);
  contents.on('blur', contentsBlur);
  try {
    await action();
    assert.deepEqual(blurs, [], `${selector} keeps native focus throughout agent work`);
    assert.ok(contents.isFocused(), `${selector} still owns the native keyboard`);
    const after = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return {
      blurred: window.editorBlurred, active: el === document.activeElement, text: el.isContentEditable ? el.textContent : el.value,
    }; })()`);
    assert.deepEqual(after, { blurred: false, active: true, text: draft }, `${selector} keeps the unsent edit and DOM focus`);
  } finally {
    host!.removeListener('blur', windowBlur);
    contents.removeListener('blur', contentsBlur);
    await js(`document.querySelector(${JSON.stringify(selector)}).removeEventListener('blur', window.onEditorBlur)`);
  }
}
const body = `<title>Opener</title><h1>Original</h1><input aria-label="Agent input" id="field"><button onclick="window.clicks=(window.clicks||0)+1">Change</button>
<script>addEventListener('keydown',()=>window.keys=(window.keys||0)+1)</script>
<div id="region" style="height:120px;overflow:auto"><div style="height:800px;padding-top:300px"><p id="deep">Deep text</p></div></div>
<form id="post" action="/post" method="POST" target="_blank"><input name="value" value="preserved é"></form>
<a href="/popup" target="_blank">Agent popup</a>
<a href="#section">Jump to section</a>
<form id="download" action="/download" method="POST"><input name="value" value="file"></form>
<script>addEventListener('message', e => window.received = e.data)</script>`;
let postBody = "";
let downloadCookie = "";
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === "/redirect") {
    res.writeHead(302, { Location: '/destination' }); res.end();
  } else if (req.url === "/later") {
    setTimeout(() => res.end(body), 1500);
  } else if (req.url === "/slow") {
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="slow.csv"', 'Content-Length': '6' });
    res.write('abc'); setTimeout(() => res.end('def'), 1800);
  } else if (req.url === "/download") {
    downloadCookie = req.headers.cookie ?? "";
    res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="same.csv"' });
    res.end("abc");
  } else if (req.url === "/popup") {
    res.end('<title>Popup</title><h1>Popup page</h1>');
  } else if (req.url === "/post") {
    req.on("data", (chunk) => { postBody += chunk; });
    req.on("end", () => { res.end("<title>POST child</title><h1>POST preserved</h1>"); });
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "native=kept; Path=/" });
    res.end(body);
  }
});
let host: BrowserWindow | undefined;
let pages: Pages | undefined;
let browser: BrowserSession | undefined;
async function main() {
try {
  await app.whenReady();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const preload = path.join(cwd, "empty-preload.cjs");
  // The calls of window.xsb that showing pages uses, routed as main.ts routes them.
  fs.writeFileSync(preload, `const {contextBridge, ipcRenderer} = require('electron');
const call = (method) => (...args) => ipcRenderer.invoke('xsb-test', method, ...args).catch((e) => { throw new Error(e.message.replace(/^Error invoking remote method 'xsb-test': (\\w*Error: )?/, '')); });
contextBridge.exposeInMainWorld('xsb', {
  ...Object.fromEntries(['openPage', 'page', 'pageWindow', 'overlay', 'overlayDone'].map((method) => [method, call(method)])),
  language: 'zh-CN',
  on: fn => ipcRenderer.on('xsb:event', (_, event) => fn(event))
});`);
  const html = path.join(cwd, 'host.html');
  const hostUrl = new URL(`file://${html}`).href;
  const tabHtml = path.join(cwd, 'tabs.html');
  fs.writeFileSync(tabHtml, `<html><link rel="stylesheet" href="styles.css"><body style="margin:0;height:100vh;display:flex;flex-direction:column"><div id="hostEditor" contenteditable="true">Chat</div>
<div id="tabs"></div><section class="side" id="side-workflow"><div id="taskEditor" contenteditable="true">Task</div></section><div id="side-launcher"></div><section class="side" id="side-artifacts"><input id="fileSearch"></section>
<section class="side" id="side-web" style="position:relative;display:flex;flex:1;flex-direction:column"><header><button id="web-back"></button><button id="web-forward"></button><button id="web-reload"></button><button id="web-external"></button><button id="web-detach"></button><button id="web-annotate"></button><input id="web-url"></header><div id="web-annotate-bar" class="annotate-bar" hidden></div><main id="web-body" class="web-body"></main></section>
<script>window.auditState = { pages: [], agents: [], artifacts: [], artifactTabs: [], tab: null, workflowTab: false, catalogTab: false };</script>
<script type="module">
import {onPage, onPageRemoved, selectTab} from './pages-audit.js';
window.selectPage = selectTab;
xsb.on(event => {
  if (event.webAnnotation) window.notes = [...(window.notes ?? []), event.webAnnotation];
  if (event.webAnnotationsRemoved) window.removed = [...(window.removed ?? []), event.webAnnotationsRemoved];
  if (event.page) onPage(event.page, event.keepTab);
  if (event.removedPage) onPageRemoved(event.removedPage);
});
</script></body></html>`);
  fs.writeFileSync(html, `<html><link rel="stylesheet" href="styles.css"><body style="margin:0;height:100vh;display:flex"><input id="hostEditor" style="position:absolute;left:-9999px"><main class="web-body"></main>
<script type="module">
import {showWeb} from './page-slot.js';
const pages = new Map(); let selected;
const container = document.querySelector('main');
const show = page => page.window ? container.replaceChildren() : showWeb(container, page);
xsb.on(event => {
  if (event.webAnnotation) window.notes = [...(window.notes ?? []), event.webAnnotation];
  if (event.webAnnotationsRemoved) window.removed = [...(window.removed ?? []), event.webAnnotationsRemoved];
  if (event.page) {
    if (!pages.has(event.page.id)) selected = event.page.id;
    pages.set(event.page.id, event.page);
    if (selected === event.page.id) show(event.page);
  }
});
</script></body></html>`);
  host = new BrowserWindow({ show: false, webPreferences: { preload } });
  const file = (name: string) => new URL(`file://${path.join(cwd, name)}`).href;
  const shell = { preload, overlayUrl: file('overlay.html'), editorUrl: file('annotation.html'), controlText: "智能体正在控制网页" };
  pages = new Pages(new PageHost(host, shell), { ...shell, pageWindowUrl: file('page.html'), toneOf: (sessionId) => sessionId === 'sa' ? 'claude' : 'default' });
  ipcMain.handle('xsb-test', async (event, method: string, ...args: any[]) => {
    const owner = pages!.hostOwning(event.sender);
    if (!owner) throw new Error('this window is closing');
    if (method === 'openPage') return pages!.open(args[0], { embedded: args[1], sessionId: args[2] });
    if (method === 'pageWindow') return pages!.shownIn(event.sender);
    if (method === 'overlay') return owner.overlay.show(args[0], event.sender);
    if (method === 'overlayDone') return owner.overlay.done(args[0], args[1]);
    const [id, op, arg] = args;
    if (op === 'bounds' || op === 'focus') return pages!.present(id, event.sender, op, arg);
    if (/^annotat/.test(op)) return pages!.annotate(id, event.sender, op, arg);
    return pages!.call(id, op, arg);
  });
  await host.loadURL(hostUrl);
  // What a window shows, bottom to top: its views.
  const views = (window: BrowserWindow) => window.contentView.children as WebContentsView[];
  const pageViewIn = (window: BrowserWindow, id: string) => views(window).find((view) => view.webContents === pages!.contents(id));
  const shown = (id: string) => BrowserWindow.getAllWindows().some((window) => !!pageViewIn(window, id));
  const appView = (window: BrowserWindow, name: string) => views(window).find((view) => view.webContents.getURL().endsWith(name));
  let context = { agentId: 'a', sessionId: 'sa', turnId: 'native-turn', active: true, turns: [{ id: 'native-turn', startedAt: Date.now() - 1 }] };
  const listeners = new Set<(state: any) => void>();
  const runtime = { snapshot: async () => context, watch: (fn: (state: any) => void) => { listeners.add(fn); fn(context); return () => listeners.delete(fn); }, close: () => listeners.clear() };
  browser = new BrowserSession(cwd, () => ({ pages: pages!, project: cwd }), runtime);
  const invoke = async (name: string, args = {}) => {
    const result = await browser!.call(name, args, new AbortController().signal);
    assert.ok(!result.isError, `${name} ${JSON.stringify(args)}: ${JSON.stringify(result)}`);
    return result;
  };
  async function checkTabPresentation() {
  // Check the production tab renderer independently of the shield/input fixture above.
  host.setContentSize(1120, 700);
  await host.loadFile(tabHtml);
  await until(async () => await host!.webContents.executeJavaScript('typeof window.selectPage === "function"'));
  await host.webContents.executeJavaScript(`window.auditState.pages = ${JSON.stringify(pages.list())}; window.selectPage(null); document.querySelector('#hostEditor').focus(); true`);
  browser = new BrowserSession(cwd, () => ({ pages: pages!, project: cwd }), runtime);
  await invoke('browser_navigate', { url });
  const agentPage = pages.list().at(-1)!;
  await until(async () => (await host!.webContents.executeJavaScript('window.auditState.tab')) === agentPage.id);
  await until(() => !!pageViewIn(host!, agentPage.id));
  assert.equal(views(host).filter((view) => pages!.list().some((p) => pages!.contents(p.id) === view.webContents)).length, 1, 'a window shows one page');
  assert.equal(pages.contents(agentPage.id)!.isFocused(), false, 'an agent-created tab is displayed without the focus');
  assert.equal(await host.webContents.executeJavaScript('document.activeElement.id'), 'hostEditor');
  // Opening another tab can change the displayed page even while a different window has focus.
  const foreground = new BrowserWindow({ show: false });
  await foreground.loadURL('data:text/html,<input id="foregroundEditor">');
  host.hide();
  foreground.show();
  foreground.focus();
  await until(() => foreground.isFocused());
  await foreground.webContents.executeJavaScript("document.querySelector('#foregroundEditor').focus(); true");
  let hostFocusEvents = 0;
  const focusedHost = () => { hostFocusEvents++; };
  host.on('focus', focusedHost);
  await invoke('browser_open', { url: `${url}/popup` });
  const additionalPage = pages.list().at(-1)!;
  await until(async () => (await host!.webContents.executeJavaScript('window.auditState.tab')) === additionalPage.id);
  assert.equal(host.isVisible(), false, 'opening an agent tab does not show a hidden host window');
  assert.equal(hostFocusEvents, 0, 'opening an agent tab never focuses the host window');
  assert.equal(foreground.isFocused(), true);
  assert.equal(await foreground.webContents.executeJavaScript('document.activeElement.id'), 'foregroundEditor');
  assert.equal(await host.webContents.executeJavaScript('document.activeElement.id'), 'hostEditor');
  await invoke('browser_select', { pageId: agentPage.id });
  assert.equal(await host.webContents.executeJavaScript('window.auditState.tab'), additionalPage.id, 'selecting an existing agent target does not switch the displayed tab');
  const elsewhere = pages.open(url, { sessionId: 'elsewhere', agent: true, background: true });
  await pause(100);
  assert.equal(await host.webContents.executeJavaScript('window.auditState.tab'), additionalPage.id, 'tabs from another conversation do not change this panel');
  pages.call(elsewhere.id, 'close');
  host.removeListener('focus', focusedHost);
  foreground.destroy();
  host.show();
  host.focus();
  await until(() => host!.isFocused());
  const userPage = pages.open(url, { sessionId: 'sa' });
  await until(async () => (await host!.webContents.executeJavaScript('window.auditState.tab')) === userPage.id);
  await until(() => pages!.contents(userPage.id)!.getTitle() === 'Opener' && !pages!.contents(userPage.id)!.isLoading());
  await until(() => pages!.contents(userPage.id)!.isFocused(), 'new user page gets the keyboard');
  assert.ok(pageViewIn(host, userPage.id), 'a user-created tab selects and shows its page');
  await host.webContents.executeJavaScript("document.querySelector('#hostEditor').focus(); true");
  await pages.navigate(userPage.id, url);
  assert.equal(await host.webContents.executeJavaScript('document.activeElement.id'), 'hostEditor', 'page updates do not focus an existing tab again');
  host.webContents.focus();
  await host.webContents.executeJavaScript(`const tabButton = document.querySelector('[data-id="${agentPage.id}"] .tab-main'); tabButton.focus(); tabButton.click(); document.querySelector('#hostEditor').focus(); true`);
  await until(() => !!pageViewIn(host!, agentPage.id));
  assert.equal(host.webContents.isFocused(), true, 'a later user interaction wins while the tab is being laid out');
  await host.webContents.executeJavaScript(`document.querySelector('[data-id="${agentPage.id}"] .tab-main').click()`);
  const selected = pages.contents(agentPage.id)!;
  await until(() => selected.isFocused());
  await pause(150);
  assert.equal(selected.isFocused(), true, 'a user-selected agent tab keeps native keyboard focus');
  await invoke('browser_open', { url });
  const background = pages.list().at(-1)!;
  await until(async () => await host!.webContents.executeJavaScript(`!!document.querySelector('[data-id="${background.id}"]')`));
  assert.equal(await host.webContents.executeJavaScript('window.auditState.tab'), agentPage.id);
  assert.equal(selected.isFocused(), true, 'opening an agent tab preserves the focused page');
  assert.equal(shown(background.id), false);

  // Pick a different tab through the modal. Its page receives focus after the modal closes.
  host.webContents.focus();
  await host.webContents.executeJavaScript("document.querySelector('#tabs .tab-list + button').click()");
  await until(() => !shown(agentPage.id));
  const index = pages.list().filter(p => p.sessionId === 'sa').findIndex(p => p.id === userPage.id);
  await host.webContents.executeJavaScript(`document.querySelectorAll('dialog .opened-tabs button')[${index}].click()`);
  await until(() => pages!.contents(userPage.id)!.isFocused(), 'user page selected from the modal gets the keyboard');
  host.webContents.focus();
  await host.webContents.executeJavaScript(`document.querySelector('[data-id="${userPage.id}"] .icon-btn').click()`);
  await until(() => pages!.contents(background.id)!.isFocused());
  await invoke('browser_close', { pageId: background.id });
  await until(() => !!pageViewIn(host!, additionalPage.id));
  assert.equal(host.webContents.isFocused(), true, 'automatic selection after an agent closes a tab leaves the keyboard with the host');

  await invoke('browser_select', { pageId: agentPage.id });
  await host.webContents.executeJavaScript(`document.querySelector('[data-id="${agentPage.id}"] .tab-main').click()`);
  await until(() => selected.isFocused());
  host.webContents.focus();
  await host.webContents.executeJavaScript("document.querySelector('#hostEditor').focus(); true");
  const agentLink = Number(/\[(\d+)\] link "Agent popup"/.exec((await invoke('browser_snapshot')).content[0].text)![1]);
  const beforePopup = pages.list().length;
  await invoke('browser_click', { ref: agentLink });
  await until(() => pages!.list().length > beforePopup);
  const agentPopup = pages.list().at(-1)!;
  await until(async () => (await host!.webContents.executeJavaScript('window.auditState.tab')) === agentPopup.id);
  await until(() => !!pageViewIn(host!, agentPopup.id));
  assert.notEqual(agentPopup.id, userPage.id, 'an agent popup switches the displayed tab');
  assert.equal(await host.webContents.executeJavaScript('document.activeElement.id'), 'hostEditor');
  assert.equal(host.webContents.isFocused(), true, 'an agent popup leaves the keyboard with the window');
  await host.webContents.executeJavaScript("window.selectPage(null); document.querySelector('.launcher-item').click(); true");
  await until(async () => (await host!.webContents.executeJavaScript('document.activeElement.id')) === 'web-url');
  assert.equal(host.webContents.isFocused(), true, 'a blank tab leaves the keyboard with the address bar');
  const blankId = await host.webContents.executeJavaScript('window.auditState.tab');
  assert.equal(pages.list().find((p) => p.id === blankId)!.background, false);
  await invoke('browser_open', { url });
  assert.equal(await host.webContents.executeJavaScript('window.auditState.tab'), blankId, 'an address being edited stays with its original tab');
  assert.equal(await host.webContents.executeJavaScript('document.activeElement.id'), 'web-url');
  assert.equal(host.webContents.isFocused(), true);
  await whileEditing(host.webContents, '#web-url', async () => {
    await host!.webContents.executeJavaScript("document.querySelector('#web-url').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })); true");
    await pause(100);
    assert.equal(pages!.contents(blankId)!.getURL(), 'about:blank', 'IME Return accepts a candidate without navigating');
  }, url + '/candidate');
  await invoke('browser_open', { url });
  const driven = pages.list().at(-1)!;
  await host.webContents.executeJavaScript(`window.selectPage(${JSON.stringify(driven.id)}, false)`);
  await until(() => !!pageViewIn(host!, driven.id));
  await whileEditing(host.webContents, '#hostEditor', async () => {
    const snapshot = (await invoke('browser_snapshot')).content[0].text;
    const button = Number(/\[(\d+)\] button "Change"/.exec(snapshot)![1]);
    const afterClick = (await invoke('browser_click', { ref: button })).content[0].text;
    const field = Number(/\[(\d+)\] textbox "Agent input"/.exec(afterClick)![1]);
    await invoke('browser_type', { ref: field, text: 'agent text' });
    await invoke('browser_press_key', { key: 'Enter' });
    assert.deepEqual(await pages!.contents(driven.id)!.executeJavaScript("[window.clicks, document.querySelector('#field').value, window.keys > 0]"), [1, 'agent text', true]);
  });
  console.log("PASS same-window agent click, type and Enter preserve the host window, WebContents and chat editor focus throughout");
  await host.webContents.executeJavaScript("window.selectPage('workflow')");
  await whileEditing(host.webContents, '#taskEditor', async () => {
    await invoke('browser_open', { url });
    assert.equal(await host!.webContents.executeJavaScript('window.auditState.tab'), 'workflow', 'agent tabs preserve the active task conversation');
  });
  // The user edits the side panel while the agent clicks a link in a separate, drawn page.
  const popupOpener = pages.list().at(-1)!;
  await invoke('browser_select', { pageId: popupOpener.id, presentation: 'window' });
  await until(() => BrowserWindow.getAllWindows().some(w => w !== host && !!pageViewIn(w, popupOpener.id)));
  await host.webContents.executeJavaScript("window.selectPage('catalog')");
  await whileEditing(host.webContents, '#fileSearch', async () => {
    const snapshot = (await invoke('browser_snapshot')).content[0].text;
    const ref = Number(/\[(\d+)\] link "Agent popup"/.exec(snapshot)![1]);
    const count = pages!.list().length;
    await invoke('browser_click', { ref });
    await until(() => pages!.list().length > count);
    assert.equal(await host!.webContents.executeJavaScript('window.auditState.tab'), 'catalog', 'agent popups preserve the file search');
  });
  await invoke('browser_close', { pageId: popupOpener.id });
  const js = (code: string) => host!.webContents.executeJavaScript(code);
  host.setContentSize(900, 700);
  await js("window.selectPage(null)");
  await whileEditing(host.webContents, '#hostEditor', async () => {
    await invoke('browser_open', { url });
    assert.equal(await js('window.auditState.tab'), null, 'an agent page leaves the narrow chat visible');
  });
  host.setContentSize(1120, 700);
  await invoke('browser_select', { pageId: driven.id });
  await js(`window.selectPage(${JSON.stringify(driven.id)}, false)`);
  const addressIs = (pathname: string) => until(async () => await js("document.querySelector('#web-url').value") === url + pathname);
  await invoke('browser_navigate', { url: url + '/redirect' });
  await addressIs('/destination');
  await invoke('browser_navigate', { url: url + '/next' });
  await addressIs('/next');
  await invoke('browser_back');
  await addressIs('/destination');
  await js("document.querySelector('#web-forward').click()");
  await addressIs('/next');
  const snapshot = (await invoke('browser_snapshot')).content[0].text;
  const link = Number(/\[(\d+)\] link "Jump to section"/.exec(snapshot)![1]);
  await invoke('browser_click', { ref: link });
  await addressIs('/next#section');
  await whileEditing(host.webContents, '#web-url', async () => {
    await invoke('browser_navigate', { url: url + '/actual' });
  });
  await js("document.querySelector('#web-url').blur()");
  await addressIs('/actual');
  await js(`(() => { const input = document.querySelector('#web-url'); input.focus(); input.value = 'draft';
    input.dispatchEvent(new InputEvent('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
  await addressIs('/actual');
  console.log("PASS user tab focus, agent tabs and popups while editing, narrow chat, navigation history and address bar drafts");
  }
  async function checkUserAnnotations() {
    const composer = path.join(cwd, "composer.html");
    fs.writeFileSync(composer, `<body><script type="module">
import {createEditor} from "./content.js";
import {dropPageAnnotations} from "./web-annotation.js";
import {loadDraft, saveDraft} from "./drafts.js";
const editor = createEditor(async () => {
  try { await editor.ready(); window.sent = editor.read(); } catch (e) { window.sendError = e.message; }
}, () => saveDraft("session", editor.snapshot()), dropPageAnnotations);
document.body.append(editor.tray, editor.el, editor.error);
window.restoreDraft = () => editor.restore(loadDraft("session"));
window.draftNotes = () => loadDraft("session").map(block => block.note);
window.draftIds = () => loadDraft("session").map(block => block.id);
xsb.on(event => {
  if (event.webAnnotation) editor.insert([event.webAnnotation.annotation], true);
  if (event.webAnnotationsRemoved) editor.removeAnnotations(event.webAnnotationsRemoved.ids);
});
</script></body>`);
    await host!.loadFile(composer);
    const js = (expression: string) => host!.webContents.executeJavaScript(expression);
    await until(async () => await js("typeof window.draftNotes === 'function'"));
    const first = pages!.open(url, { sessionId: "sa" }), second = pages!.open(url, { sessionId: "sa" });
    const annotate = async (id: string, notes: string[]) => {
      const contents = pages!.contents(id)!;
      await until(() => contents.getTitle() === "Opener" && !contents.isLoading());
      pages!.present(id, host!.webContents, "bounds", { x: 0, y: 100, width: 600, height: 350 });
      await pages!.annotate(id, host!.webContents, "annotate", true);
      const { root } = await contents.debugger.sendCommand("DOM.getDocument");
      const { nodeId } = await contents.debugger.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "#field" });
      const { node } = await contents.debugger.sendCommand("DOM.describeNode", { nodeId });
      for (const note of notes) {
        // Chromium's node-pick event, at a known element; confirmation embeds a real note and notifies the real editor.
        contents.debugger.emit("message", {}, "Overlay.inspectNodeRequested", { backendNodeId: node.backendNodeId });
        await until(() => !!(pages as any).pages.get(id).annotator.pending);
        await pages!.annotate(id, host!.webContents, "annotationSave", note);
      }
      await pages!.annotate(id, host!.webContents, "annotate", false);
      assert.equal(contents.debugger.isAttached(), false, "a user-only page has no driver keeping the debugger connected");
    };
    host!.showInactive();
    await annotate(first.id, ["note-one", "note-two"]);
    await annotate(second.id, ["note-three"]);
    await until(async () => (await js("window.draftNotes()")).length === 3);
    const [firstNote] = await js("window.draftIds()");
    await js("window.restoreDraft(); document.querySelector('.annotation-tray .remove-ref').click(); true");
    const count = (id: string) => pages!.list().find(p => p.id === id)?.annotations;
    await until(() => count(first.id) === 1);
    await until(async () => (await js("window.draftNotes()")).length === 2);
    assert.deepEqual(await js("window.draftNotes()"), ["note-two", "note-three"]);
    await pages!.annotate(first.id, host!.webContents, "annotationsRemove", [firstNote]);
    assert.equal(count(first.id), 1, "repeated cleanup of the same note preserves its neighbor");
    assert.equal(count(second.id), 1);
    const contents = pages!.contents(first.id)!;
    assert.equal(contents.debugger.isAttached(), false, "removing a mark releases the transient debugger");
    contents.debugger.attach();
    const tree = JSON.stringify(await contents.debugger.sendCommand("DOM.getDocument", { depth: -1, pierce: true }));
    contents.debugger.detach();
    assert.ok(!tree.includes("note-one") && tree.includes("note-two"), "the matching annotation has left the page DOM");
    // Delay the targeted CDP command to exercise page loss and independent composer cleanups deterministically.
    function pauseRemoval(pageId: string) {
      const annotator = (pages as any).pages.get(pageId).annotator;
      const inWorld = annotator.inWorld;
      let fail: (() => void) | undefined;
      annotator.inWorld = function(expression: string) {
        if (!expression.includes("xsbNotes.remove(")) return inWorld.call(this, expression);
        this.inWorld = inWorld;
        return new Promise((_resolve, reject) => { fail = () => reject(new Error("cleanup failed")); });
      };
      return { started: () => !!fail, fail: () => fail!() };
    }
    const clickRemove = "document.querySelector('.annotation-tray .remove-ref').click(); true";
    const blocked = pauseRemoval(first.id);
    await js(`document.querySelectorAll('.annotation-tray .remove-ref').forEach(b => b.click());
      document.querySelector('.editor').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); true`);
    await until(blocked.started);
    await until(() => count(second.id) === 0);
    blocked.fail();
    await until(async () => (await js("window.sendError")) === "cleanup failed");
    assert.equal(await js("window.sent"), undefined);
    assert.deepEqual(await js("window.draftNotes()"), ["note-two"]);
    assert.equal(count(first.id), 1);
    await js(`const input = document.querySelector('.editor'); input.dispatchEvent(new Event('input'));
      window.sendError = undefined; input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); true`);
    await until(async () => !!await js("window.sendError && !document.querySelector('.content-error').hidden"));
    assert.match(await js("document.querySelector('.content-error').textContent"), /批注 2.*移除按钮/);
    await js(clickRemove);
    await until(async () => (await js("window.draftNotes()")).length === 0);
    assert.equal(count(first.id), 0, "retry removes the failed note");

    await annotate(first.id, ["previous document"]);
    await annotate(second.id, ["closing page"]);
    const navigating = pauseRemoval(first.id);
    await js(clickRemove);
    await until(navigating.started);
    await pages!.navigate(first.id, url + "/popup");
    navigating.fail();
    await until(async () => (await js("window.draftNotes()")).length === 1);
    assert.deepEqual(await js("window.draftNotes()"), ["closing page"]);
    const closing = pauseRemoval(second.id);
    await js(clickRemove);
    await until(closing.started);
    pages!.call(second.id, "close");
    await until(() => !pages!.contents(second.id));
    closing.fail();
    await until(async () => (await js("window.draftNotes()")).length === 0);
    pages!.call(first.id, "close");
    console.log("PASS removing a draft attachment removes its live mark after inspect mode, across pages and repeated removals");
  }
  if (process.argv.includes("--annotations-only")) {
    await checkUserAnnotations();
    return;
  }
  if (process.argv.includes("--tabs-only")) {
    await checkTabPresentation();
    return;
  }
  // The shield is a view of the window over the page's view, the same size.
  const shieldIn = async (window: BrowserWindow) => {
    const all = views(window), shield = all.find((view) => view.webContents.getURL().startsWith('data:text/html'));
    const page = all.find((view) => pages!.list().some((p) => pages!.contents(p.id) === view.webContents));
    if (!shield || !page || shield.webContents.isLoadingMainFrame()) return null;
    const a = shield.getBounds(), b = page.getBounds();
    const { label, animation } = await shield.webContents.executeJavaScript("({ label: document.querySelector('.label').textContent, animation: getComputedStyle(document.querySelector('.frame')).animationName })");
    return { label, animation, covers: a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && b.width > 0,
      top: all.indexOf(shield) > all.indexOf(page), focused: shield.webContents.isFocused() };
  };
  const SHIELD = { label: '智能体正在控制网页', animation: 'control-breathe', covers: true, top: true, focused: false };
  const userTypes = async (key: string) => {
    await original.executeJavaScript("document.querySelector('#field').focus(); true");
    original.sendInputEvent({ type: 'keyDown', keyCode: key });
    original.sendInputEvent({ type: 'char', keyCode: key });
    original.sendInputEvent({ type: 'keyUp', keyCode: key });
  };
  const userClicks = async () => {
    const point = await original.executeJavaScript("(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    original.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    original.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  };
  await host.webContents.executeJavaScript("document.querySelector('#hostEditor').focus(); true");
  await invoke("browser_navigate", { url });
  const original = pages.contents("p1")!;
  await until(() => shown('p1'));
  // Control lasts the tool call only: the page is the user's again afterwards.
  assert.equal(pages.list()[0].controlling, false);
  await userTypes('A');
  await pause(100);
  assert.equal(await original.executeJavaScript("document.querySelector('#field').value"), 'A');
  await original.executeJavaScript("document.querySelector('#field').value = ''; true");
  // During a call (a slow load), a visible shield says so and user input is blocked.
  const slowCall = invoke("browser_navigate", { url: `${url}/later` });
  await until(async () => pages!.list()[0].controlling && !!(await shieldIn(host!)));
  assert.deepEqual(await shieldIn(host), SHIELD);
  assert.deepEqual(views(host).map((view) => view.webContents === original ? 'page' : 'shield'), ['page', 'shield'], 'the page and its shield, nothing else');
  assert.throws(() => pages!.call('p1', 'reload'), /智能体/);
  await userTypes('A');
  await userClicks();
  await pause(100);
  assert.equal(await original.executeJavaScript("document.querySelector('#field').value"), '');
  assert.equal(await original.executeJavaScript("window.clicks||0"), 0);
  await slowCall;
  assert.equal(pages.list()[0].controlling, false);
  await until(async () => !(await shieldIn(host!)));
  await invoke("browser_navigate", { url });
  const snap = (await invoke('browser_snapshot')).content[0].text;
  await host.webContents.executeJavaScript("document.querySelector('#hostEditor').focus(); true");
  const fieldRef = Number(/\[(\d+)\] textbox "Agent input"/.exec(snap)![1]);
  await invoke('browser_type', { ref: fieldRef, text: 'agent works' });
  await invoke('browser_press_key', { key: 'Enter' });
  assert.equal(await original.executeJavaScript("document.querySelector('#field').value"), 'agent works');
  assert.ok(await original.executeJavaScript("window.keys>0"));
  const buttonSnap = (await invoke('browser_snapshot')).content[0].text;
  await invoke('browser_click', { ref: Number(/\[(\d+)\] button "Change"/.exec(buttonSnap)![1]) });
  assert.equal(await original.executeJavaScript("window.clicks"), 1);
  // The agent's input goes to the page, not to a shield that is already over it.
  pages.setAgentControl('p1', true);
  await until(async () => !!(await shieldIn(host!)));
  await pause(200);
  const again = (await invoke('browser_snapshot')).content[0].text;
  await invoke('browser_click', { ref: Number(/\[(\d+)\] button "Change"/.exec(again)![1]) });
  await invoke('browser_type', { ref: Number(/\[(\d+)\] textbox "Agent input"/.exec(again)![1]), text: 'agent works' });
  assert.equal(await original.executeJavaScript("window.clicks"), 2);
  // The user's click on the page while the shield is up does nothing there.
  pages.setAgentControl('p1', true);
  await until(async () => !!(await shieldIn(host!)));
  await userClicks();
  await pause(100);
  assert.equal(await original.executeJavaScript("window.clicks"), 2);
  pages.setAgentControl('p1', false);
  await until(async () => !(await shieldIn(host!)));
  // Focus emulation: the agent's clicks and typing leave the host's real focus where the user had it.
  assert.equal(await host.webContents.executeJavaScript("document.activeElement.id"), 'hostEditor');
  assert.doesNotThrow(() => pages!.call('p1', 'forward'));

  // Annotations: the debugger's node selection, edited in a view over the page, embedded in the page.
  const target = async () => (pages as any).pages.get('p1')?.annotator?.pending ?? { seq: 0, rect: null };
  const editor = () => appView(host!, 'annotation.html');
  const userClicksAt = async (selector: string) => {
    const point = await original.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    // The user's pointer, through the renderer's input like a real one. Not sendInputEvent: on macOS a window covered by
    // others (as on a busy test machine) leaves a page's new document without frames, and native pointer events are dropped.
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
      await original.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  };
  // The debugger's node selection only works on a page that is drawn: the user annotates in a window they see.
  // On macOS a window under others is not drawn, so keep this one on top of everything while annotating.
  host.setAlwaysOnTop(true, 'screen-saver');
  host.showInactive();
  await assert.rejects(pages.annotate('p1', original, 'annotate', true), /elsewhere/);
  await assert.rejects(pages.annotate('p1', host.webContents, 'annotationSave', 'x'), /off/);
  await pages.annotate('p1', host.webContents, 'annotate', true);
  assert.equal(pages.list()[0].annotating, true);
  await userClicksAt('button');
  await until(async () => (await target())?.seq === 1 && !!(await target()).rect);
  assert.match((await target()).label, /^button/);
  // The editor is a view over the page, below the element, labelled with it.
  await until(async () => !!editor() && !editor()!.webContents.isLoadingMainFrame() && /^button/.test(await editor()!.webContents.executeJavaScript("document.querySelector('.annotate-label').textContent")));
  const placed = editor()!.getBounds(), pageBox = pageViewIn(host, 'p1')!.getBounds(), element = (await target()).rect;
  assert.equal(views(host).at(-1), editor(), 'the editor is the top view');
  assert.equal(await editor()!.webContents.executeJavaScript("getComputedStyle(document.querySelector('.annotate-editor')).borderTopColor"), 'rgb(217, 119, 87)', 'the editor uses the tone of the page being annotated');
  assert.ok(placed.y >= pageBox.y + element.y + element.height, 'the editor is below the element');
  assert.equal(placed.width, 300);
  const noteEditor = editor()!.webContents;
  await whileEditing(noteEditor, '.annotate-text', async () => {
    const result = await browser!.call('browser_snapshot', {}, new AbortController().signal);
    assert.equal(result.isError, true, 'agent access waits while the user edits a note');
    assert.equal(editor()?.webContents, noteEditor);
    assert.equal((await target()).seq, 1);
    assert.equal(await noteEditor.executeJavaScript("document.querySelector('.annotate-text').value"), '批注草稿');
  }, '批注草稿');
  // A fixed CSS slot still moves and grows in native DIPs when the app is zoomed. The
  // inspector reports the selected element in the website's independently zoomed CSS pixels.
  await host.webContents.executeJavaScript("document.querySelector('.page-slot').style.cssText = 'position:fixed;left:40px;top:32px;width:540px;height:360px'; true");
  host.webContents.setZoomFactor(1.25);
  original.setZoomFactor(1.5);
  await until(async () => {
    const page = pageViewIn(host!, 'p1')!.getBounds(), editorBox = editor()!.getBounds();
    const rect = (await target()).rect;
    return page.x === 50 && page.y === 40 && page.width === 675 && page.height === 450
      && editorBox.width === 375 && rect && editorBox.y === page.y + Math.round((rect.y + rect.height) * 1.5 + 10);
  });
  await until(async () => Math.abs(editor()!.webContents.getZoomFactor() - 1.25) < 0.001);
  host.webContents.setZoomFactor(1);
  original.setZoomFactor(1);
  await host.webContents.executeJavaScript("document.querySelector('.page-slot').removeAttribute('style'); true");
  await until(() => editor()!.getBounds().width === 300);
  assert.equal(await original.executeJavaScript("window.clicks"), 2, 'selection takes the click, not the page');
  assert.equal(pages.list()[0].annotating, true, 'a selection does not end the mode');
  await userTypes('Z');
  await pause(100);
  assert.equal(await original.executeJavaScript("document.querySelector('#field').value"), 'agent works', 'the keyboard is blocked while annotating');
  await assert.rejects(pages.annotate('p1', host.webContents, 'annotationSave', ' '), /characters/);
  await assert.rejects(pages.annotate('p1', pages.contents('p1')!, 'annotationSave', 'x'), /elsewhere/);
  // The editor's own document saves the note.
  await editor()!.webContents.executeJavaScript("document.querySelector('.annotate-text').value = '检查这个按钮 <b>not html</b>'; document.querySelector('.annotate-editor').requestSubmit(); true");
  await until(() => pages!.list()[0].annotations === 1);
  assert.equal((await target()).seq, 0);
  assert.equal(editor(), undefined, 'the editor goes when its note is saved');
  // The note goes to the conversation: the user's words, the element's HTML and its picture.
  const [sent] = await host.webContents.executeJavaScript("window.notes");
  assert.equal(sent.sessionId, 'sa');
  assert.equal(sent.annotation.type, 'web_annotation');
  assert.match(sent.annotation.id, /^[0-9a-f-]{36}$/);
  assert.equal(sent.annotation.pageId, 'p1');
  assert.equal(sent.annotation.index, 1);
  assert.equal(sent.annotation.note, '检查这个按钮 <b>not html</b>');
  assert.match(sent.annotation.html, /^<button onclick=.*>Change<\/button>$/);
  assert.match(sent.annotation.label, /^button/);
  assert.equal(sent.annotation.url, `${url}/`);
  assert.equal(sent.annotation.image.mimeType, 'image/png');
  assert.equal(Buffer.from(sent.annotation.image.data, 'base64').subarray(1, 4).toString(), 'PNG');
  // In the style of the page's agent: claude's orange, not red.
  assert.equal(pages.list()[0].tone, 'claude');
  assert.equal(await original.executeJavaScript("document.querySelector('xsb-annotations').style.getPropertyValue('--xsb-accent')"), 'rgb(217,119,87)');
  const tree = JSON.stringify(await original.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true }));
  assert.ok(tree.includes('检查这个按钮 <b>not html</b>'), 'the note is embedded in the page, as text');
  assert.equal(await original.executeJavaScript("typeof window.xsbNotes"), 'undefined', 'the page cannot reach the isolated world');
  // A scrolling region: the selected element's place follows it, and leaves when it scrolls out of sight.
  await original.executeJavaScript("document.querySelector('#region').scrollTop = 250; true");
  await pause(50);
  await userClicksAt('#deep');
  await until(async () => (await target())?.seq === 2 && !!(await target()).rect);
  const first = (await target()).rect;
  await original.executeJavaScript("document.querySelector('#region').scrollTop = 230; true");
  await until(async () => Math.abs(((await target()).rect?.y ?? -1) - (first.y + 20)) < 1.5);
  await original.executeJavaScript("document.querySelector('#region').scrollTop = 0; true");
  await until(async () => (await target()).seq === 2 && (await target()).rect === null);
  const moved = editor()!.getBounds();
  await editor()!.webContents.executeJavaScript("document.querySelector('.annotate-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
  await until(async () => (await target()).seq === 0 && !editor());
  assert.ok(moved.width > 0);
  // An agent taking the page ends the annotating; the note stays.
  await invoke('browser_snapshot');
  assert.equal(pages.list()[0].annotating, false);
  assert.equal(pages.list()[0].annotations, 1);
  await userTypes('Y');
  await pause(100);
  assert.equal(await original.executeJavaScript("document.querySelector('#field').value"), 'agent worksY', 'the keyboard is the user\'s again');
  // The composer takes a note out of the page (sent, or dropped from its tray), annotating or not; only by its ids.
  await assert.rejects(pages.annotate('p1', host.webContents, 'annotationsRemove', 'all'), /list of ids/);
  await assert.rejects(pages.annotate('p1', host.webContents, 'annotationsRemove', [1]), /list of ids/);
  await assert.rejects(pages.annotate('p1', original, 'annotationsRemove', [sent.annotation.id]), /elsewhere/);
  await pages.annotate('p1', host.webContents, 'annotationsRemove', ['not-a-note']);
  assert.equal(pages.list()[0].annotations, 1);
  await pages.annotate('p1', host.webContents, 'annotationsRemove', [sent.annotation.id]);
  assert.equal(pages.list()[0].annotations, 0);
  assert.ok(!JSON.stringify(await original.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true })).includes('检查这个按钮'));
  // A new document: no notes, and selection works again in it.
  await pages.annotate('p1', host.webContents, 'annotate', true);
  await pages.navigate('p1', url);
  await until(() => !original.isLoading() && pages!.list()[0].annotations === 0);
  await pause(200);
  // Node selection needs a drawn page; this native suite runs on an unlocked desktop.
  await until(async () => await original.executeJavaScript('document.visibilityState') === 'visible');
  await userClicksAt('button');
  await until(async () => (await target())?.seq === 3 && !!(await target()).rect);
  // Clearing on the page tells the main window which notes went, for the composer to drop them too.
  await pages.annotate('p1', host.webContents, 'annotationSave', 'A');
  await userClicksAt('#field');
  await until(async () => (await target())?.seq === 4);
  await pages.annotate('p1', host.webContents, 'annotationSave', 'B');
  assert.equal(pages.list()[0].annotations, 2);
  const kept = (await host.webContents.executeJavaScript("window.notes")).slice(-2).map((n: any) => n.annotation.id);
  await pages.annotate('p1', host.webContents, 'annotationsClear');
  assert.equal(pages.list()[0].annotations, 0);
  await until(async () => (await host!.webContents.executeJavaScript("window.removed?.length ?? 0")) === 1);
  const [cleared] = await host.webContents.executeJavaScript("window.removed");
  assert.deepEqual({ ...cleared, ids: [...cleared.ids].sort() }, { pageId: 'p1', sessionId: 'sa', ids: [...kept].sort() });
  await pages.annotate('p1', host.webContents, 'annotate', false);
  assert.equal(pages.list()[0].annotating, false);
  host.setAlwaysOnTop(false);
  host.hide();
  await original.executeJavaScript("document.querySelector('#field').value = 'agent works'; true");
  // A popup is a page in a tab, like any other, and keeps its opener.
  await original.executeJavaScript("window.open('/popup'); true", true);
  await until(() => pages!.list().length === 2 && pages!.contents('p2')!.getTitle() === 'Popup');
  assert.equal(original.getURL(), `${url}/`);
  const child = pages.contents("p2")!;
  assert.equal(await child.executeJavaScript("!!window.opener"), true);
  assert.equal(await child.executeJavaScript("document.referrer"), `${url}/`);
  assert.equal(await child.executeJavaScript("typeof window.xsb"), "undefined");
  assert.equal(child.session, original.session);
  assert.equal(pages.list().find((p) => p.id === "p2")!.window, false);
  // Opening provenance controls focus: agent pages are background, user popups are foreground.
  assert.equal(pages.list().find((p) => p.id === "p1")!.background, true);
  assert.equal(pages.list().find((p) => p.id === "p2")!.background, false);
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'window.open must not create a BrowserWindow');
  const snapshot = await invoke("browser_snapshot");
  assert.match(snapshot.content[0].text, /Popup page/);
  // The host is hidden: the page it shows is drawn in the screenshot window for the while, then goes back.
  assert.equal(host.isVisible(), false);
  await until(() => !!pageViewIn(host!, 'p2'));
  await invoke("browser_screenshot");
  assert.ok(pageViewIn(host, 'p2'), 'a page drawn away from a hidden window goes back to it');
  assert.equal(host.isVisible(), false, 'the screenshot does not show the hidden window');
  // The renderer can switch tabs or hide its slot while the screenshot is in flight.
  const slot = pageViewIn(host, 'p2')!.getBounds();
  const resizedSlot = { x: 10, y: 20, width: 320, height: 240 };
  await pages.drawn('p2', async () => {
    const capture = BrowserWindow.getAllWindows().find((win) => win !== host)!;
    pages!.present('p2', host!.webContents, 'bounds', resizedSlot);
    assert.ok(pageViewIn(capture, 'p2'), 'a hidden window reporting new bounds leaves the screenshot in progress');
    assert.equal(pageViewIn(host!, 'p2'), undefined);
  });
  assert.deepEqual(pageViewIn(host, 'p2')!.getBounds(), resizedSlot, 'after capture the page takes its latest slot');
  await pages.drawn('p2', async () => pages!.present('p1', host!.webContents, 'bounds', slot));
  assert.ok(pageViewIn(host, 'p1'), 'returning a loan does not replace another tab');
  pages.present('p2', host.webContents, 'bounds', slot);
  await pages.drawn('p2', async () => pages!.present('p2', host!.webContents, 'bounds', null));
  assert.equal(pageViewIn(host, 'p2'), undefined, 'returning a loan does not uncover a hidden slot');
  pages.present('p2', host.webContents, 'bounds', slot);
  // Agent input goes to the selected background page while the displayed page keeps the user's keyboard.
  await until(() => !!pageViewIn(host!, 'p2'));
  assert.equal(shown('p1'), false);
  host.show();
  host.focus();
  await until(() => host!.isFocused());
  child.focus();
  await until(() => host!.isFocused() && child.isFocused());
  let pageBlurred = false;
  const onPageBlur = () => { pageBlurred = true; };
  child.once('blur', onPageBlur);
  const background = (await invoke("browser_select", { pageId: "p1" })).content[0].text;
  const backgroundField = Number(/\[(\d+)\] textbox "Agent input"/.exec(background)![1]);
  await original.executeJavaScript("document.querySelector('#field').addEventListener('input', () => window.focusAtInput = document.hasFocus(), { once: true }); true");
  await invoke('browser_type', { ref: backgroundField, text: '后台输入' });
  await invoke('browser_press_key', { key: 'Z' });
  assert.equal(await original.executeJavaScript("document.querySelector('#field').value"), '后台输入Z');
  assert.equal(await original.executeJavaScript("window.focusAtInput"), true);
  assert.equal(shown('p1'), false);
  assert.equal(host.isFocused(), true, 'the visible window stays active during background input');
  assert.equal(child.isFocused(), true, 'the visible page keeps native keyboard focus during background input');
  child.off('blur', onPageBlur);
  assert.equal(pageBlurred, false, 'background input never takes the keyboard from the visible page');
  // Drawing the background page also preserves the host editor's focus.
  host.webContents.focus();
  await host.webContents.executeJavaScript("document.querySelector('#hostEditor').focus(); true");
  const drawn = pages.drawn.bind(pages);
  let screenshotScale = 1;
  const checkDrawing = (focused: BrowserWindow) => {
    pages!.drawn = (id, draw) => drawn(id, async () => {
      const drawing = BrowserWindow.getAllWindows().find((w) => w !== host && w !== focused)!;
      assert.ok(drawing && drawing.isVisible(), 'an unattached page is drawn in a separate visible window');
      assert.equal(drawing.isFocusable(), false);
      assert.equal(drawing.isFocused(), false);
      assert.equal(focused.isFocused(), true, 'creating and showing the screenshot window keeps the active window');
      assert.equal(await host!.webContents.executeJavaScript("document.activeElement.id"), 'hostEditor');
      assert.deepEqual(views(host!).map((view) => view.webContents), [child], 'the screenshot never puts a second page in the host');
      screenshotScale = await original.executeJavaScript('devicePixelRatio');
      return draw();
    });
  };
  checkDrawing(host);
  const offscreen = await invoke("browser_screenshot");
  pages.drawn = drawn;
  assert.ok(offscreen.content[0].data.length > 1000, 'a page off screen is drawn for its screenshot');
  assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(offscreen.content[0].data, 'base64')).getSize(), { width: 800 * screenshotScale, height: 600 * screenshotScale });
  assert.equal(host.isFocused(), true, 'closing the screenshot window keeps the active window');
  assert.equal(await host.webContents.executeJavaScript("document.activeElement.id"), 'hostEditor');
  assert.ok(pageViewIn(host, 'p2'), 'the page shown stays shown');
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'the temporary screenshot window is cleaned up');
  assert.equal(shown('p1'), false);
  // The screenshot must also leave a different foreground window and its editor alone.
  const other = new BrowserWindow({ show: false });
  await other.loadURL('data:text/html,<input id="otherEditor">');
  host.hide();
  other.show();
  other.focus();
  await until(() => other.isFocused());
  await other.webContents.executeJavaScript("document.querySelector('#otherEditor').focus(); true");
  checkDrawing(other);
  await invoke('browser_screenshot');
  pages.drawn = drawn;
  assert.equal(other.isFocused(), true);
  assert.equal(host.isVisible(), false, 'a screenshot does not show the hidden main window');
  assert.equal(await other.webContents.executeJavaScript("document.activeElement.id"), 'otherEditor');
  await assert.rejects(pages.drawn('p1', async () => { throw new Error('capture failed'); }), /capture failed/);
  assert.equal(other.isFocused(), true, 'a failed screenshot also keeps the active window');
  assert.equal(shown('p1'), false, 'the page leaves the window after a failed screenshot');
  assert.equal(original.isDestroyed(), false);
  assert.equal(BrowserWindow.getAllWindows().length, 2, 'a failed capture leaves no screenshot window');
  other.destroy();
  host.show();
  host.focus();
  await until(() => host!.isFocused());
  // The overlay: a menu over the page, drawn in a view the size of the window, closing itself.
  const overlay = () => appView(host!, 'overlay.html');
  const menu = (items = "[{ label: 'A' }, null, { label: 'B', icon: 'copy' }]") => host!.webContents.executeJavaScript(`window.answer = undefined; xsb.overlay({ kind: 'menu', x: 40, y: 40, label: 'menu', items: ${items} }).then((a) => { window.answer = a; }); true`);
  const answer = async () => { let a: unknown; await until(async () => (a = await host!.webContents.executeJavaScript('window.answer')) !== undefined); return a; };
  const overlayReady = () => until(async () => !!overlay() && !overlay()!.webContents.isLoadingMainFrame() && await overlay()!.webContents.executeJavaScript("!!document.querySelector('.overlay-menu')"));
  await menu();
  await overlayReady();
  assert.equal(views(host).at(-1), overlay(), 'the overlay is the top view');
  const { width, height } = host.getContentBounds();
  assert.deepEqual(overlay()!.getBounds(), { x: 0, y: 0, width, height }, 'the overlay is the size of the window');
  assert.ok(overlay()!.webContents.isFocused(), 'the overlay takes the keyboard while it is open');
  assert.equal(await overlay()!.webContents.executeJavaScript("document.querySelectorAll('.overlay-menu button').length"), 2);
  await overlay()!.webContents.executeJavaScript("document.querySelectorAll('.overlay-menu button')[1].click(); true");
  assert.equal(await answer(), 2, 'the answer is the index of the item chosen');
  await until(() => !overlay());
  await until(() => host!.webContents.isFocused());
  // A click outside the menu, on the overlay's own backdrop, closes it with no answer.
  await menu();
  await overlayReady();
  await overlay()!.webContents.executeJavaScript("document.querySelector('.overlay-layer').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true");
  assert.equal(await answer(), null);
  await until(() => !overlay());
  host.webContents.setZoomFactor(1.25);
  await menu();
  await overlayReady();
  const menuPosition = await overlay()!.webContents.executeJavaScript("document.querySelector('.overlay-menu').getBoundingClientRect().toJSON()");
  const menuZoom = overlay()!.webContents.getZoomFactor();
  assert.deepEqual([menuPosition.x, menuPosition.y].map((n: number) => Math.round(n * menuZoom)), [50, 50], 'the menu stays at the zoomed pointer');
  overlay()!.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await answer();
  host.webContents.setZoomFactor(1);
  // So does Escape, and losing the focus.
  await menu();
  await overlayReady();
  overlay()!.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  assert.equal(await answer(), null);
  await menu();
  await overlayReady();
  host.webContents.focus();
  assert.equal(await answer(), null);
  await until(() => !overlay());
  // A second menu replaces the first, which answers nothing.
  await host.webContents.executeJavaScript("window.first = undefined; xsb.overlay({ kind: 'menu', x: 0, y: 0, items: [{ label: 'A' }] }).then((a) => { window.first = a; }); true");
  await menu();
  await until(async () => (await host!.webContents.executeJavaScript('window.first')) === null);
  await overlayReady();
  overlay()!.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await answer();
  // The shield sits between the page and the overlay; the page keeps the bottom.
  pages.setAgentControl('p2', true);
  await until(async () => !!(await shieldIn(host!)));
  await menu();
  await overlayReady();
  assert.deepEqual(views(host).map((view) => view.webContents === child ? 'page' : view === overlay() ? 'overlay' : 'shield'), ['page', 'shield', 'overlay']);
  // A click on the shield leaves the keyboard with the window's document.
  overlay()!.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await answer();
  views(host).find((view) => view.webContents.getURL().startsWith('data:'))!.webContents.focus();
  await until(() => host!.webContents.isFocused());
  pages.setAgentControl('p2', false);
  await until(async () => !(await shieldIn(host!)));
  // In a window of its own a page is shown by the app's page.html, shield and all.
  await invoke("browser_select", { pageId: "p2", presentation: "window" });
  assert.equal(pages.contents("p2"), child);
  await invoke("browser_screenshot");
  const own = BrowserWindow.getAllWindows().find((w) => w !== host)!;
  assert.match(own.webContents.getURL(), /page\.html$/);
  pages.setAgentControl('p2', true);
  await until(async () => !!(await shieldIn(own)));
  assert.deepEqual(await shieldIn(own), SHIELD);
  assert.equal(await shieldIn(host), null);
  assert.equal(pageViewIn(host, 'p2'), undefined, 'a page is shown in one window at a time');
  if (process.env.XSB_SHOTS) fs.writeFileSync(path.join(process.env.XSB_SHOTS, 'shield-window.png'), (await own.webContents.capturePage()).toPNG());
  pages.setAgentControl('p2', false);
  await until(async () => !(await shieldIn(own)));
  await invoke("browser_select", { pageId: "p2", presentation: "panel" });
  await invoke("browser_screenshot");
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  await until(() => !!pageViewIn(host!, 'p2'));
  assert.equal(child.isDestroyed(), false, 'the page came back without loading again');
  assert.equal(child.getTitle(), 'Popup');
  await original.executeJavaScript("document.querySelector('#post').submit(); true", true);
  await until(() => postBody === "value=preserved+%C3%A9");
  await until(() => pages!.list().length === 3 && pages!.contents("p3")!.getTitle() === "POST child");
  await original.executeJavaScript("document.querySelector('#download').submit(); true", true);
  await until(async () => JSON.parse((await invoke("browser_downloads_list")).content[0].text).downloads[0]?.state === 'completed');
  const downloaded = await invoke("browser_downloads_list");
  const records = JSON.parse(downloaded.content[0].text).downloads;
  assert.equal(records.length, 1);
  assert.equal(records[0].state, "completed");
  assert.equal(fs.readFileSync(records[0].path, "utf8"), "abc");
  assert.match(downloadCookie, /native=kept/);
  await original.executeJavaScript(`const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['blob-content'], {type: 'text/plain'})); a.download = 'same.csv'; a.click(); true`, true);
  await until(async () => JSON.parse((await invoke("browser_downloads_list")).content[0].text).total === 2);
  await until(async () => JSON.parse((await invoke("browser_downloads_list")).content[0].text).downloads[1]?.state === 'completed');
  const blobs = JSON.parse((await invoke("browser_downloads_list")).content[0].text).downloads;
  assert.equal(blobs[1].state, "completed");
  assert.equal(blobs[0].filename, "same.csv");
  assert.equal(blobs[1].filename, "same (1).csv");
  assert.notEqual(blobs[0].path, blobs[1].path);
  assert.equal(fs.readFileSync(blobs[1].path, "utf8"), "blob-content");
  await invoke("browser_navigate", { url: `${url}/download` });
  await until(async () => JSON.parse((await invoke("browser_downloads_list")).content[0].text).downloads[2]?.state === 'completed');
  const direct = JSON.parse((await invoke("browser_downloads_list")).content[0].text).downloads;
  assert.equal(direct.length, 3);
  assert.equal(direct[2].state, "completed");
  assert.equal(direct[2].filename, "same (2).csv");
  await invoke("browser_open", { url, presentation: "window" });
  assert.equal(pages.list().find((p) => p.id === "p4")!.window, true);
  assert.equal(BrowserWindow.getAllWindows().find((w) => w !== host)!.isFocused(), false, "the agent's window does not take the focus");
  await invoke("browser_screenshot");
  await invoke("browser_select", { pageId: "p4", presentation: "panel" });
  assert.equal(pages.list().find((p) => p.id === "p4")!.window, false);
  await invoke("browser_close", { pageId: "p2" });
  assert.equal(pages.contents("p2"), undefined);
  await invoke('browser_navigate', { url: `${url}/slow` });
  let slow: any;
  await until(async () => {
    const list = JSON.parse((await invoke('browser_downloads_list')).content[0].text).downloads;
    slow = list.find((item: any) => item.filename === 'slow.csv');
    if (!slow) return false;
    const progress = JSON.parse((await invoke('browser_downloads_progress', { id: slow.id })).content[0].text);
    return progress.receivedBytes === 3 && !progress.done;
  });
  const progress = JSON.parse((await invoke('browser_downloads_progress', { id: slow.id })).content[0].text);
  assert.equal(progress.percent, 50);
  assert.equal(progress.totalBytes, 6);
  assert.equal(progress.path, undefined);
  const oldId = slow.id;
  await pause(3);
  const change = Date.now();
  context = { ...context, turnId: 'next-turn', turns: [{ ...context.turns[0], endedAt: change } as any, { id: 'next-turn', startedAt: change }] };
  for (const fn of listeners) fn(context);
  assert.equal(JSON.parse((await invoke('browser_downloads_list')).content[0].text).total, 0);
  assert.equal((await browser.call('browser_downloads_progress', { id: oldId }, new AbortController().signal)).isError, true);
  await until(() => fs.existsSync(path.join(cwd, '.xsb2/downloads/slow.csv')) && fs.readFileSync(path.join(cwd, '.xsb2/downloads/slow.csv'), 'utf8') === 'abcdef');
  assert.equal(JSON.parse((await invoke('browser_downloads_list')).content[0].text).total, 0);
  assert.equal(pages.list().find(p => p.id === 'p1')!.controlling, false);
  await original.executeJavaScript("document.querySelector('#field').focus(); true");
  original.sendInputEvent({ type: 'keyDown', keyCode: 'B' });
  original.sendInputEvent({ type: 'char', keyCode: 'B' });
  original.sendInputEvent({ type: 'keyUp', keyCode: 'B' });
  await pause(100);
  assert.ok((await original.executeJavaScript("document.querySelector('#field').value")).includes('B'));
  // A popup the agent's click opened is the agent's doing: it preserves host focus.
  const linkRef = Number(/\[(\d+)\] link "Agent popup"/.exec((await invoke('browser_snapshot', { from: 0 })).content[0].text)![1]);
  await host.webContents.executeJavaScript("document.querySelector('#hostEditor').focus(); true");
  await invoke('browser_click', { ref: linkRef });
  await until(() => pages!.list().some((p) => p.id === 'p5'));
  assert.equal(pages.list().find((p) => p.id === 'p5')!.background, true);
  assert.equal(await host.webContents.executeJavaScript('document.activeElement.id'), 'hostEditor', 'an agent-created popup preserves the user focus');
  browser.release();
  await original.executeJavaScript("window.open('/popup'); true", true);
  await until(() => pages!.list().some((p) => p.id === 'p6'));
  assert.equal(pages.list().find((p) => p.id === 'p6')!.agent, false);
  assert.equal(pages.list().find((p) => p.id === 'p6')!.background, false);
  assert.equal(pages.list().find((p) => p.id === 'p6')!.window, false);
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'user popups must also stay in tabs');
  // An empty popup that its opener writes into is a tab too.
  await original.executeJavaScript("window.written = window.open('about:blank'); window.written.document.write('<title>Written</title>'); true", true);
  await until(() => pages!.list().some((p) => p.id === 'p7'));
  await until(() => pages!.contents('p7')!.getTitle() === 'Written');
  await until(() => !!pageViewIn(host!, 'p7'));
  await original.executeJavaScript("window.written.close(); true");
  await until(() => !pages!.contents('p7'));
  console.log("PASS page views, shield and editor layers, overlay menus, popups with their opener, downloads, screenshots and page windows");
  await checkTabPresentation();
  // Production tears down the panel from the BrowserWindow's closed event. Include an
  // outstanding menu and attached page so their cleanup runs after the native window closes.
  const children = pages.list().map((p) => pages!.contents(p.id)!);
  const closingMenu = pages.host.overlay.show({ kind: 'menu', x: 10, y: 10, items: [{ label: 'Close' }] }, host.webContents);
  await overlayReady();
  const menuContents = overlay()!.webContents;
  host.once('closed', () => pages!.dispose());
  host.destroy();
  assert.equal(await closingMenu, null);
  await until(() => children.every((contents) => contents.isDestroyed()) && menuContents.isDestroyed());
  assert.equal(pages.list().length, 0);
  console.log("PASS closing a window with a page and a menu cleans up its native views");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  browser?.release();
  if (host && !host.isDestroyed()) {
    pages?.dispose();
    host.destroy();
  }
  server.closeAllConnections();
  server.close();
  if (!process.exitCode) fs.writeFileSync(path.join(cwd, 'passed'), '');
  app.exit(process.exitCode ?? 0);
}

}
// Closing the last window is itself under test. Only the completed test should exit the process.
app.on('window-all-closed', () => {});
void main();
