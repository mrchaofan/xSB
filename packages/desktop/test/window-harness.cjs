// Window tests: run after building the desktop app. The test file runs again inside Electron, which opens the
// actual app, the real Hub daemon and a scripted ACP backend (hub/test/mock-agent.ts) in an isolated workspace.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
/** Runs `body` with the open window and helpers for driving it; the process exits with the result. */
exports.windowTest = (file, body) => {
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-window-"));
  try {
    const env = { ...process.env, XSB_TEST_NODE: process.execPath, XSB_TEST_PROFILE: scratch };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require("node:child_process").spawnSync(require("electron"), [file], {
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
      ...(process.env.XSB_TEST_CAPABILITY_AGENT ? { capabilities: { command: process.env.XSB_TEST_NODE, args: [path.join(root, "packages/hub/test/capability-agent.ts")] } } : {}),
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
  await body({ win, js, q, click, draft, send, has, until, untilJS, workspace, root });
})().then(
  () => app.exit(0),
  (e) => {
    console.error(e);
    app.exit(1);
  },
);
};
