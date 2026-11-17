/**
 * What crosses between main and the renderer: the shapes `window.xsb` returns
 * and the events it delivers. The renderer is plain JavaScript, so this file
 * is the one written definition of that contract; ../renderer/mock.js is a
 * second implementation of it, with sample data.
 *
 * They are the hub's shapes (@xsb/protocol) where those fit a screen, and a
 * view of them where they do not: a transcript is entries, not session
 * updates; a role's servers and variables are lists, not maps.
 *
 * Words are the renderer's: it reads `window.xsb.language` and has a table
 * for each (../renderer/text.js). Main hands it facts, and errors already
 * worded in that language, since only main can tell what an error is about.
 */
import type { AgentInfo, Boundary, OriginMeta, Spend, Task, Workplace } from "@xsb/protocol";
import type { Content } from "./content.ts";

/**
 * One line of an agent's transcript. `id` is its identity: the same id again replaces it.
 * What was said, by the user, a peer or the agent, is content (content.ts).
 */
export type Entry = { id: string } & (
  | { kind: "input"; origin: OriginMeta; content: Content; queued?: boolean }
  | { kind: "output"; content: Content; streaming?: boolean }
  | { kind: "tool"; title: string; status: "running" | "done" | "failed"; artifactId?: string }
  | { kind: "permission"; detail: string; outcome?: "allowed" | "rejected" | "cancelled" }
  | { kind: "error"; text: string }
  /** From here on the transcript shows another session of the agent: a work session of `topic`, or without one the main session. */
  | { kind: "thread"; topic?: string }
  /** Where what the model sees starts anew: before it, the model sees nothing (`cleared`) or only a handoff. */
  | { kind: "boundary"; boundary: Boundary }
);

/**
 * What an agent is doing right now, while it has a turn running: waiting for its model to answer, thinking,
 * writing its reply, or running tools (`detail`: the one that started last). `since` is when that began.
 * An agent with no turn running has none; one that waits for the user's approval says so in its state.
 */
export type Activity = { kind: "waiting" | "thinking" | "writing" | "tool"; detail?: string; since: string };

/** A file an agent wrote, as something the renderer can show. `assetType` is set for assets of the library. */
export type Artifact = { id: string; name: string; kind: "markdown" | "html" | "image" | "video" | "text"; agentId: string; path: string; url: string; updatedAt: string; assetType?: string };

/**
 * A web page of the side panel (pages.ts). `contentsId` is what `<webview2 web-contents-id>` shows it by.
 * `window`: it is shown in a window of its own, `pinned` on top of the others. `agent`: an agent opened it and drives it.
 */
export type PageView = { id: string; contentsId: number; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; window: boolean; pinned: boolean; agent: boolean; error?: string };

/**
 * `missing` is set when the backend is one of the known agents and its
 * program cannot be found: the program's name, for the user to say where it is (`locateProgram`, clis.ts).
 */
/** How far something done to several agents got: their ids, and why it stopped if it did. */
export type Progress = { done: string[]; failed?: string; error?: string };

export type BackendView = { name: string; command: string; installed: boolean; missing?: string };

/** A role as it is edited: servers and variables as lists, a skill's front matter as fields. */
export type RoleView = {
  avatar?: string;
  name: string;
  /** The preset team the workspace uses that has this role, what it calls it, and whether the workspace has its own version in its place. */
  preset: { team: string; teamTitle: string; own: boolean; title: string } | null;
  description: string;
  backend: string;
  /** Where a new agent of the role works: the project directory, or one of its own. */
  workspace: Workplace;
  instructions: string;
  mcpServers: { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[];
  /** `inputs`: the asset types a skill that produces one makes it from, as the user types them (comma-separated). */
  skills: { name: string; description: string; produces: string | null; inputs: string; body: string }[];
};

/**
 * A preset team, and whether the workspace uses it. Its roles are shown as they ship. `name` is what an agent of
 * the role would be called; `missing` are the programs the role works with that cannot be found on this machine,
 * each with how to get it. `assets`: what its asset types are called.
 */
export type Pack = {
  id: string;
  title: string;
  description: string;
  assets: Record<string, string>;
  used: boolean;
  roles: { name: string; role: RoleView; missing: { command: string; install: string }[] }[];
};

/** What an agent is told, for its editor: its own instructions, and everything a new session of it gets. */
export type AgentDetail = { instructions: string; systemPrompt: string };

/** An agent to create or change. An empty `workspace` is the default one. */
export type AgentInput = Pick<AgentInfo, "id" | "name" | "description" | "backend"> & { avatar?: string; role: string; workspace: string; instructions: string };

/** Everything a window shows at first. A window without a workspace gets `{ workspace: null, recent }` instead. */
export type Snapshot = {
  workspace: { name: string; path: string };
  backends: BackendView[];
  roles: RoleView[];
  agents: AgentInfo[];
  tasks: Task[];
  artifacts: Artifact[];
  /** What the asset types of the preset teams are called: type -> name. A type no team names is shown as it is. */
  assetNames: Record<string, string>;
  transcripts: Record<string, Entry[]>;
  /** Agent id -> what it is doing, for those with a turn running. */
  activities: Record<string, Activity>;
  /** What generation has cost so far, and the user's budget for it. */
  spend: Spend;
  /** The page tabs. `null` on an Electron that cannot show web pages (no `<webview2>`). */
  pages: PageView[] | null;
};

/** What changed since. Things are replaced by key: an agent, task, artifact and entry by `id`, a role by `name`. */
export type Event =
  | { agent: AgentInfo }
  | { removedAgent: string }
  | { role: RoleView }
  | { removedRole: string }
  | { spend: Spend }
  | { task: Task }
  | { artifact: Artifact }
  | { page: PageView }
  | { removedPage: string }
  /** The connection to the workspace's hub is gone. Opening the workspace again makes a new one. */
  | { hub: "down" }
  /** Make this page's tab the current one of the side panel. */
  | { revealPage: string }
  /** Show this agent's conversation: the user clicked a notification of it. */
  | { showAgent: string }
  /** What the agent is doing now; `null` when its turn is over. */
  | { agentId: string; activity: Activity | null }
  | { agentId: string; entry: Entry }
  | { agentId: string; removedEntry: string };
