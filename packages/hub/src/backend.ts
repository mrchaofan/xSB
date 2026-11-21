/**
 * One backend agent process, driven as a plain ACP v2 client over stdio.
 *
 * This is the end of the chain, and the only place where backends differ.
 * There is no per-vendor code: an official ACP agent and a wrapped third-party
 * one (@xsb/adapter) differ only in the command that starts them and in the
 * capabilities they report. ACP v2 takes a prompt while the agent works and
 * inserts it when it can (claude: into the work under way, at its next tool
 * call; codex: after it), answering with the id of the inserted message. To put
 * input into the work under way, a backend that reports `steering` (codex) is
 * given it with `_session/steering` instead (docs/DESIGN.md 3.1).
 */
import spawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { Connection, OriginExt, PROTOCOL_VERSION, RpcError, TurnIsolation, failure, text } from "@xsb/protocol";
import type { ContentBlock, InitializeResponse, OriginMeta, PermissionRequest, PromptResponse } from "@xsb/protocol";
import { INSTALL_HINT, findCommand } from "./config.ts";
import type { BackendSpec } from "./config.ts";
import type { LiveSession } from "./session.ts";
import { VERSION, deferred } from "./util.ts";

export type BackendCaps = {
  systemPrompt: boolean;
  additionalDirectories: boolean;
  /** Reads `image` content blocks. Text and `resource_link` are what every ACP agent reads. */
  image: boolean;
  /**
   * Takes `_session/steering`, which puts input into the work under way (codex-acp). Without it, a prompt sent while
   * the agent works is what goes into that work (claude-agent-acp).
   */
  steering: boolean;
  /** Explicitly guarantees cancellation drains/fences old tool traffic before idle. Absent: rebind after stop. */
  orderedCancellation?: boolean;
};

/**
 * What `_session/steering` did with input: handed it to the work under way (`injected`; it is in the conversation
 * once the backend shows it, and dropped if the work ends first), or nothing, as no work runs (`idle`).
 */
export type Steered = "injected" | "idle";

export type BackendEvents = {
  onExit(reason: string): void;
  log(line: string): void;
};

export class Backend {
  readonly conn: Connection;
  caps: BackendCaps = { systemPrompt: false, additionalDirectories: false, image: false, steering: false };
  info = "";
  /** Names of the ways this agent can be signed in, as it reported them. */
  authMethods: string[] = [];
  private proc: ChildProcess;
  /** Backend session id -> the hub session that has it open. */
  private sessions = new Map<string, LiveSession>();

  private constructor(proc: ChildProcess, conn: Connection) {
    this.proc = proc;
    this.conn = conn;
  }

  /** Route what the process says about one of its sessions to `session`. */
  open(backendSessionId: string, session: LiveSession): void {
    this.sessions.set(backendSessionId, session);
  }

  /** Retire a stopped conversation before a new one can receive its late updates. */
  close(backendSessionId: string): void {
    this.sessions.delete(backendSessionId);
  }

  /** What this backend can read of some input: an image it cannot see is named instead, so the model knows one was there. */
  private readable(prompt: ContentBlock[]): ContentBlock[] {
    if (this.caps.image) return prompt;
    return prompt.map((block) => (block.type === "image" ? text(`[An image (${block.mimeType}) was attached here; you cannot see images.]`) : block));
  }

  /**
   * Give the session a user message. Resolves with the id the backend gave it once it is inserted into the
   * conversation: at once when the agent is idle or steers, later when it holds it. Rejects with -32800
   * (`RpcError.CANCELLED`) when the work was cancelled before it was inserted.
   */
  async prompt(sessionId: string, prompt: ContentBlock[], origin: OriginMeta): Promise<string> {
    const answer = await this.conn.request<PromptResponse>("session/prompt", { sessionId, prompt: this.readable(prompt), _meta: { [OriginExt.key]: origin } });
    return answer.messageId;
  }

  /**
   * Put input into the session's work under way; only for a backend with `steering`. With no work running, nothing
   * is done (`idleBehavior: "promptRequired"`): the hub gives it as a prompt then. Rejects when it could not be done.
   */
  async steer(sessionId: string, prompt: ContentBlock[]): Promise<Steered> {
    const answer = await this.conn.request<{ outcome: string }>("_session/steering", {
      sessionId,
      prompt: this.readable(prompt),
      _meta: { steering: { idleBehavior: "promptRequired" } },
    });
    if (answer.outcome === "injected") return "injected";
    if (answer.outcome === "promptRequired") return "idle";
    throw new RpcError(-32603, `the agent could not take the input into its work (${answer.outcome})`);
  }

