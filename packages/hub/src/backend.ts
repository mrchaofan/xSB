import { AIR_COMPATIBILITY } from "./air-compat.ts";
import { skillPrompt } from "./prompt-capabilities.ts";
/**
 * One backend agent process, driven as a plain ACP v2 client over stdio.
 *
 * This is the end of the chain, and the only place where backends differ.
 * There is no per-vendor code: an official ACP agent and a wrapped third-party
 * one (@xsb/adapter) differ only in the command that starts them and in the
 * capabilities they report. All input uses standard `session/prompt`. The pinned official
 * adapters prioritize ordinary input into active work; input callbacks and control commands
 * may defer it. A response acknowledges insertion, independently of execution completion.
 */
import spawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { Connection, OriginExt, PROTOCOL_VERSION, RpcError, TurnIsolation, failure, text } from "@xsb/protocol";
import type { AuthMethod, ElicitationRequest, ElicitationResponse, UrlElicitationRequest, ContentBlock, InitializeResponse, OriginMeta, PermissionRequest, PromptResponse } from "@xsb/protocol";
import { INSTALL_HINT, findCommand } from "./config.ts";
import type { BackendSpec } from "./config.ts";
import type { LiveSession } from "./session.ts";
import { VERSION, deferred } from "./util.ts";

export type BackendCaps = {
  systemPrompt: boolean;
  skill?: boolean;
  inlineSkill?: boolean;
  additionalDirectories: boolean;
  /** Reads `image` content blocks. Text and `resource_link` are what every ACP agent reads. */
  image: boolean;
  /** Explicitly guarantees cancellation drains/fences old tool traffic before idle. Absent: rebind after stop. */
  orderedCancellation?: boolean;
};

export type BackendEvents = {
  onExit(reason: string): void;
  log(line: string): void;
  url?(backend: Backend, request: UrlElicitationRequest, signal: AbortSignal): Promise<ElicitationResponse>;
  urlComplete?(backend: Backend, elicitationId: string): void;
};

/** How long a stopped backend may take to exit before it is killed. */
const STOP_GRACE_MS = 3000;

export class Backend {
  readonly conn: Connection;
  readonly agentId: string;
  caps: BackendCaps = { systemPrompt: false, additionalDirectories: false, image: false };
  info = "";
  /** Names of the ways this agent can be signed in, as it reported them. */
  authMethods: AuthMethod[] = [];
  private proc: ChildProcess;
  /** Settles once the process is gone (or never started): only then is what it held, such as session locks, free. */
  private ended: Promise<void>;
  /** Backend session id -> the hub session that has it open. */
  private sessions = new Map<string, LiveSession>();

  private constructor(proc: ChildProcess, conn: Connection, agentId: string) {
    this.agentId = agentId;
    this.proc = proc;
    this.conn = conn;
    this.ended = new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      proc.once("exit", () => resolve());
      proc.once("error", () => resolve());
    });
  }

  /** Route what the process says about one of its sessions to `session`. */
  open(backendSessionId: string, session: LiveSession): void {
    this.sessions.set(backendSessionId, session);
  }

  session(id: string): LiveSession | undefined { return this.sessions.get(id); }

  /** Retire a stopped conversation before a new one can receive its late updates. */
  close(backendSessionId: string): void {
    this.sessions.delete(backendSessionId);
  }

  /** What this backend can read of some input: an image it cannot see is named instead, so the model knows one was there. */
  private readable(prompt: ContentBlock[]): ContentBlock[] {
    prompt = skillPrompt(prompt, this.caps);
    if (this.caps.image) return prompt;
    return prompt.map((block) => (block.type === "image" ? text(`[An image (${block.mimeType}) was attached here; you cannot see images.]`) : block));
  }

  /**
   * Give the session a user message. Resolves with the id the backend gave it once it is inserted into the
   * conversation: at once when the agent is idle or steers, later when it holds it. Rejects with -32800
   * (`RpcError.CANCELLED`) when the work was cancelled before it was inserted.
   */
  async prompt(sessionId: string, prompt: ContentBlock[], origin: OriginMeta): Promise<string> {
    const answer = await this.conn.request<PromptResponse>("session/prompt", { sessionId, prompt: this.readable(prompt), ...(origin.messageId ? { idempotencyKey: origin.messageId } : {}), _meta: { [OriginExt.key]: origin } });
    return answer.messageId;
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
    const backend = new Backend(proc, conn, name);
    const codex = backendName === "codex" || /(^|[/\\])codex-acp(?:\.cmd|\.exe)?$/.test(spec.command);
    // Codex's async native forms may auto-resolve; use xSB's blocking ask instead.
    const nativeForms = !codex;

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
    conn.onNotification("elicitation/complete", (p) => events.urlComplete?.(backend, p.elicitationId));
    conn.onRequest("elicitation/create", (p: ElicitationRequest, ctx) => {
      if (p.mode === "url") return events.url?.(backend, p, ctx.signal) ?? { action: "decline" };
      if (!nativeForms) return { action: "cancel" };
      const session = backend.sessions.get(p.sessionId);
      if (!session) return { action: "cancel" };
      return session.onBackendElicitation(p, ctx.signal);
    });

    // The hub offers no editor surface: agents use their own file and shell tools.
    const init = await conn
      .request<InitializeResponse>("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        info: { name: "xsb", title: "xsb hub", version: VERSION },
        // v2 compaction reports are standard session updates and need no client capability.
        capabilities: { auth: { terminal: {} }, elicitation: { url: {}, ...(nativeForms ? { form: {} } : {}) }, session: { promptSuggestions: {}, commands: { skill: {} } }, ...((spec.airCompatibility ?? codex) ? { _meta: AIR_COMPATIBILITY } : {}) },
      })
      .catch(async (e) => {
        // A process that died during startup is the real story, not the closed pipe.
        if (conn.isClosed) await gone.promise;
        if (!exited) throw e;
        throw failure("backend_start_failed", { ...about, exit: exitReason, stderr: stderrTail });
      });
    if (init.protocolVersion !== PROTOCOL_VERSION) {
      void backend.stop();
      throw failure("backend_incompatible", { ...about, backendVersion: init.protocolVersion, hubVersion: PROTOCOL_VERSION });
    }
    const session = init.capabilities?.session ?? {};
    backend.caps = {
      systemPrompt: session.systemPrompt != null,
      additionalDirectories: session.additionalDirectories != null,
      image: session.prompt?.image != null,
      skill: session.prompt?.skill != null,
      inlineSkill: session.prompt?.skill?.inline != null,
      orderedCancellation: (init._meta?.[TurnIsolation.key] as { version?: number; afterIdle?: boolean } | undefined)?.version === TurnIsolation.version &&
        (init._meta?.[TurnIsolation.key] as { afterIdle?: boolean } | undefined)?.afterIdle === true,
    };
    backend.authMethods = init.authMethods ?? [];
    backend.info = init.info ? `${init.info.name} ${init.info.version}` : name;
    return backend;
  }

  /** End the process: asked first, forced after a grace period. Resolves when it has exited. */
  stop(): Promise<void> {
    this.conn.close();
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      this.proc.kill();
      const force = setTimeout(() => this.proc.kill("SIGKILL"), STOP_GRACE_MS);
      force.unref();
      void this.ended.then(() => clearTimeout(force));
    }
    return this.ended;
  }
}
