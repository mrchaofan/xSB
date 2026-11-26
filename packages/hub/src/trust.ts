import fs from "node:fs";
import path from "node:path";
import { globalDir } from "./config.ts";
import { updateJsonFile } from "./config-files.ts";

export type PluginApproval = { fingerprint: string; project: string; plugin: string; approvedAt: string; revokedAt?: string };
type Trust = { version: 1; approvals: PluginApproval[] };
const file = () => path.join(globalDir(), "trust.json");
function validate(trust: Trust): void {
  if (trust.version !== 1 || !Array.isArray(trust.approvals) || trust.approvals.some(a => !a || typeof a.fingerprint !== "string" || typeof a.project !== "string" || typeof a.plugin !== "string" || typeof a.approvedAt !== "string")) throw new Error("Invalid plugin trust records");
}
function read(): Trust {
  const trust: Trust = fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file(), "utf8")) : { version: 1, approvals: [] };
  validate(trust);
  return trust;
}
export function pluginApprovals(): PluginApproval[] { try { return read().approvals; } catch { return []; } }
export function approvedFingerprints(legacy: Iterable<string>): Set<string> {
  const approved = new Set(legacy);
  for (const record of pluginApprovals()) {
    if (record.revokedAt) approved.delete(record.fingerprint);
    else approved.add(record.fingerprint);
  }
  return approved;
}
export function recordPluginApproval(project: string, plugin: string, fingerprint: string): void {
  updateJsonFile<Trust>(file(), read, trust => ({ version: 1, approvals: [...trust.approvals.filter(a => a.fingerprint !== fingerprint), { project, plugin, fingerprint, approvedAt: new Date().toISOString() }] }), validate);
}
export function revokePluginApproval(fingerprint: string): void {
  updateJsonFile<Trust>(file(), read, trust => ({ version: 1, approvals: [...trust.approvals.filter(a => a.fingerprint !== fingerprint), { fingerprint, project: "", plugin: "", approvedAt: "", revokedAt: new Date().toISOString() }] }), validate);
}
