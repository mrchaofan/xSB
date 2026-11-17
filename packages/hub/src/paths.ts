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
 *     agents/<id>/workspace/           default working directory of the agent
 *     shared/                          files agents hand to each other
 *     assets.jsonl  assets/            the asset library: its index and its files
 *     spend.jsonl                      what generation cost, and the user's budget for it (spend.ts)
 *     roles/<role>/                    role.json, instructions.md, skills/<name>/SKILL.md (user-edited); the roles of
 *                                      the preset teams the project uses are not here (teams.ts)
 *     run/                             lock, pid, sockets, log of the running hub
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DIR = ".xsb";

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
  /** What generation costs, and the user's budget for it (`Spend` in @xsb/protocol). */
  get spend(): string {
    return path.join(this.dir, "spend.jsonl");
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
  defaultWorkspace(id: string): string {
    return path.join(this.agentDir(id), "workspace");
  }

  // Store-relative names (the store is rooted at `.xsb/`).
  static memory = (agentId: string): string => `agents/${agentId}/memory.jsonl`;
  static transcript = (agentId: string, sessionId: string): string => `agents/${agentId}/sessions/${sessionId}.jsonl`;
}
