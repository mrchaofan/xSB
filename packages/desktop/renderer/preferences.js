// UI preferences share the app origin across windows. Workspace choices are
// namespaced by the folder; they never change the hub's team configuration.
const GLOBAL_KEY = "xsb.ui.global";
const workspaceKey = (path) => `xsb.ui.workspace:${path}`;
export const GLOBAL_DEFAULTS = { theme: "light", density: "comfortable", showTools: true };
export const WORKSPACE_DEFAULTS = { showCompleted: false };

function read(key, defaults) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    return Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => {
      const value = saved?.[name];
      const valid = name === "theme" ? ["light", "dark", "system"].includes(value)
        : name === "density" ? ["comfortable", "compact"].includes(value)
        : typeof value === "boolean";
      return [name, valid ? value : fallback];
    }));
  } catch { return { ...defaults }; }
}
export const globalPreferences = () => read(GLOBAL_KEY, GLOBAL_DEFAULTS);
export const workspacePreferences = (path) => read(workspaceKey(path), WORKSPACE_DEFAULTS);
export function saveGlobalPreferences(patch) {
  localStorage.setItem(GLOBAL_KEY, JSON.stringify({ ...globalPreferences(), ...patch }));
  applyPreferences();
}
export function saveWorkspacePreferences(path, patch) {
  localStorage.setItem(workspaceKey(path), JSON.stringify({ ...workspacePreferences(path), ...patch }));
}
export function applyPreferences() {
  const prefs = globalPreferences();
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.dataset.density = prefs.density;
  document.documentElement.classList.toggle("hide-tools", !prefs.showTools);
}
export function onPreferencesChanged(listener) {
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === GLOBAL_KEY || e.key?.startsWith("xsb.ui.workspace:")) {
      applyPreferences();
      listener();
    }
  });
}
applyPreferences();
