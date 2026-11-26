// UI preferences share the app origin across windows. Workspace choices are
// namespaced by the folder; they never change the hub's team configuration.
const GLOBAL_KEY = "xsb.ui.global";
const workspaceKey = (path) => `xsb.ui.workspace:${path}`;
export const GLOBAL_DEFAULTS = { theme: "light", showTools: true };
export const WORKSPACE_DEFAULTS = { showCompleted: false };

/** Move folder-keyed UI state to the project's persistent identity; keep old keys as a fallback. */
export function migrateWorkspaceState(workspace) {
  if (!workspace?.id) return;
  const roots = new Set([workspace.path, ...(workspace.previousPaths ?? [])]);
  try {
    for (const key of Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))) {
      if (!key) continue;
      let target;
      for (const prefix of ["xsb.active:", "xsb.ui.workspace:"]) if (key.startsWith(prefix) && roots.has(key.slice(prefix.length))) target = prefix + workspace.id;
      for (const prefix of ["xsb.draft:", "xsb.side:"]) if (key.startsWith(prefix)) {
        let parts;
        try { parts = JSON.parse(key.slice(prefix.length)); } catch { continue; }
        if (Array.isArray(parts) && roots.has(parts[0])) target = prefix + JSON.stringify([workspace.id, ...parts.slice(1)]);
      }
      if (target && localStorage.getItem(target) === null) localStorage.setItem(target, localStorage.getItem(key));
    }
  } catch { /* originals remain available when storage is full */ }
}

function read(key, defaults) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    return Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => {
      const value = saved?.[name];
      const valid = name === "theme" ? ["light", "dark", "system"].includes(value)
        : typeof value === "boolean";
      return [name, valid ? value : fallback];
    }));
  } catch { return { ...defaults }; }
}
export const globalPreferences = () => read(GLOBAL_KEY, GLOBAL_DEFAULTS);
export const workspacePreferences = (path) => read(workspaceKey(path), WORKSPACE_DEFAULTS);
export function saveGlobalPreferences(patch) {
  localStorage.setItem(GLOBAL_KEY, JSON.stringify({ ...globalPreferences(), ...patch }));
  // 系统的窗口按钮在哪（styles.css 按它让位）：macOS 在左上，其余在右上。主窗口和网页窗口都从这里加载。
document.documentElement.dataset.platform = /Mac/.test(navigator.platform) ? "mac" : "other";
applyPreferences();
}
export function saveWorkspacePreferences(path, patch) {
  localStorage.setItem(workspaceKey(path), JSON.stringify({ ...workspacePreferences(path), ...patch }));
}
export function applyPreferences() {
  const prefs = globalPreferences();
  document.documentElement.dataset.theme = prefs.theme;
  delete document.documentElement.dataset.density;
  document.documentElement.classList.toggle("hide-tools", !prefs.showTools);
  syncWindowColors();
}

/** Windows/Linux 右上角的系统按钮自己不跟页面主题走：配色变了就把头部的底色和图标色告诉主进程。 */
export function syncWindowColors() {
  if (document.documentElement.dataset.platform !== "other") return;
  const style = getComputedStyle(document.documentElement);
  globalThis.xsb?.windowColors?.(style.getPropertyValue("--paper").trim(), style.getPropertyValue("--ink-2").trim())?.catch?.(() => {});
}
export function onPreferencesChanged(listener) {
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === GLOBAL_KEY || e.key?.startsWith("xsb.ui.workspace:")) {
      applyPreferences();
      listener();
    }
  });
}
// 系统的窗口按钮在哪（styles.css 按它让位）：macOS 在左上，其余在右上。主窗口和网页窗口都从这里加载。
document.documentElement.dataset.platform = /Mac/.test(navigator.platform) ? "mac" : "other";
applyPreferences();
