import type { ComposerState, WorkflowView } from "@xsb/protocol";
/**
 * What crosses between main and the renderer: the shapes `window.xsb` returns
 * and the events it delivers. The renderer is plain JavaScript, so this file
 * is the one written definition of that contract; ../renderer/mock.js is a
 * second implementation of it, with sample data.
 *
 * They are the hub's shapes (@xsb/protocol) where those fit a screen, and a
 * view of them where they do not: a transcript is a list of entries.
 *
 * Words are the renderer's: it reads `window.xsb.language` and has a table
 * for each (../renderer/text.js). Main hands it facts, and errors already
 * worded in that language, since only main can tell what an error is about.
 */
import type { AgentInfo, BackendRun, Boundary, DeliveredAs, DiscardReason, OriginMeta, QuestionAnswer, QuestionItem, QuestionState, Task } from "@xsb/protocol";
import type { Content } from "./content.ts";
import type { WebAnnotation } from "./page-annotations.ts";

/**
 * One line of an agent's transcript. `id` is its identity: the same id again replaces it.
 * What was said, by the user, a peer or the agent, is content (content.ts).
 */
export type Entry = { id: string } & (
  /** `discarded`: this delivery ended without confirmation. `pending`: waiting for insertion evidence. */
  | { kind: "input"; origin: OriginMeta; content: Content; discarded?: boolean; pending?: boolean;
      delivery?: "waiting" | "queued" | "sending"; canCancel?: boolean; canSendNow?: boolean; isQueueHead?: boolean; targetTurnId?: string; sendNowBlockedBy?: "sending" | "stopping" | "waiting";
      /** Why delivery ended; `detail` is the error. `unsent`: xsb never had it (sent again under its id). */
      reason?: DiscardReason; detail?: string; unsent?: boolean;
      /** Owed: given to the model with the user's next message. `redelivered`: it was. `resentAs`: the user sent it again. */
      owed?: boolean; redelivered?: boolean; resentAs?: string;
      /** How the model was given it, where that differs (images it cannot see, text saved to a file, a note in front). */
      deliveredAs?: DeliveredAs;
      /** It answers or skips a question: the question's card shows it. */
      reply?: boolean }
  | { kind: "output"; content: Content; streaming?: boolean; run?: BackendRun; stopReason?: string; runOrigin?: unknown }
  | { kind: "tool"; title: string; status: "running" | "done" | "failed"; artifactId?: string; name?: string; input?: unknown; output?: unknown; terminalOutput?: string }
  | { kind: "permission"; detail: string; outcome?: "allowed" | "rejected" | "cancelled" }
  /** What the agent asked the user (the `ask` tool) and what became of it. Its reply's own message is not shown apart. */
  | { kind: "question"; questionId: string; questions: QuestionItem[]; state: QuestionState; answers?: QuestionAnswer[]; source?: "acp"; delivery?: "async" }
  | { kind: "error"; text: string }
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
export type Artifact = { sessionIds?: string[]; fileUri?: string; id: string; name: string; kind: "markdown" | "html" | "image" | "video" | "text"; agentId: string; path: string; url: string; updatedAt: string; assetType?: string; assetId?: string; assetVersion?: number; registeredName?: string; description?: string };

/**
 * A web page of the side panel (pages.ts), shown by `<webview2 web-contents-id>` using `contentsId`.
 * `window`: it is shown in a window of its own, `pinned` on top of the others. `agent`: an agent opened it and drives it.
 * `favicon`: the site's icon (http(s) or data: image), once the page named one.
 * `annotating`: the user is annotating it; `annotations`: the notes embedded in its current document.
 */
export type PageView = { sessionId?: string; id: string; contentsId: number; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; window: boolean; pinned: boolean; agent: boolean; background?: boolean; controlling?: boolean; annotating?: boolean; annotations?: number; tone?: "claude" | "default"; error?: string; favicon?: string };

/**
 * `missing` is set when the backend is one of the known agents and its
 * program cannot be found: the program's name, for the user to say where it is (`locateProgram`, clis.ts).
 */
/** How far something done to several agents got: their ids, and why it stopped if it did. */
export type Progress = { done: string[]; failed?: string; error?: string };

export type BackendView = { name: string; command: string; installed: boolean; missing?: string; cli?: "codex" | "claude"; configPath?: string;
  /** What the user runs in a terminal to sign the agent's program in: by its path when the terminal would not find it. */
  loginCommand?: string;
  /** The Volcengine Ark plan xSB's agent uses instead of its own configuration (ark.ts). */
  ark?: { profile: string; model: string } };

export type { CliCheck, CliConfig } from "./agent-cli.ts";
export type { ArkModel, ArkPlan, ArkStatus } from "./ark.ts";

/** Everything a window shows at first. A window without a workspace gets `{ workspace: null, recent }` instead. */
export type Snapshot = {
  workflows: Record<string,WorkflowView>;
  workspace: { name: string; path: string; id?: string; previousPaths?: string[] };
  backends: BackendView[];
  agents: AgentInfo[];
  tasks: Task[];
  artifacts: Artifact[];
  /** What the asset types of the preset teams are called: type -> name. A type no team names is shown as it is. */
  assetNames: Record<string, string>;
  transcripts: Record<string, Entry[]>;
  history: Record<string, number | null>;
  /** Agent id -> what it is doing, for those with a turn running. */
  activities: Record<string, Activity>;
  /** The page tabs. `null` on an Electron that cannot show web pages (no `<webview2>`). */
  pages: PageView[] | null;
};

/** What changed since. Things are replaced by key: an agent, task, artifact and entry by `id`, a role by `name`. */
export type Event =
  | { agentId: string; controls: ComposerState }
  | { workflow: WorkflowView }
  | { agent: AgentInfo }
  | { removedAgent: string }
  | { task: Task }
  | { artifact: Artifact }
  | { artifactsRemoved: string[] }
  | { page: PageView }
  | { removedPage: string }
  /** The connection to the workspace's hub is gone. Opening the workspace again makes a new one. */
  | { hub: "down" }
  /**
   * The element the user selected to annotate on a page this window shows: where it is in the page's
   * viewport (`rect` null: out of sight, or nothing selected when `seq` is 0). A new `seq` is a new selection.
   */
  | { annotationTarget: { pageId: string; seq: number; rect: { x: number; y: number; width: number; height: number } | null; label: string } }
  /** A confirmed note on a page of `sessionId`, for that conversation's composer (page-annotations.ts `WebAnnotation`). */
  | { webAnnotation: { pageId: string; sessionId?: string; annotation: WebAnnotation } }
  /** The user cleared these notes on the page: the composer drops them too. */
  | { webAnnotationsRemoved: { pageId: string; sessionId?: string; ids: string[] } }
  /** Show this agent's conversation: the user clicked a notification of it. */
  | { showAgent: string }
  /** The application menu asked for the settings. */
  | { openSettings: true }
  /** Where arkcli asks the user to sign in, for when it opened no browser (ark.ts `login`). */
  | { arkLoginUrl: string }
  /** The window now shows another workspace (File > Open Folder): draw it anew. */
  | { workspaceChanged: true }
  /** What the agent is doing now; `null` when its turn is over. */
  | { agentId: string; activity: Activity | null }
  | { agentId: string; entry: Entry }
  | { agentId: string; removedEntry: string };
