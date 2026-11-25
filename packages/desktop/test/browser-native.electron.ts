/** Run through browser-native.mjs, with the private Electron binary, not node --test. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { app, BrowserWindow, WebContentsView, ipcMain } from "electron";
import { Pages } from "../src/pages.ts";
import { BrowserSession } from "../src/browser.ts";

const cwd = process.argv[2];
app.setPath("userData", path.join(cwd, "user-data"));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  for (let end = Date.now() + 10000; Date.now() < end; ) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error("native browser condition timed out");
}
const body = `<title>Opener</title><h1>Original</h1><input aria-label="Agent input" id="field"><button onclick="window.clicks=(window.clicks||0)+1">Change</button>
<script>addEventListener('keydown',()=>window.keys=(window.keys||0)+1)</script>
<div id="region" style="height:120px;overflow:auto"><div style="height:800px;padding-top:300px"><p id="deep">Deep text</p></div></div>
<form id="post" action="/post" method="POST" target="_blank"><input name="value" value="preserved"></form>
<form id="download" action="/download" method="POST"><input name="value" value="file"></form>
<script>addEventListener('message', e => window.received = e.data)</script>`;
let postBody = "";
let downloadCookie = "";
const server = http.createServer((req, res) => {
  if (req.url === "/later") {
    setTimeout(() => res.end(body), 1500);
  } else if (req.url === "/slow") {
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="slow.csv"', 'Content-Length': '6' });
    res.write('abc'); setTimeout(() => res.end('def'), 1800);
  } else if (req.url === "/download") {
    downloadCookie = req.headers.cookie ?? "";
    res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="same.csv"' });
    res.end("abc");
  } else if (req.url === "/post") {
    req.on("data", (chunk) => { postBody += chunk; });
    req.on("end", () => { res.end("<title>POST child</title><h1>POST preserved</h1>"); });
  } else {
    res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "native=kept; Path=/" });
    res.end(body);
  }
});
let host: BrowserWindow | undefined;
let pages: Pages | undefined;
let browser: BrowserSession | undefined;
async function main() {
try {
  await app.whenReady();
  assert.ok(Pages.supported, "this integration test requires the project's private Electron with webview2");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const preload = path.join(cwd, "empty-preload.cjs");
  fs.writeFileSync(preload, `const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('xsb', {
  page: (id, op, arg) => ipcRenderer.invoke('test-page', id, op, arg),
  pageWindow: () => ipcRenderer.invoke('test-page-window'),
  subscribe: fn => ipcRenderer.on('xsb:event', (_, event) => fn(event))
});`);
  const html = path.join(cwd, 'host.html');
  const hostUrl = new URL(`file://${html}`).href;
  fs.writeFileSync(html, `<html><body style="margin:0;height:100vh;display:flex"><input id="hostEditor" style="position:absolute;left:-9999px"><main style="width:100%;height:100%;display:flex"></main>
<script type="module">
import {showNative, clearNative} from './native-page.js';
import {showControl,clearControl} from './page-control.js';
const pages = new Map(); let selected, pageWindowId;
const container = document.querySelector('main');
function show(page) {
  showControl(container, page);
  if (page.window && page.id !== pageWindowId) { clearControl(); clearNative(); container.replaceChildren(); return; }
  if (page.nativeView) return showNative(container, page);
  clearNative();
  if (container.firstElementChild?.getAttribute('web-contents-id') === String(page.contentsId)) return;
  const view = document.createElement('webview2'); view.style.cssText = 'width:100%;height:100vh';
  container.replaceChildren(view); view.setAttribute('web-contents-id', String(page.contentsId));
}
const receive = event => {
  if (event.annotationTarget) window.target = event.annotationTarget;
  if (event.webAnnotation) window.notes = [...(window.notes ?? []), event.webAnnotation];
  if (event.webAnnotationsRemoved) window.removed = [...(window.removed ?? []), event.webAnnotationsRemoved];
  if (event.page) {
    if (!pages.has(event.page.id)) selected = event.page.id;
    pages.set(event.page.id, event.page);
    if (selected === event.page.id) show(event.page);
  }
  if (event.revealPage) { selected = event.revealPage; show(pages.get(selected)); }
};
xsb.subscribe(receive);
const initial = await xsb.pageWindow();
if (initial) { pageWindowId = initial.id; receive({ page: initial }); }
</script></body></html>`);
  ipcMain.handle('test-page-window', event => pages?.shownIn(event.sender));
  host = new BrowserWindow({ show: false, webPreferences: { preload, webview2Tag: true } as any });
  await host.loadURL(hostUrl);
  pages = new Pages(host.webContents, { preload, pageWindowUrl: hostUrl, controlText: "智能体正在控制网页", toneOf: (sessionId) => sessionId === 'sa' ? 'claude' : 'default' });
  ipcMain.handle('test-page', (event, id, op, arg) => {
    if (op === 'bounds') return pages!.layout(id, event.sender, arg);
    if (op === 'controlBounds') return pages!.controlLayout(id, event.sender, arg);
    return pages!.call(id, op, arg);
  });
  let context = { agentId: 'a', sessionId: 'sa', turnId: 'native-turn', active: true, turns: [{ id: 'native-turn', startedAt: Date.now() - 1 }] };
  const listeners = new Set<(state: any) => void>();
  const runtime = { snapshot: async () => context, watch: (fn: (state: any) => void) => { listeners.add(fn); fn(context); return () => listeners.delete(fn); }, close: () => listeners.clear() };
  browser = new BrowserSession(cwd, () => ({ pages: pages!, project: cwd }), runtime);
  const invoke = async (name: string, args = {}) => {
    const result = await browser!.call(name, args, new AbortController().signal);
    assert.ok(!result.isError, `${name} ${JSON.stringify(args)}: ${JSON.stringify(result)}`);
    return result;
  };
  const shieldView = () => host!.contentView.children.find((view) => view instanceof WebContentsView && ![1, 2, 3, 4, 5].some((n) => pages!.contents(`p${n}`) === view.webContents)) as WebContentsView | undefined;
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
  // Control lasts the tool call only: the page is the user's again afterwards.
  assert.equal(pages.list()[0].controlling, false);
  await userTypes('A');
  await pause(100);
  assert.equal(await original.executeJavaScript("document.querySelector('#field').value"), 'A');
  await original.executeJavaScript("document.querySelector('#field').value = ''; true");
  // During a call (a slow load), a visible shield says so and user input is blocked.
  const slowCall = invoke("browser_navigate", { url: `${url}/later` });
  await until(() => pages!.list()[0].controlling && !!shieldView()?.getVisible());
  const shield = shieldView()!;
  await until(async () => (await shield.webContents.executeJavaScript("document.querySelector('.label')?.textContent")) === '智能体正在控制网页');
  assert.equal(await shield.webContents.executeJavaScript("getComputedStyle(document.querySelector('.frame')).animationName"), 'breathe');
  assert.equal(shield.webContents.isFocused(), false, 'the shield must not take the focus');
  assert.throws(() => pages!.call('p1', 'reload'), /智能体/);
  await userTypes('A');
  await userClicks();
  await pause(100);
  assert.equal(await original.executeJavaScript("document.querySelector('#field').value"), '');
  assert.equal(await original.executeJavaScript("window.clicks||0"), 0);
  await slowCall;
  assert.equal(pages.list()[0].controlling, false);
  assert.equal(shield.getVisible(), false);
  await invoke("browser_navigate", { url });
  const snap = (await invoke('browser_snapshot')).content[0].text;
  const fieldRef = Number(/\[(\d+)\] textbox "Agent input"/.exec(snap)![1]);
  await invoke('browser_type', { ref: fieldRef, text: 'agent works' });
  await invoke('browser_press_key', { key: 'Enter' });
  assert.equal(await original.executeJavaScript("document.querySelector('#field').value"), 'agent works');
  assert.ok(await original.executeJavaScript("window.keys>0"));
  const buttonSnap = (await invoke('browser_snapshot')).content[0].text;
  await invoke('browser_click', { ref: Number(/\[(\d+)\] button "Change"/.exec(buttonSnap)![1]) });
  assert.equal(await original.executeJavaScript("window.clicks"), 1);
  // Focus emulation: the agent's clicks and typing leave the host's real focus where the user had it.
  assert.equal(await host.webContents.executeJavaScript("document.activeElement.id"), 'hostEditor');
  assert.doesNotThrow(() => pages!.call('p1', 'forward'));

  // Annotations: the debugger's node selection, edited in the host, embedded in the page.
  const target = () => host!.webContents.executeJavaScript("window.target ?? null");
  const userClicksAt = async (selector: string) => {
    const point = await original.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    original.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    original.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    original.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  };
  await assert.rejects(pages.annotate('p1', original, 'annotate', true), /elsewhere/);
  await assert.rejects(pages.annotate('p1', host.webContents, 'annotationSave', 'x'), /off/);
  await pages.annotate('p1', host.webContents, 'annotate', true);
  assert.equal(pages.list()[0].annotating, true);
  await userClicksAt('button');
  await until(async () => (await target())?.seq === 1 && !!(await target()).rect);
  assert.match((await target()).label, /^button/);
  assert.equal(await original.executeJavaScript("window.clicks"), 1, 'selection takes the click, not the page');
  assert.equal(pages.list()[0].annotating, true, 'a selection does not end the mode');
  await userTypes('Z');
  await pause(100);
  assert.equal(await original.executeJavaScript("document.querySelector('#field').value"), 'agent works', 'the keyboard is blocked while annotating');
  await assert.rejects(pages.annotate('p1', host.webContents, 'annotationSave', ' '), /characters/);
  await pages.annotate('p1', host.webContents, 'annotationSave', '检查这个按钮 <b>not html</b>');
  assert.equal(pages.list()[0].annotations, 1);
  assert.equal((await target()).seq, 0);
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
  await pages.annotate('p1', host.webContents, 'annotationDiscard');
  await until(async () => (await target()).seq === 0);
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
  await original.executeJavaScript("document.querySelector('#field').value = 'agent works'; true");
  await original.executeJavaScript(`window.child = window.open('about:blank'); child.document.write('<h1>Blank child</h1>'); true`, true);
  await until(() => pages!.list().length === 2);
  assert.equal(original.getURL(), `${url}/`);
  const child = pages.contents("p2")!;
  assert.equal(await child.executeJavaScript("!!window.opener"), true);
  assert.equal(await child.executeJavaScript("typeof window.xsb"), "undefined");
  assert.equal(child.session, original.session);
  await child.executeJavaScript("opener.postMessage('native-opener', '*'); true");
  await until(async () => (await original.executeJavaScript("window.received")) === "native-opener");
  assert.ok(pages.list().find((p) => p.id === "p2")!.nativeView);
  assert.equal(pages.list().find((p) => p.id === "p2")!.window, false);
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'window.open must not create a BrowserWindow');
  const snapshot = await invoke("browser_snapshot");
  assert.match(snapshot.content[0].text, /Blank child/);
  await invoke("browser_screenshot");
  const view = host.contentView.children.find((view) => view instanceof WebContentsView && view.webContents === child)!;
  assert.ok(view.getVisible());
  await host.webContents.executeJavaScript("const dialog = document.createElement('dialog'); document.body.append(dialog); dialog.showModal(); true");
  await until(() => !view.getVisible());
  await host.webContents.executeJavaScript("document.querySelector('dialog').remove(); true");
  await until(() => view.getVisible());
  await invoke("browser_select", { pageId: "p1" });
  await until(() => !view.getVisible());
  await invoke("browser_select", { pageId: "p2" });
  await until(() => view.getVisible());
  host.setSize(900, 700);
  await until(async () => view.getBounds().width === Math.round(await host!.webContents.executeJavaScript("document.querySelector('main').getBoundingClientRect().width")));
  await invoke("browser_select", { pageId: "p2", presentation: "window" });
  assert.equal(pages.contents("p2"), child);
  assert.equal(await child.executeJavaScript("!!window.opener"), true);
  await invoke("browser_screenshot");
  await invoke("browser_select", { pageId: "p2", presentation: "panel" });
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  await original.executeJavaScript("document.querySelector('#post').submit(); true", true);
  await until(() => postBody === "value=preserved");
  await until(() => pages!.list().length === 3 && pages!.contents("p3")!.getTitle() === "POST child");
  await original.executeJavaScript("document.querySelector('#download').submit(); true", true);
  await pause(300);
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
  assert.equal(pages.list().find((p) => p.id === "p4")!.nativeView, false);
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
  browser.release();
  await original.executeJavaScript("window.open('about:blank'); true", true);
  await until(() => pages!.list().some((p) => p.id === 'p5'));
  assert.equal(pages.list().find((p) => p.id === 'p5')!.agent, false);
  assert.equal(pages.list().find((p) => p.id === 'p5')!.window, false);
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'user popups must also stay in tabs');
  console.log("PASS annotations (debugger selection, embedded notes, region scrolling), shield and blocked user input for one tool call only, host focus kept by focus emulation, controlled popup tabs, POST/blob/direct downloads with preserved suffixes, per-turn list reset, explicit windows and restore");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  browser?.release();
  pages?.dispose();
  host?.destroy();
  server.closeAllConnections();
  server.close();
  app.exit(process.exitCode ?? 0);
}

}
void main();
