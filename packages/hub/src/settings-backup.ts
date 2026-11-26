import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "@xsb/store";
import { globalDir, loadGlobalConfig, machineConfig, replaceGlobalConfig, validateGlobal as validateConfiguration } from "./config.ts";
import type { GlobalConfig } from "./config.ts";

export type SettingsBundle = {
  format: "xsb-settings"; version: 1; config: GlobalConfig;
  plugins: { path: string; data: string; executable: boolean }[];
  ui?: Record<string, string>;
  channels?: unknown;
};
const MAX_BYTES = 128 * 1024 * 1024;

/** Accounts, trust decisions and machine-specific launchers stay on their respective machines. */
export function settingsBundle(): SettingsBundle {
  const { approvedPlugins: _trust, ...config } = loadGlobalConfig();
  const plugins: SettingsBundle["plugins"] = [];
  const root = path.join(globalDir(), "plugins");
  let bytes = 0;
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Plugin backup cannot include a symbolic link: ${file}`);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        bytes += fs.statSync(file).size;
        if (bytes > MAX_BYTES) throw new Error("Plugin backup exceeds 128 MiB");
        plugins.push({ path: path.relative(root, file).split(path.sep).join("/"), data: fs.readFileSync(file).toString("base64"), executable: !!(fs.statSync(file).mode & 0o111) });
      }
    }
  };
  walk(root);
  return { format: "xsb-settings", version: 1, config, plugins };
}

export function validateSettingsBundle(value: unknown): asserts value is SettingsBundle {
  const bundle = value as SettingsBundle;
  if (!bundle || bundle.format !== "xsb-settings" || bundle.version !== 1 || !bundle.config || bundle.config.version !== 1 || !Array.isArray(bundle.plugins)) throw new Error("Invalid xSB settings backup");
  let bytes = 0;
  for (const file of bundle.plugins) {
    const parts = typeof file?.path === "string" ? file.path.split(/[\\/]/) : [];
    if (parts.length < 2 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(parts[0]) || parts.some(p => !p || p === "." || p === ".." || p.includes(":")) || typeof file.data !== "string" || typeof file.executable !== "boolean" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) throw new Error("Invalid plugin backup path or contents");
    bytes += Buffer.byteLength(file.data, "base64");
    if (bytes > MAX_BYTES) throw new Error("Plugin backup exceeds 128 MiB");
  }
  if (bundle.ui && (typeof bundle.ui !== "object" || Array.isArray(bundle.ui) || Object.entries(bundle.ui).some(([key, data]) => !key.startsWith("xsb.ui.") || typeof data !== "string"))) throw new Error("Invalid UI preferences backup");
  if (bundle.channels !== undefined) {
    if (!bundle.channels || typeof bundle.channels !== "object" || Array.isArray(bundle.channels)) throw new Error("Invalid channel bindings");
    for (const [name, value] of Object.entries(bundle.channels)) {
      const binding = value as { profile?: unknown; model?: unknown; baseUrl?: unknown };
      if (!["claude", "codex"].includes(name) || !binding || typeof binding.profile !== "string" || typeof binding.model !== "string" || typeof binding.baseUrl !== "string" || !/^[A-Za-z0-9_.-]+$/.test(binding.profile) || !/^[A-Za-z0-9_.-]+$/.test(binding.model) || !/^https:\/\/[^\s'"]+$/.test(binding.baseUrl)) throw new Error("Invalid channel binding");
    }
  }
}

/** Explicit restore merges plugin files and publishes settings last; repeating a restore is idempotent. */
export function restoreSettingsBundle(bundle: SettingsBundle): void {
  validateSettingsBundle(bundle);
  const root = path.join(globalDir(), "plugins");
  if (fs.lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Cannot restore through a symbolic plugin directory");
  for (const file of bundle.plugins) {
    let current = root;
    for (const part of file.path.split("/")) {
      current = path.join(current, part);
      if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Cannot restore through a symbolic link: ${current}`);
    }
  }
  const { approvedPlugins: _importedTrust, ...config } = bundle.config;
  // Validate the entire configuration before copying any files.
  validateConfiguration(config);
  for (const file of bundle.plugins) atomicWrite(path.join(root, file.path), Buffer.from(file.data, "base64"), file.executable ? 0o700 : 0o600);
  const previous = machineConfig();
  replaceGlobalConfig({ ...config, approvedPlugins: previous.approvedPlugins });
}
