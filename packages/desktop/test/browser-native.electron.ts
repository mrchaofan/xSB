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
<form id="post" action="/post" method="POST" target="_blank"><input name="value" value="preserved"></form>
<form id="download" action="/download" method="POST"><input name="value" value="file"></form>
<script>addEventListener('message', e => window.received = e.data)</script>`;
let postBody = "";
let downloadCookie = "";
const server = http.createServer((req, res) => {
  if (req.url === "/slow") {
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
  fs.writeFileSync(html, `<html><body style="margin:0;height:100vh;display:flex"><main style="width:100%;height:100%;display:flex"></main>
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
  pages = new Pages(host.webContents, { preload, pageWindowUrl: hostUrl, controlText: "Agent 正在操作网页" });
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
  await invoke("browser_navigate", { url });
  const original = pages.contents("p1")!;
  await until(() => host!.contentView.children.some((view) => view instanceof WebContentsView && view.webContents !== original && view.getVisible()));
  assert.equal(pages.list()[0].controlling, true);
  const shield = host.contentView.children.find((view) => view instanceof WebContentsView && view.webContents !== original && view.getVisible()) as WebContentsView;
  await until(async () => (await shield.webContents.executeJavaScript("document.querySelector('.label')?.textContent")) === 'Agent 正在操作网页');
  assert.equal(await shield.webContents.executeJavaScript("getComputedStyle(document.querySelector('.frame')).animationName"), 'breathe');
  await original.executeJavaScript("document.querySelector('#field').focus(); true");
  original.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
  original.sendInputEvent({ type: 'char', keyCode: 'A' });
  original.sendInputEvent({ type: 'keyUp', keyCode: 'A' });
  const point = await original.executeJavaScript("(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  original.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  original.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await pause(100);
  assert.equal(await original.executeJavaScript("document.querySelector('#field').value"), '');
  assert.equal(await original.executeJavaScript("window.clicks||0"), 0);
  const snap = (await invoke('browser_snapshot')).content[0].text;
  const fieldRef = Number(/\[(\d+)\] textbox "Agent input"/.exec(snap)![1]);
  await invoke('browser_type', { ref: fieldRef, text: 'agent works' });
  await invoke('browser_press_key', { key: 'Enter' });
  assert.equal(await original.executeJavaScript("document.querySelector('#field').value"), 'agent works');
  assert.ok(await original.executeJavaScript("window.keys>0"));
  const buttonSnap = (await invoke('browser_snapshot')).content[0].text;
  await invoke('browser_click', { ref: Number(/\[(\d+)\] button "Change"/.exec(buttonSnap)![1]) });
  assert.equal(await original.executeJavaScript("window.clicks"), 1);
  assert.throws(() => pages!.call('p1', 'reload'), /Agent/);
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
  await until(() => fs.existsSync(path.join(cwd, '.xsb/downloads/slow.csv')) && fs.readFileSync(path.join(cwd, '.xsb/downloads/slow.csv'), 'utf8') === 'abcdef');
  assert.equal(JSON.parse((await invoke('browser_downloads_list')).content[0].text).total, 0);
  context = { ...context, active: false };
  for (const fn of listeners) fn(context);
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
  console.log("PASS user input blocked while CDP works, runtime unlock, controlled popup tabs, POST/blob/direct downloads with preserved suffixes, per-turn list reset, explicit windows and restore");
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
