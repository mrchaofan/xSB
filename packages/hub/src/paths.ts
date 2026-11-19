/**
 * Where things live. The project directory is the one holding `.xsb/`:
 *
 *   .xsb/
 *     config.json                      project settings (machine settings: ~/.xsb/config.json)
 *     agents.jsonl                     the agents (event log)
 *     sessions.jsonl                   sessions and the backend session each maps to
 *     tasks.jsonl  gates.jsonl         dispatched work and joins waiting on it
 *     mailbox.jsonl                    messages between agents: enqueue / ack
 *     wal.jsonl                        write-ahead log for multi-file changes
 *     agents/<id>/instructions.md      what this agent is (free text, user-edited)
 *     agents/<id>/memory.jsonl         the agent's own notes, by topic
 *     agents/<id>/sessions/<sid>.jsonl transcript of one session
 *     agents/<id>/scratch/             the agent's own drafts and intermediate files
 *     shared/                          files agents hand to each other
 *     assets.jsonl  assets/            the asset library: its index and its files
 *     roles/<role>/                    role.json, instructions.md, skills/<name>/SKILL.md (user-edited); the roles of
 *                                      the preset teams the project uses are not here (presets.ts)
 *     run/                             lock, pid, sockets, log of the running hub
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = ".xsb";

/**
 * What xsb ships besides its code, by name ("presets", "bin"). One rule, whatever form xsb runs in: it is the
 * directory of that name next to the directory the code is in. In the sources the code is packages/hub/src and
 * they are packages/hub/presets and packages/hub/bin; in the app (packages/desktop/rolldown.config.js) the code is
 * one file in dist/bin or dist/app, and they are dist/presets and dist/bin. They are plain files in both (the app
 * is packed without asar), so nothing asks which form it runs in.
 */
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

  constructor(project: string) {
    this.project = path.resolve(project);
    this.dir = path.join(this.project, DIR);
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
  /** Project-local template snapshots, never implicitly refreshed after creation. */
  get templates(): string {
    return path.join(this.dir, "templates");
  }
  /** The project's own roles. */
  get roles(): string {
    return path.join(this.dir, "roles");
  }
  roleDir(role: string): string {
    return path.join(this.roles, role);
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

  // Store-relative names (the store is rooted at `.xsb/`).
  static memory = (agentId: string): string => `agents/${agentId}/memory.jsonl`;
  static transcript = (agentId: string, sessionId: string): string => `agents/${agentId}/sessions/${sessionId}.jsonl`;
}
