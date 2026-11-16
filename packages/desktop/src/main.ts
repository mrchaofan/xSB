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
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, app, dialog, ipcMain, net, protocol, session, shell } from "electron";
import type { WebPreferences } from "electron";
import { Paths, stopHub } from "@xsb/hub";
import { explain, languageOf, reasonOf } from "@xsb/protocol";
import type { Language } from "@xsb/protocol";
import type { BackendView } from "./bridge.ts";
import { serveBrowser } from "./browser.ts";
import { AGENTS, Clis, wrapped } from "./clis.ts";
import { PREVIEW_PARTITION, Pages } from "./pages.ts";
import { ARTIFACT_SCHEME, Workspace } from "./workspace.ts";

/** The built-in pages are served as `app://xsb/…` from this directory, never as file:// URLs. */
const APP_SCHEME = "app";
const RENDERER = fileURLToPath(new URL("../renderer/", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./preload.cjs", import.meta.url));

// Before any hub is started: the hub inherits the PATH this sets up, and finds the agents' programs on it.
const clis = new Clis(path.join(app.getPath("userData"), "backends"));

/** The hub's backends, with which of them lack their program. */
async function backends(workspace: Workspace): Promise<BackendView[]> {
  return (await workspace.backends()).map((b) => ({ ...b, missing: AGENTS[b.name] && clis.missing(AGENTS[b.name]) ? AGENTS[b.name] : undefined }));
}

/** The language the user's system is in: what the pages are worded in, and what the hub is told the user reads. */
const language = (): Language => languageOf(app.getPreferredSystemLanguages());

/** The few things main says itself. Everything else a window says is the renderer's (../renderer/text.js). */
type Words = {
  locate: (command: string) => string;
  notRunnable: (file: string) => string;
  noProgram: (agent: string, program: string) => string;
  /** Asking before a quit that cuts agents short: `names` are theirs. */
  quit: (names: string[]) => { message: string; detail: string; quit: string; stay: string };
};

const TEXT: Record<Language, Words> = {
  en: {
    locate: (command) => `Locate the ${command} program`,
    notRunnable: (file) => `${file} is not a program that can be run`,
    noProgram: (agent, program) => `Agent "${agent}" runs on ${program}, and the ${program} program was not found on your PATH. Install it, or open this agent's settings and use "Locate…" next to its backend.`,
    quit: (names) => ({
      message: names.length === 1 ? `${names[0]} is still working` : `${names.length} agents are still working`,
      detail: `${names.length > 1 ? `${names.join(", ")}. ` : ""}Quitting stops the work in progress. It will not continue when you open xsb again: unfinished tasks are cancelled, and you will have to ask for them again.`,
      quit: "Quit anyway",
      stay: "Keep working",
    }),
  },
  "zh-CN": {
    locate: (command) => `选择 ${command} 程序`,
    notRunnable: (file) => `${file} 不是可执行文件`,
    noProgram: (agent, program) => `智能体“${agent}”要用 ${program}，但在 PATH 中没有找到 ${program} 程序。请安装它，或打开这个智能体的设置，在后端旁点“指定路径…”。`,
    quit: (names) => ({
      message: names.length === 1 ? `${names[0]}还在工作` : `还有 ${names.length} 个智能体在工作`,
      detail: `${names.length > 1 ? `${names.join("、")}。` : ""}退出会中断正在进行的工作。再次打开 xsb 时它不会自动继续：未完成的任务记为已取消，需要你重新交代。`,
      quit: "仍然退出",
      stay: "继续工作",
    }),
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

/** webContents id -> the workspace its window has open. */
const workspaces = new Map<number, Workspace>();
/** Every project opened since the app started: the hubs to stop when it quits. */
const opened = new Set<string>();
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
}

// ---- windows ----------------------------------------------------------------

async function createWindow(project?: string): Promise<void> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    webPreferences: { preload: PRELOAD, webview2Tag: Pages.supported } as WebPreferences,
  });
  const id = win.webContents.id;
  const pages = new Pages(win.webContents, { preload: PRELOAD, pageWindowUrl: `${APP_SCHEME}://xsb/page.html` });
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
  // The last window does not close: it hides, with its workspace as it is, until the app is shown again or quits.
  win.on("close", (event) => {
    if (quitting || panels.size - leaving.size > 1) return void leaving.add(id);
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => {
    leaving.delete(id);
    workspaces.get(id)?.close();
    workspaces.delete(id);
    pages.dispose();
    panels.delete(id);
  });
  if (project) await openWorkspace(win, project).catch((e) => dialog.showErrorBox("xsb", say(e)));
  await win.loadURL(`${APP_SCHEME}://xsb/index.html`);
}

async function openWorkspace(win: BrowserWindow, project: string): Promise<void> {
  const paths = new Paths(project);
  const workspace = await Workspace.open(paths, language(), say, (event) => {
    if (!win.isDestroyed()) win.webContents.send("xsb:event", event);
  });
  workspaces.get(win.webContents.id)?.close();
  workspaces.set(win.webContents.id, workspace);
  opened.add(paths.project);
  remember(paths.project);
}

async function pickFolder(win: BrowserWindow): Promise<{ path: string; initialized: boolean } | null> {
  const { filePaths } = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  if (!filePaths[0]) return null;
  return { path: filePaths[0], initialized: fs.existsSync(new Paths(filePaths[0]).dir) };
}

// ---- window.xsb -------------------------------------------------------------

/** The calls that are a method of the window's workspace, arguments and all. */
const WORKSPACE_CALLS = new Set(["send", "sendNow", "cancel", "permit", "putAgent", "removeAgent", "restartAgent", "inspectAgent", "putRole", "removeRole", "testMcp", "roles", "useTeam", "dropTeam"]);

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
  const workspace = workspaces.get(event.sender.id);
  // The caller's pages: those of its side panel, or, for a page's own window, those the page is among.
  const pages = panels.get(event.sender.id) ?? [...panels.values()].find((p) => p.shownIn(event.sender));
  if (!pages) throw new Error("this window is closing");
  switch (method) {
    case "openPage":
      return Pages.supported ? pages.open(args[0], { embedded: args[1] === true }) : null;
    case "page":
      return pages.call(args[0], args[1], args[2]);
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
    case "locateProgram":
      return locateProgram(win, args[0]);
    case "newWindow":
      return createWindow();
  }
  if (!workspace) throw new Error("this window has no workspace open");
  if (method === "backends") return backends(workspace);
  if (method === "presets") return workspace.teams((command) => clis.missing(command));
  if (method === "revealSkill") return shell.openPath(path.join(workspace.paths.roleDir(args[0]), "skills", args[1]));
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
  const size = fs.statSync(file).size;
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
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
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
  protocol.handle(APP_SCHEME, (request) => {
    const file = path.join(RENDERER, decodeURIComponent(new URL(request.url).pathname));
    const inside = !path.relative(RENDERER, file).startsWith("..");
    return inside && fs.existsSync(file) ? net.fetch(pathToFileURL(file).href) : new Response(null, { status: 404 });
  });
  // Artifacts are served to the app's own pages and to the previews of HTML artifacts (pages.ts), not to websites.
  for (const served of [protocol, session.fromPartition(PREVIEW_PARTITION).protocol]) {
    served.handle(ARTIFACT_SCHEME, (request) => {
      const file = decodeURIComponent(new URL(request.url).pathname.slice(1));
      const shown = [...workspaces.values()].some((w) => w.artifacts.has(file));
      return shown ? serveFile(file, request) : new Response(null, { status: 404 });
    });
  }
  // Agents reach the browser of the side panel here (browser.ts): each the one of the window its workspace is open in.
  const browser = serveBrowser(clis.browserSocket, (cwd) => {
    const [id] = [...workspaces].find(([, workspace]) => workspace.worksIn(cwd)) ?? [];
    return id === undefined ? undefined : panels.get(id);
  });
  app.on("will-quit", () => browser.close());
  void createWindow(folderOf(process.argv, process.cwd()));
});

app.on("activate", reveal);
// Quitting in the middle of work is the user's to decide, knowing what it costs.
app.on("before-quit", (event) => {
  if (quitting) return;
  const names = [...workspaces.values()].flatMap((workspace) => workspace.working());
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
  for (const project of opened) stopHub(new Paths(project), abandoning);
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