  /** Stop the session's work, as Esc does in Claude Code and Codex; prompts not inserted yet are answered with -32800. */
  cancel(sessionId: string): void {
    this.conn.notify("session/cancel", { sessionId });
  }

  /** Start the backend `backendName` for the agent `name` and shake hands. */
  static async start(
    name: string,
    backendName: string,
    spec: BackendSpec,
    cwd: string,
    events: BackendEvents,
  ): Promise<Backend> {
    const about = { agent: name, backend: backendName, command: spec.command };
    if (!findCommand(spec.command)) {
      throw failure("backend_not_installed", { ...about, hint: INSTALL_HINT[spec.command] });
    }
    // The process inherits the hub's environment as it is: credentials and
    // permission modes are the backend's own settings, not xsb's.
    const proc = spawn(spec.command, spec.args ?? [], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stderrTail: string[] = [];
    const conn = new Connection(proc.stdout!, proc.stdin!, `backend:${name}`);
    const backend = new Backend(proc, conn);

    let exited = false;
    let exitReason = "";
    const gone = deferred<void>();
    const exit = (reason: string): void => {
      if (exited) return;
      exited = true;
      exitReason = reason;
      conn.close();
      for (const session of backend.sessions.values()) session.onBackendGone(backend, reason);
      backend.sessions.clear();
      events.onExit(reason);
      gone.resolve();
    };
    proc.on("error", (e) => exit(`cannot start "${spec.command}": ${e.message}`));
    proc.on("exit", (code, signal) => exit(`exited (${signal ?? code})`));
    // The pipe usually closes a moment before the exit status is known; wait for the status.
    void conn.closed.then(() => setTimeout(() => exit("closed its output"), 1000));
    proc.stdin!.on("error", () => {});
    proc.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        events.log(line);
        stderrTail = [...stderrTail, line].slice(-5);
      }
    });

    conn.onNotification("session/update", (p) => {
      const session = backend.sessions.get(p.sessionId);
      // Every session of a backend is one the hub opened (LiveSession.bind): anything else is not taken into account.
      if (!session) return events.log(`update of session ${p.sessionId}, which the hub did not open: ignored`);
      session.onBackendUpdate(p.update, p.sessionId);
    });
    conn.onRequest("session/request_permission", (p: PermissionRequest) => {
      const session = backend.sessions.get(p.sessionId);
      if (!session) throw RpcError.notFound(`session ${p.sessionId}`);
      return session.onBackendPermission(p);
    });

    // The hub offers no editor surface: agents use their own file and shell tools.
    const init = await conn
      .request<InitializeResponse>("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        info: { name: "xsb", title: "xsb hub", version: VERSION },
        capabilities: {},
      })
      .catch(async (e) => {
        // A process that died during startup is the real story, not the closed pipe.
        if (conn.isClosed) await gone.promise;
        if (!exited) throw e;
        throw failure("backend_start_failed", { ...about, exit: exitReason, stderr: stderrTail });
      });
    if (init.protocolVersion !== PROTOCOL_VERSION) {
      backend.stop();
      throw failure("backend_incompatible", { ...about, backendVersion: init.protocolVersion, hubVersion: PROTOCOL_VERSION });
    }
    const session = init.capabilities?.session ?? {};
    backend.caps = {
      systemPrompt: session.systemPrompt != null,
      additionalDirectories: session.additionalDirectories != null,
      image: session.prompt?.image != null,
      steering: (init._meta as { steering?: { supported?: boolean } } | null | undefined)?.steering?.supported === true,
      orderedCancellation: (init._meta?.[TurnIsolation.key] as { version?: number; afterIdle?: boolean } | undefined)?.version === TurnIsolation.version &&
        (init._meta?.[TurnIsolation.key] as { afterIdle?: boolean } | undefined)?.afterIdle === true,
    };
    backend.authMethods = (init.authMethods ?? []).map((m: any) => m?.name ?? m?.methodId ?? m?.id).filter(Boolean);
    backend.info = init.info ? `${init.info.name} ${init.info.version}` : name;
    return backend;
  }

  stop(): void {
    this.conn.close();
    this.proc.kill();
  }
}
