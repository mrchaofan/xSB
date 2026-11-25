/**
 * The desktop app's main process: windows, and what only the operating system
 * can do for them (folder dialog, file protocol, reveal in Finder).
 *
 *   renderer (../renderer) --window.xsb--> preload.cjs --ipc--> here --> Workspace --ACP--> hub
 *
 * A window has at most one workspace. Without one it shows the welcome page;
 * everything about an open workspace is in workspace.ts.
 *
 * The app runs once: starting it again shows the one that runs. It lives
 * until the user quits it, not until its windows are gone: closing the last
 * window hides it. The hubs of the workspaces it opened live as long as it
 * does, and are stopped when it quits. Quitting while agents are at work asks
 * first; what is then cut short is given up, not taken up again on the next start.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, nativeImage, net, protocol, session, shell, webContents } from "electron";
import type { WebPreferences } from "electron";
import { Paths, approvePlugin, describeBackends, ensurePluginRoot, limitSettings, listPlugins, projectLanguageSetting, setLimit, setPluginEnabled, setProjectLanguage, stopHub } from "@xsb/hub";
import { explain, languageOf, reasonOf } from "@xsb/protocol";
import type { Language } from "@xsb/protocol";
import { BadAddress } from "./address.ts";
import { AgentClis, agentCli, configPath } from "./agent-cli.ts";
import type { BackendView, Event } from "./bridge.ts";
import { serveBrowser } from "./browser.ts";
import { imagesFromPaths } from "./clipboard-image.ts";
import { Clis, wrapped } from "./clis.ts";
import { notice, setUpNotices } from "./notices.ts";
import { PREVIEW_PARTITION, Pages } from "./pages.ts";
import { ARTIFACT_SCHEME, Workspace } from "./workspace.ts";
import type { Notice } from "./workspace.ts";

/** The built-in pages are served as `app://xsb/…` from this directory, never as file:// URLs. */
const APP_SCHEME = "app";
const RENDERER = fileURLToPath(new URL("../renderer/", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./preload.cjs", import.meta.url));

/** Set up once this is known to be the one running app, and before any hub is started: the hub inherits the PATH it sets up, and finds the agents' programs on it. */
let clis: Clis;
let agentClis: AgentClis;

/** The hub's backends, with which of them lack their program. */
async function backends(workspace?: Workspace): Promise<BackendView[]> {
  await clis.refresh();
  const list = workspace ? await workspace.backends() : describeBackends().map((b) => ({ name: b.name, command: [b.command, ...b.args].join(" "), installed: b.installed }));
  return list.map((b) => {
    const cli = wrapped(b.command.split(" ")[0]);
    return { ...b, installed: cli ? !clis.missing(cli) : b.installed, missing: cli && clis.missing(cli) ? cli : undefined,
      cli: cli ? agentCli(cli) : undefined, configPath: cli ? configPath(agentCli(cli)) : undefined };
  });
}

/** The language the user's system is in: what the pages are worded in, and what the hub is told the user reads. */
const language = (): Language => languageOf(app.getPreferredSystemLanguages());

/** The few things main says itself. Everything else a window says is the renderer's (../renderer/text.js). */
type Words = {
  locate: (command: string) => string;
  notRunnable: (file: string) => string;
  noProgram: (agent: string, program: string) => string;
  badAddress: string;
  agentControl: string;
  /** A notification of the system: what became of an agent's work (`Notice`). */
  notice: (n: Notice) => { title: string; body: string };
  /** Asking before a quit that cuts agents short: `names` are theirs. */
  quit: (names: string[]) => { message: string; detail: string; quit: string; stay: string };
  /** The application menu. */
  menu: { settings: string; file: string; newWindow: string; openFolder: string; openRecent: string; clearRecent: string; noRecent: string;
    closeWindow: string; edit: string; view: string; window: string; help: string; reload: string; devTools: string };
  /** Asking before a folder that is not a workspace yet becomes one. */
  makeWorkspace: (folder: string) => { message: string; detail: string; create: string; cancel: string };
};

const TEXT: Record<Language, Words> = {
  en: {
    locate: (command) => `Locate the ${command} program`,
    notRunnable: (file) => `${file} is not a program that can be run`,
    noProgram: (agent, program) => `Agent "${agent}" runs on ${program}, and the ${program} program was not found on your PATH. Install it, or open this agent's settings and use "Locate…" next to its backend.`,
    badAddress: "Enter a valid address: http, https, file://, or an absolute file path.",
    agentControl: "Agent is operating this page",
    notice: ({ kind, name, detail }) =>
      ({
        done: { title: `${name} finished`, body: "All work is done. Nobody is working now." },
        failed: { title: `${name}: something failed`, body: detail },
        confirm: { title: `${name} needs your decision`, body: detail },
        permission: { title: `${name} asks for permission`, body: detail },
      })[kind],
    quit: (names) => ({
      message: names.length === 1 ? `${names[0]} is still working` : `${names.length} agents are still working`,
      detail: `${names.length > 1 ? `${names.join(", ")}. ` : ""}Quitting stops the work in progress. It will not continue when you open xsb again: unfinished tasks are cancelled, and you will have to ask for them again.`,
      quit: "Quit anyway",
      stay: "Keep working",
    }),
    menu: { settings: "Settings…", file: "File", newWindow: "New Window", openFolder: "Open Folder…", openRecent: "Open Recent", clearRecent: "Clear Recently Opened",
      noRecent: "No Recent Folders", closeWindow: "Close Window", edit: "Edit", view: "View", window: "Window", help: "Help", reload: "Reload", devTools: "Developer Tools" },
    makeWorkspace: (folder) => ({ message: `Make ${path.basename(folder)} a workspace?`, detail: `xsb keeps its conversations, workflows and assets in a .xsb2 folder inside:\n${folder}`, create: "Make Workspace", cancel: "Cancel" }),
  },
  "zh-CN": {
    locate: (command) => `选择 ${command} 程序`,
    notRunnable: (file) => `${file} 不是可执行文件`,
    noProgram: (agent, program) => `智能体“${agent}”要用 ${program}，但在 PATH 中没有找到 ${program} 程序。请安装它，或打开这个智能体的设置，在后端旁点“指定路径…”。`,
    badAddress: "请输入有效地址，支持 http、https、file:// 或绝对文件路径。",
    agentControl: "Agent 正在操作网页",
    notice: ({ kind, name, detail }) =>
      ({
        done: { title: `${name}完成了工作`, body: "工作已全部完成，现在没有智能体在工作。" },
        failed: { title: `${name}：有工作失败了`, body: detail },
        confirm: { title: `${name}需要你确认`, body: detail },
        permission: { title: `${name}请求授权`, body: detail },
      })[kind],
    quit: (names) => ({
      message: names.length === 1 ? `${names[0]}还在工作` : `还有 ${names.length} 个智能体在工作`,
      detail: `${names.length > 1 ? `${names.join("、")}。` : ""}退出会中断正在进行的工作。再次打开 xsb 时它不会自动继续：未完成的任务记为已取消，需要你重新交代。`,
      quit: "仍然退出",
      stay: "继续工作",
    }),
    menu: { settings: "设置…", file: "文件", newWindow: "新建窗口", openFolder: "打开文件夹…", openRecent: "打开最近的工作区", clearRecent: "清除最近打开记录",
      noRecent: "没有最近打开的工作区", closeWindow: "关闭窗口", edit: "编辑", view: "视图", window: "窗口", help: "帮助", reload: "重新加载", devTools: "开发者工具" },
    makeWorkspace: (folder) => ({ message: `把“${path.basename(folder)}”设为工作区？`, detail: `xsb 会在这个文件夹里新建 .xsb2 目录，保存会话、工作流和资产：\n${folder}`, create: "设为工作区", cancel: "取消" }),
  },
};

/**
 * What went wrong, in the user's language. The hub cannot know that the wrapper it misses ships with this app:
 * what the user lacks then is the program the wrapper is built around.
 */
function say(e: unknown): string {
  const facts = (e as { data?: { agent?: string; command?: string } }).data;
  const program = reasonOf(e) === "backend_not_installed" && facts?.command ? wrapped(facts.command) : undefined;
  return program ? TEXT[language()].noProgram(facts!.agent ?? "", program) : explain(e, language());
}

/** Ask the user where a program is. Whether they said. */
async function locateProgram(win: BrowserWindow, command: string): Promise<boolean> {
  const text = TEXT[language()];
  const { filePaths } = await dialog.showOpenDialog(win, { title: text.locate(command), properties: ["openFile", "showHiddenFiles"] });
  if (!filePaths[0]) return false;
  if (!clis.setPath(command, filePaths[0])) throw new Error(text.notRunnable(filePaths[0]));
  return true;
}

/** Confirmation lives in main: an IPC caller cannot create a missing config without this user decision. */
async function revealCliConfig(win: BrowserWindow, name: "codex" | "claude"): Promise<boolean> {
  let config = await agentClis.config(name);
  if (!config.exists) {
    const zh = language() === "zh-CN";
    const choice = await dialog.showMessageBox(win, {
      type: "info",
      message: zh ? `创建 ${name === "claude" ? "Claude Code" : "Codex"} 配置文件？` : `Create a ${name === "claude" ? "Claude Code" : "Codex"} configuration file?`,
      detail: zh
        ? `这个文件还不存在，将使用模板创建：\n${config.path}\n\n${name === "codex" ? "默认只读，执行命令需要确认。可修改字段附有注释。" : "默认请求操作确认。字段说明保存在旁边的 settings.README.md。"}\n\n创建后会在文件管理器中显示。使用前仍需登录，或按说明配置你的服务。`
        : `This file does not exist yet. A template will be created at:\n${config.path}\n\n${name === "codex" ? "Read-only by default, with command approval. Editable fields have comments." : "Operations request approval by default. Field notes are in the adjacent settings.README.md."}\n\nThen it will be shown in your file manager. Sign in or configure your provider before use.`,
      buttons: zh ? ["取消", "创建并查看"] : ["Cancel", "Create and show"], defaultId: 1, cancelId: 0,
    });
    if (choice.response !== 1) return false;
    config = await agentClis.config(name, true, language());
  }
  shell.showItemInFolder(config.path);
  return true;
}

/** webContents id -> the project its window has open. */
const windows = new Map<number, string>();
/**
 * Project -> its workspace: the app's connection to the project's hub. It stays while the app runs, whether or not
 * a window shows it, for quitting asks every hub the app started whether agents are at work.
 */
const projects = new Map<string, Workspace>();
/** Projects whose connection is being made: a window that opens one meanwhile waits for the same. */
const connecting = new Map<string, Promise<Workspace>>();

const workspaceOf = (id: number): Workspace | undefined => projects.get(windows.get(id) ?? "");

/** The user's tool servers changed: the hubs they reach let their conversations take them. Answers the new list. */
async function toolsChanged(scope: "global" | "project", workspace: Workspace | undefined) {
  const reached = scope === "global" ? [...projects.values()] : workspace ? [workspace] : [];
  await Promise.all(reached.map((w) => w.applyTools().catch(() => undefined)));
  return listPlugins(workspace?.paths);
}

/** Tell a project's workspace whether a window shows it: with none, nobody is there to answer its agents' questions. */
const showing = (project: string): void => projects.get(project)?.setShown([...windows.values()].includes(project));
/** The user asked the app to quit: from then on a window that closes is closed. */
let quitting = false;
/** The user quit while agents were at work, having been asked: their hubs give that work up. */
let abandoning = false;
/** Windows on their way out: closed by the user, not gone yet. They no longer count as windows the app has. */
const leaving = new Set<number>();
/** webContents id -> the web pages of its window's side panel. */
const panels = new Map<number, Pages>();

// ---- recently opened workspaces ---------------------------------------------

type Recent = { name: string; path: string };
const recentFile = (): string => path.join(app.getPath("userData"), "recent.json");

function recent(): Recent[] {
  try {
    return JSON.parse(fs.readFileSync(recentFile(), "utf8"));
  } catch {
    return [];
  }
}

function remember(project: string): void {
  const list = [{ name: path.basename(project), path: project }, ...recent().filter((r) => r.path !== project)].slice(0, 10);
  fs.writeFileSync(recentFile(), JSON.stringify(list, null, 2));
  buildMenu();
}

// ---- the application menu ---------------------------------------------------

/** The app's window in front, if any. */
const focusedAppWindow = (): BrowserWindow | undefined => {
  const win = BrowserWindow.getFocusedWindow();
  return win && panels.has(win.webContents.id) ? win : undefined;
};

/**
 * Open a folder as the workspace of a window, as VS Code does: in the window in front, replacing what it showed (its
 * hub and agents go on), or in a new window when there is none. A folder that is not a workspace yet is asked about.
 */
async function openFolder(project?: string): Promise<void> {
  const win = focusedAppWindow();
  let folder = project;
  if (!folder) {
    const picked = win ? await pickFolder(win) : await pickFolderFree();
    if (!picked) return;
    if (!picked.initialized) {
      const words = TEXT[language()].makeWorkspace(picked.path);
      const options = { type: "question" as const, message: words.message, detail: words.detail, buttons: [words.cancel, words.create], defaultId: 1, cancelId: 0 };
      const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      if (response !== 1) return;
    }
    folder = picked.path;
  }
  if (!win) return createWindow(folder);
  try {
    if (await openWorkspace(win, folder)) win.webContents.send("xsb:event", { workspaceChanged: true } satisfies Event);
  } catch (e) {
    dialog.showErrorBox("xsb", say(e));
  }
}

async function pickFolderFree(): Promise<{ path: string; initialized: boolean } | null> {
  const { filePaths } = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  if (!filePaths[0]) return null;
  return { path: filePaths[0], initialized: fs.existsSync(new Paths(filePaths[0]).dir) };
}

/** Built again when the recent folders change. */
function buildMenu(): void {
  const words = TEXT[language()].menu;
  const mac = process.platform === "darwin";
  const settings: Electron.MenuItemConstructorOptions = { label: words.settings, accelerator: "CmdOrCtrl+,",
    click: () => focusedAppWindow()?.webContents.send("xsb:event", { openSettings: true } satisfies Event) };
  const recents = recent();
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" as const, submenu: [{ role: "about" as const }, { type: "separator" as const }, settings, { type: "separator" as const },
      { role: "services" as const }, { type: "separator" as const }, { role: "hide" as const }, { role: "hideOthers" as const }, { role: "unhide" as const },
      { type: "separator" as const }, { role: "quit" as const }] }] : []),
    { label: words.file, submenu: [
      { label: words.newWindow, accelerator: "CmdOrCtrl+Shift+N", click: () => void createWindow() },
      { type: "separator" },
      { label: words.openFolder, accelerator: "CmdOrCtrl+O", click: () => void openFolder() },
      { label: words.openRecent, submenu: recents.length
        ? [...recents.map((r) => ({ label: r.path.replace(os.homedir(), "~"), click: () => void openFolder(r.path) })),
           { type: "separator" as const }, { label: words.clearRecent, click: () => { fs.writeFileSync(recentFile(), "[]"); buildMenu(); } }]
        : [{ label: words.noRecent, enabled: false }] },
      { type: "separator" },
      ...(mac ? [] : [settings, { type: "separator" as const }]),
      { label: words.closeWindow, accelerator: "CmdOrCtrl+W", role: "close" },
      ...(mac ? [] : [{ role: "quit" as const }]),
    ] },
    { label: words.edit, role: "editMenu" },
    { label: words.view, submenu: [
      { label: words.reload, role: "reload" }, { label: words.devTools, role: "toggleDevTools" }, { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" },
    ] },
    { label: words.window, role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- windows ----------------------------------------------------------------

// ---- one window per workspace -----------------------------------------------

/** A folder as one name: absolute, with links resolved, so two spellings of it are the same workspace. */
function canonical(folder: string): string {
  const resolved = path.resolve(folder);
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

/** The window that shows a workspace, if one does (`except`: not this one). Windows on their way out do not count. */
function windowShowing(project: string, except?: BrowserWindow): BrowserWindow | undefined {
  for (const [id, shown] of windows) {
    if (shown !== project || leaving.has(id) || id === except?.webContents.id) continue;
    const contents = webContents.fromId(id);
    const win = contents && BrowserWindow.fromWebContents(contents);
    if (win && !win.isDestroyed()) return win;
  }
  return undefined;
}

/** Bring a window to the front, the hidden last one included. */
function bringForward(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** A workspace is open in one window at most: opening it again brings that window forward instead. */
async function createWindow(project?: string): Promise<void> {
  const existing = project && windowShowing(canonical(project));
  if (existing) return bringForward(existing);
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    webPreferences: { preload: PRELOAD, webview2Tag: Pages.supported } as WebPreferences,
  });
  const id = win.webContents.id;
  const pages = new Pages(win.webContents, { preload: PRELOAD, pageWindowUrl: `${APP_SCHEME}://xsb/page.html`, controlText: TEXT[language()].agentControl });
  panels.set(id, pages);
  // A window shows the app and nothing else. A link in what an agent wrote opens as a page
  // of the side panel, or in the user's browser where there are no such pages.
  const follow = (url: string): void => {
    if (!/^https?:/.test(url)) return;
    if (Pages.supported) pages.open(url);
    else void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => (follow(url), { action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    follow(url);
  });
  win.webContents.on("context-menu", (_event, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (params.isEditable) items.push({ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" });
    if (params.selectionText || params.isEditable) items.push({ role: "copy" });
    if (params.isEditable) items.push({ role: "paste" }, { role: "selectAll" });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  // The last window does not close: it hides, with its workspace as it is, until the app is shown again or quits.
  win.on("close", (event) => {
    if (quitting || panels.size - leaving.size > 1) return void leaving.add(id);
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => {
    leaving.delete(id);
    const project = windows.get(id);
    windows.delete(id);
    if (project) showing(project);
    pages.dispose();
    panels.delete(id);
  });
  if (project) await openWorkspace(win, project).catch((e) => dialog.showErrorBox("xsb", say(e)));
  await win.loadURL(`${APP_SCHEME}://xsb/index.html`);
}

/** The project's workspace, connected: the one there is, or a new connection when there is none or it was lost. */
function connect(paths: Paths): Promise<Workspace> {
  const { project } = paths;
  const current = projects.get(project);
  if (current?.connected) return Promise.resolve(current);
  let pending = connecting.get(project);
  if (!pending) {
    const send = (event: Event): void => {
      for (const [id, shown] of windows) if (shown === project) webContents.fromId(id)?.send("xsb:event", event);
    };
    // One notification, from the first window that shows the workspace: a click brings it to the agent.
    const notify = (n: Notice): void => {
      const [id] = [...windows].find(([, shown]) => shown === project) ?? [];
      const contents = id === undefined ? undefined : webContents.fromId(id);
      const win = contents && BrowserWindow.fromWebContents(contents);
      if (!win) return;
      const { title, body } = TEXT[language()].notice(n);
      notice(win, title, body, () => win.webContents.send("xsb:event", { showAgent: n.agentId } satisfies Event));
    };
    pending = Workspace.open(paths, language(), say, send, notify)
      .then((created) => {
        current?.close();
        projects.set(project, created);
        return created;
      })
      .finally(() => connecting.delete(project));
    connecting.set(project, pending);
  }
  return pending;
}

/**
 * Show a workspace in a window. When another window shows it already, that one comes forward and this one stays as it
 * was: the answer is false.
 */
async function openWorkspace(win: BrowserWindow, project: string): Promise<boolean> {
  const other = windowShowing(canonical(project), win);
  if (other) {
    bringForward(other);
    return false;
  }
  const paths = new Paths(canonical(project));
  await connect(paths);
  if (!win.isDestroyed()) {
    const previous = windows.get(win.webContents.id);
    windows.set(win.webContents.id, paths.project);
    if (previous) showing(previous);
    remember(paths.project);
  }
  showing(paths.project);
  return true;
}

async function pickFolder(win: BrowserWindow): Promise<{ path: string; initialized: boolean } | null> {
  const { filePaths } = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  if (!filePaths[0]) return null;
  return { path: filePaths[0], initialized: fs.existsSync(new Paths(filePaths[0]).dir) };
}

// ---- window.xsb -------------------------------------------------------------

/** The calls that are a method of the window's workspace, arguments and all. */
const WORKSPACE_CALLS = new Set(["composerState","setComposerOption","newSession","setAvatar","setBackend","workflowControl","history","send","cancel","clear","permit"]);

ipcMain.on("xsb:language", (event) => {
  event.returnValue = language();
});

/** What a window asks of main. An error reaches it worded in the user's language. */
ipcMain.handle("xsb", async (event, method: string, ...args: any[]) => {
  try {
    return await call(event, method, args);
  } catch (e) {
    throw new Error(say(e));
  }
});

function call(event: Electron.IpcMainInvokeEvent, method: string, args: any[]): unknown {
  const win = BrowserWindow.fromWebContents(event.sender)!;
  const workspace = workspaceOf(event.sender.id);
  // The caller's pages: those of its side panel, or, for a page's own window, those the page is among.
  const pages = panels.get(event.sender.id) ?? [...panels.values()].find((p) => p.shownIn(event.sender));
  if (!pages) throw new Error("this window is closing");
  switch (method) {
    case "readClipboardImages": {
      const formats = clipboard.availableFormats();
      const fileUrl = formats.includes("public.file-url") ? clipboard.readBuffer("public.file-url").toString("utf8").replace(/\0+$/, "") : "";
      const images = imagesFromPaths(fileUrl || clipboard.readText(), (file) => nativeImage.createFromPath(file).toPNG());
      if (images) return images;
      // A copied non-image file can include an icon/thumbnail; that is not the attachment.
      if (fileUrl || formats.includes("NSFilenamesPboardType")) return null;
      const image = clipboard.readImage();
      return image.isEmpty() ? null : [{ type: "image", mimeType: "image/png", data: image.toPNG().toString("base64") }];
    }
    case "copyText":
      if (typeof args[0] !== "string") throw new Error("text is required");
      return clipboard.writeText(args[0]);
    case "revealArtifact": {
      if (!workspace) throw new Error("this window has no workspace open");
      const artifact = workspace.artifacts.get(args[0]);
      if (!artifact) throw new Error("unknown artifact");
      if (!fs.statSync(artifact.id, { throwIfNoEntry: false })?.isFile()) throw new Error("file not found");
      return shell.showItemInFolder(artifact.id);
    }
    case "openArtifact":
      if (!workspace) throw new Error("this window has no workspace open");
      return workspace.openArtifact(args[0], args[1], args[2]);
    case "openPage":
      if (Pages.supported) return pages.open(args[0], { embedded: args[1] === true, sessionId: args[2] });
      if (args[1] !== true && /^https?:\/\//i.test(args[0])) return shell.openExternal(args[0]);
      return null;
    case "page":
      try {
        if (args[1] === "bounds") return pages.layout(args[0], event.sender, args[2]);
        if (args[1] === "controlBounds") return pages.controlLayout(args[0], event.sender, args[2]);
        return pages.call(args[0], args[1], args[2]);
      } catch (e) {
        throw e instanceof BadAddress ? new Error(TEXT[language()].badAddress) : e;
      }
    case "pageWindow":
      return pages.shownIn(event.sender);
    case "load":
      return workspace
        ? workspace.load().then(async (snapshot) => ({ ...snapshot, backends: await backends(workspace), pages: Pages.supported ? pages.list() : null }))
        : { workspace: null, recent: recent() };
    case "pickFolder":
      return pickFolder(win);
    case "open":
      return openWorkspace(win, args[0]);
    case "backends":
      return backends(workspace);
    case "locateProgram":
      return locateProgram(win, args[0]);
    case "cliConfig":
      return agentClis.config(agentCli(args[0]));
    case "revealCliConfig":
      return revealCliConfig(win, agentCli(args[0]));
    case "installCli":
      return agentClis.install(agentCli(args[0]));
    case "checkCli":
      return agentClis.check(agentCli(args[0]));
    case "newWindow":
      return createWindow();
    // Plugins (hub's plugins.ts): folders the user puts in place. The machine's reach every open project.
    case "plugins":
      return listPlugins(workspace?.paths);
    case "setPluginEnabled":
      setPluginEnabled(args[0], args[1], args[2] === true, workspace?.paths);
      return toolsChanged(args[0], workspace);
    case "approvePlugin":
      if (!workspace) throw new Error("this window has no workspace open");
      approvePlugin(workspace.paths, args[0]);
      return toolsChanged("project", workspace);
    // Limits are the machine's (~/.xsb2_global/config.json): per backend, and the hub's. The hub reads them on every use.
    case "limitSettings":
      return limitSettings();
    case "setLimit":
      return setLimit(args[0] ?? null, args[1], args[2]);
    // The workspace's working language (.xsb2/config.json).
    case "projectLanguage":
      if (!workspace) throw new Error("this window has no workspace open");
      return projectLanguageSetting(workspace.paths) ?? null;
    case "setProjectLanguage":
      if (!workspace) throw new Error("this window has no workspace open");
      return setProjectLanguage(workspace.paths, args[0]);
    case "reloadPlugins":
      return toolsChanged("global", workspace);
    case "revealPlugins":
      return shell.openPath(ensurePluginRoot(args[0], workspace?.paths));
  }
  if (!workspace) throw new Error("this window has no workspace open");
  if (WORKSPACE_CALLS.has(method)) return (workspace as any)[method](...args);
  throw new Error(`unknown method ${method}`);
}

// ---- app --------------------------------------------------------------------

// Two schemes, two origins. The app's own pages are `app://xsb/…`. Artifacts
// (files agents wrote) are `xsb-artifact://…`: the renderer can show one in
// <img>, <iframe> or fetch() without access to the file system, and what an
// agent wrote never runs in the app's origin.
const web = { standard: true, secure: true, supportFetchAPI: true };
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: web },
  { scheme: ARTIFACT_SCHEME, privileges: { ...web, corsEnabled: true } },
]);

/** Types of the files that are read in ranges. Everything else is read whole, and Chromium names its type. */
const RANGED: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

/** A file as the answer to a request. A video is asked for in ranges and plays only if answered in ranges. */
function serveFile(file: string, request: Request): Response | Promise<Response> {
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (!range || !(range[1] || range[2])) return net.fetch(pathToFileURL(file).href);
  const size = fs.statSync(file, { throwIfNoEntry: false })?.size;
  if (size === undefined) return new Response(null, { status: 404 });
  // "a-b", "a-" (from a to the end) or "-n" (the last n bytes)
  const start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream, {
    status: 206,
    headers: {
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
      "content-type": RANGED[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    },
  });
}

/** The folder a command line names, if it names one: `xsb <folder>` opens that workspace straight away. */
const folderOf = (argv: string[], cwd: string): string | undefined => {
  const folder = argv.slice(app.isPackaged ? 1 : 2).find((arg) => !arg.startsWith("-"));
  return folder && path.resolve(cwd, folder);
};

/** Bring the app in front of the user: a window of it, the hidden one included, or a new one when it has none. */
function reveal(): void {
  const win = BrowserWindow.getAllWindows().find((w) => panels.has(w.webContents.id));
  if (!win) return void createWindow();
  bringForward(win);
}

// One app. A second start hands over the folder it was asked to open and goes away. The folder travels as data:
// the command line the first one is shown has been rearranged by Chromium, and names the folder no longer.
const first = app.requestSingleInstanceLock({ folder: folderOf(process.argv, process.cwd()) });
if (!first) app.quit();
app.on("second-instance", (_event, _argv, _cwd, asked) => {
  const { folder } = asked as { folder?: string };
  if (folder) void createWindow(folder);
  else reveal();
});

void app.whenReady().then(() => {
  if (!first) return;
  setUpNotices();
  buildMenu();
  clis = new Clis(path.join(app.getPath("userData"), "backends"));
  agentClis = new AgentClis(clis, path.join(app.getPath("userData"), "backends", "installed"));
  protocol.handle(APP_SCHEME, (request) => {
    const file = path.join(RENDERER, decodeURIComponent(new URL(request.url).pathname));
    const inside = !path.relative(RENDERER, file).startsWith("..");
    return inside && fs.existsSync(file) ? net.fetch(pathToFileURL(file).href) : new Response(null, { status: 404 });
  });
  // Artifacts are served to the app's own pages and to the previews of HTML artifacts (pages.ts), not to websites.
  for (const served of [protocol, session.fromPartition(PREVIEW_PARTITION).protocol]) {
    served.handle(ARTIFACT_SCHEME, async (request) => {
      const url = new URL(request.url);
      if (url.hostname === "history") {
        const workspace = projects.get(url.searchParams.get("workspace") ?? "");
        if (!workspace) return new Response(null, { status: 404 });
        try {
          const image = await workspace.historyImage(url.searchParams.get("ref") ?? "");
          return new Response(Buffer.from(image.data, "base64"), { headers: { "Content-Type": image.mimeType, "Cache-Control": "private, max-age=3600" } });
        } catch { return new Response(null, { status: 404 }); }
      }
      const file = decodeURIComponent(new URL(request.url).pathname.slice(1));
      const shown = [...projects.values()].some((w) => w.artifacts.has(file));
      return shown ? serveFile(file, request) : new Response(null, { status: 404 });
    });
  }
  // Agents reach the browser of the side panel here (browser.ts): each the one of the window its workspace is open in.
  const browser = serveBrowser(clis.browserSocket, (cwd) => {
    const [id, project] = [...windows].find(([, project]) => projects.get(project)?.worksIn(cwd)) ?? [];
    const pages = id === undefined ? undefined : panels.get(id);
    return pages && project ? { pages, project, sessionOf: agentId => projects.get(project)?.sessionOwner(agentId) } : undefined;
  });
  app.on("will-quit", () => browser.close());
  void createWindow(folderOf(process.argv, process.cwd()));
});

app.on("activate", reveal);
// Quitting in the middle of work is the user's to decide, knowing what it costs.
app.on("before-quit", (event) => {
  if (quitting) return;
  const names = [...projects.values()].flatMap((workspace) => workspace.working());
  if (names.length) {
    const text = TEXT[language()].quit(names);
    const stay = dialog.showMessageBoxSync({ type: "warning", message: text.message, detail: text.detail, buttons: [text.quit, text.stay], defaultId: 1, cancelId: 1 }) === 1;
    if (stay) return event.preventDefault();
    abandoning = true;
  }
  quitting = true;
});
// The hubs go with the app. Each stops in its own time. What a hub was in the middle of runs again when it is
// next started, unless the user was asked and quit all the same: then it is given up.
app.on("will-quit", () => {
  for (const [project, workspace] of projects) {
    workspace.close();
    stopHub(new Paths(project), abandoning);
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
