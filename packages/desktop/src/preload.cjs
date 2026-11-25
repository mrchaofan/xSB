// The renderer's whole view of the outside: `window.xsb`. Every method is one
// IPC call to main (main.ts decides what it means); `on` receives main's events.
// The shapes are in bridge.ts.
// CommonJS because a sandboxed preload cannot be an ES module.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const METHODS = [
  "load", "pickFolder", "open", "newWindow",
  "history", "send", "cancel", "clear", "permit",
  "composerState", "setComposerOption", "newSession", "setAvatar", "workflowControl", "backends", "locateProgram", "cliConfig", "revealCliConfig", "installCli", "checkCli",
  "openPage", "page", "pageWindow",
  "limitSettings", "setLimit", "projectLanguage", "setProjectLanguage",
  "plugins", "setPluginEnabled", "approvePlugin", "reloadPlugins", "revealPlugins",
  "readClipboardImages", "copyText", "openArtifact", "revealArtifact",
];

/** Electron wraps a handler's error; the renderer shows only what main said, which is worded for the user (main.ts). */
const call = (method) => (...args) =>
  ipcRenderer.invoke("xsb", method, ...args).catch((e) => {
    throw new Error(e.message.replace(/^Error invoking remote method 'xsb': (\w*Error: )?/, ""));
  });

contextBridge.exposeInMainWorld("xsb", {
  // The language the user reads, which the pages word everything in. Known before a page draws anything.
  language: ipcRenderer.sendSync("xsb:language"),
  ...Object.fromEntries(METHODS.map((method) => [method, call(method)])),
  // Where a pasted or dropped file is on disk. Only the preload can ask; a page cannot read a File's path.
  pathOf: (file) => webUtils.getPathForFile(file),
  on: (listener) => void ipcRenderer.on("xsb:event", (_event, event) => listener(event)),
});
