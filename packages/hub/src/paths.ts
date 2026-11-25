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
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
