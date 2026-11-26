/**
 * Where things live. The project directory is the one holding `.xsb2/`. The name is new with the
 * conversation layout: a `.xsb/` of the earlier, role-based layout is another program's data and is never read.
 *
 *   .xsb2/
 *     config.json                      project settings (machine settings: ~/.xsb2_global/config.json)
 *     conversations/agents.jsonl       the conversations' agents (event log)
 *     conversations/sessions.jsonl     sessions and the backend session each maps to
 *     conversations/tasks.jsonl …      dispatched work, joins, mailbox, ledger, assets index
 *     wal.jsonl                        write-ahead log for multi-file changes
 *     agents/<id>/instructions.md      what this agent is (free text, user-edited)
 *     agents/<id>/memory.jsonl         the agent's own notes, by topic
 *     agents/<id>/sessions/<sid>.jsonl transcript of one session
 *     agents/<id>/scratch/             the agent's own drafts and intermediate files
 *     shared/                          files agents hand to each other
 *     assets/                          the asset library's files
 *     run/                             lock, pid, sockets, log of the running hub
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateJsonFile } from "./config-files.ts";
import { globalDir } from "./config.ts";

export type PathRef = { base: "project" | "data" | "external"; path: string };
type ProjectIdentity = { version: 1; id: string; root: string; previousRoots: string[] };

/** The project's own directory. Machine settings stay in `~/.xsb2_global` (config.ts, `globalDir`). */
export const DIR = ".xsb2";

/** Companion executables live next to the source or bundled module. */
export const shipped = (name: string): string => fileURLToPath(new URL(`../${name}/`, import.meta.url));

export function findProject(start = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, DIR))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export class Paths {
  readonly project: string;
  readonly dir: string;
  moved = false;
  private identity?: ProjectIdentity;

  constructor(project: string) {
    this.project = path.resolve(project);
    this.dir = path.join(this.project, DIR);
  }

  prepare(legacyRoot?: string): void {
    if (this.dir === globalDir()) throw new Error("The global configuration directory must differ from the project data directory");
    const file = path.join(this.dir, "project.json");
    const read = (): ProjectIdentity => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, id: randomUUID(), root: legacyRoot ?? this.project, previousRoots: [] };
    const validate = (value: ProjectIdentity) => {
      if (value.version !== 1 || typeof value.id !== "string" || typeof value.root !== "string" || !path.isAbsolute(value.root) || !Array.isArray(value.previousRoots) || value.previousRoots.some(p => typeof p !== "string" || !path.isAbsolute(p))) throw new Error("Invalid project identity");
    };
    this.identity = updateJsonFile(file, read, value => {
      validate(value);
      this.moved = value.root !== this.project;
      return { ...value, root: this.project, previousRoots: [...new Set([...value.previousRoots, ...(this.moved ? [value.root] : [])])] };
    }, validate);
  }

  get projectId(): string {
    try { return this.identity?.id ?? JSON.parse(fs.readFileSync(path.join(this.dir, "project.json"), "utf8")).id ?? this.project; }
    catch { return this.project; }
  }
  get previousRoots(): string[] {
    try { return this.identity?.previousRoots ?? JSON.parse(fs.readFileSync(path.join(this.dir, "project.json"), "utf8")).previousRoots ?? []; }
    catch { return []; }
  }

  reference(file: string): PathRef {
    for (const [base, root] of [["data", this.dir], ["project", this.project]] as const) {
      const relative = path.relative(root, file);
      if (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) return { base, path: relative || "." };
    }
    return { base: "external", path: file };
  }

  resolveStored(value: string | PathRef): string {
    if (typeof value === "string") {
      const here = path.relative(this.project, value);
      if (here !== ".." && !here.startsWith(".." + path.sep) && !path.isAbsolute(here)) return path.resolve(value);
      for (const root of this.previousRoots) {
        const relative = path.relative(root, value);
        if (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) return path.resolve(this.project, relative);
      }
      return path.resolve(this.project, value);
    }
    if (!value || typeof value.path !== "string" || !["project", "data", "external"].includes(value.base)) throw new Error("Invalid stored path");
    if (value.base === "external") {
      if (!path.isAbsolute(value.path)) throw new Error("External paths must be absolute");
      return value.path;
    }
    if (path.isAbsolute(value.path) || value.path.split(/[\\/]/).includes("..")) throw new Error("Stored path escapes its root");
    return path.resolve(value.base === "data" ? this.dir : this.project, value.path);
  }

  get config(): string {
    return path.join(this.dir, "config.json");
  }
  get shared(): string {
    return path.join(this.dir, "shared");
  }
  /** The asset library: `assets/<type>/<name>/v<n><ext>`. */
  get assets(): string {
    return path.join(this.dir, "assets");
  }
  get run(): string {
    return path.join(this.dir, "run");
  }
  /** Who the running hub is. Its word counts only while `hubLock` is held. */
  get hubInfo(): string {
    return path.join(this.run, "hub.json");
  }
  /** Held by the project's hub for as long as its process lives (lock.ts). */
  get hubLock(): string {
    return path.join(this.run, "hub.lock");
  }
  /** Left by whoever stopped the hub to say: do not pick up what was unfinished (see `stopHub`). */
  get abandonMark(): string {
    return path.join(this.run, "abandon");
  }
  get hubLog(): string {
    return path.join(this.run, "hub.log");
  }
  /** Where the side panel's browser saves downloads. */
  get downloads(): string {
    return path.join(this.dir, "downloads");
  }

  /** Unix socket paths are limited to ~104 bytes; a deep project falls back to the temp dir. */
  socket(name: "acp" | "mcp"): string {
    const local = path.join(this.run, `${name}.sock`);
    if (Buffer.byteLength(local) < 100) return local;
    const tag = createHash("sha1").update(this.project).digest("hex").slice(0, 12);
    return path.join(os.tmpdir(), `xsb-${tag}-${name}.sock`);
  }

  agentDir(id: string): string {
    return path.join(this.dir, "agents", id);
  }
  instructions(id: string): string {
    return path.join(this.agentDir(id), "instructions.md");
  }
  /** Where an agent keeps its drafts and intermediate files; it works in the project directory, with the others. */
  scratch(id: string): string {
    return path.join(this.agentDir(id), "scratch");
  }

  // Store-relative names (the store is rooted at `.xsb2/`).
  static memory = (agentId: string): string => `agents/${agentId}/memory.jsonl`;
  static transcript = (agentId: string, sessionId: string): string => `agents/${agentId}/sessions/${sessionId}.jsonl`;
}
