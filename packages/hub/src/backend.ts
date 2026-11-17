/**
 * One backend agent process, driven as a plain ACP client over stdio.
 *
 * This is the end of the chain, and the only place where backends differ.
 * There is no per-vendor code: an official ACP agent and a wrapped third-party
 * one (@xsb/adapter) differ only in the command that starts them and in the
 * capabilities they report. What a backend cannot do is made up for here, so
 * everything upstream drives every backend the same way: `prompt` runs a turn
 * to its end, `steer` puts a message into it, `cancel` stops it.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Connection, OriginExt, PROTOCOL_VERSION, RpcError, Steering, failure, text } from "@xsb/protocol";
import type { ContentBlock, InitializeResponse, OriginMeta, PermissionRequest, SteeringOutcome, StopReason } from "@xsb/protocol";
import { INSTALL_HINT, findCommand } from "./config.ts";
import type { BackendSpec } from "./config.ts";
import { STEER_CONTINUATION } from "./prompts.ts";
import type { LiveSession } from "./session.ts";
import { VERSION, deferred } from "./util.ts";

export type BackendCaps = {
  /** Serves `_session/steering` itself. */
  steering: boolean;
  loadSession: boolean;
  resume: boolean;
  systemPrompt: boolean;
  additionalDirectories: boolean;
  /** Reads `image` content blocks. Text and `resource_link` are what every ACP agent reads. */
  image: boolean;
};

/** A `session/prompt` in flight, as the hub sees it: one turn, however often the backend is re-prompted. */
type Run = {
  /** Messages to hand over once the interrupted prompt has returned. */
  steers: ContentBlock[][];
  cancelled: boolean;
};

export type BackendEvents = {
  onExit(reason: string): void;
  log(line: string): void;
};

export class Backend {
  readonly conn: Connection;
  caps: BackendCaps = { steering: false, loadSession: false, resume: false, systemPrompt: false, additionalDirectories: false, image: false };
  info = "";
  /** Names of the ways this agent can be signed in, as it reported them. */
  authMethods: string[] = [];
  private proc: ChildProcess;
  /** Backend session id -> the hub session that has it open. */
  private sessions = new Map<string, LiveSession>();
  /** Backend session id -> its running turn. */
  private runs = new Map<string, Run>();

  private constructor(proc: ChildProcess, conn: Connection) {
    this.proc = proc;
    this.conn = conn;
  }

  /** Route what the process says about one of its sessions to `session`. */
  open(backendSessionId: string, session: LiveSession): void {
    this.sessions.set(backendSessionId, session);
  }

  /** What this backend can read of some input: an image it cannot see is named instead, so the model knows one was there. */
  private readable(prompt: ContentBlock[]): ContentBlock[] {
    if (this.caps.image) return prompt;
    return prompt.map((block) => (block.type === "image" ? text(`[An image (${block.mimeType}) was attached here; you cannot see images.]`) : block));
  }

  /**
   * Run one turn to its end. Messages steered in on the way are part of it:
   * with a backend that cannot take them mid-prompt, the prompt is interrupted
   * and followed by a continuation, and the caller still sees one turn.
   */
  async prompt(sessionId: string, prompt: ContentBlock[], origin: OriginMeta): Promise<StopReason> {
    prompt = this.readable(prompt);
    const run: Run = { steers: [], cancelled: false };
    this.runs.set(sessionId, run);
    try {
      for (;;) {
        const { stopReason } = await this.conn
          .request<{ stopReason: StopReason }>("session/prompt", { sessionId, prompt, _meta: { [OriginExt.key]: origin } })
          .catch((e) => {
            // Some agents answer a cancelled prompt with an error instead of `cancelled`.
            if (!run.cancelled && run.steers.length === 0) throw e;
            return { stopReason: "cancelled" as const };
          });
        if (run.cancelled) return "cancelled";
        if (run.steers.length === 0) return stopReason;
        prompt = [text(STEER_CONTINUATION), ...run.steers.splice(0).flat()];
      }
    } finally {
      this.runs.delete(sessionId);
    }
  }

  /**
   * Put a message into the running turn. `idle`: there is none (any more).
   * `interrupted`: the backend has no steering of its own, so its prompt was
   * cancelled to make room; whatever it was waiting for is void.
   */
  async steer(sessionId: string, prompt: ContentBlock[], origin: OriginMeta): Promise<"injected" | "interrupted" | "idle"> {
    const run = this.runs.get(sessionId);
    if (!run || run.cancelled) return "idle";
    prompt = this.readable(prompt);
    if (this.caps.steering) {
      const answer = await this.conn
        .request<SteeringOutcome>(Steering.method, {
          sessionId,
          prompt,
          _meta: { [Steering.metaKey]: { idleBehavior: "promptRequired" }, [OriginExt.key]: origin },
        })
        .catch(() => undefined);
      if (answer?.outcome === "injected") return "injected";
      if (this.runs.get(sessionId) !== run || run.cancelled) return "idle";
    }
    run.steers.push(prompt);
    if (run.steers.length === 1) this.conn.notify("session/cancel", { sessionId });
    return "interrupted";
  }

  /** Stop the running turn; `prompt` then answers "cancelled". */
  cancel(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (!run) return;
    run.cancelled = true;
    run.steers.length = 0;
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
      for (const session of backend.sessions.values()) session.onBackendGone(backend);
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

    conn.onNotification("session/update", (p) => backend.sessions.get(p.sessionId)?.onBackendUpdate(p.update));
    conn.onRequest("session/request_permission", (p: PermissionRequest) => {
      const session = backend.sessions.get(p.sessionId);
      if (!session) throw RpcError.notFound(`session ${p.sessionId}`);
      return session.onBackendPermission(p);
    });

    // The hub offers no editor surface: agents use their own file and shell tools.
    const init = await conn
      .request<InitializeResponse>("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "xsb", title: "xsb hub", version: VERSION },
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
    const session = init.agentCapabilities?.sessionCapabilities ?? {};
    const steering = init._meta?.[Steering.metaKey] as { supported?: boolean } | undefined;
    backend.caps = {
      steering: steering?.supported === true,
      loadSession: init.agentCapabilities?.loadSession === true,
      resume: !!session.resume,
      systemPrompt: !!session.systemPrompt,
      additionalDirectories: !!session.additionalDirectories,
      image: init.agentCapabilities?.promptCapabilities?.image === true,
    };
    backend.authMethods = (init.authMethods ?? []).map((m: any) => m?.name ?? m?.id).filter(Boolean);
    backend.info = init.agentInfo ? `${init.agentInfo.name} ${init.agentInfo.version}` : name;
    return backend;
  }

  stop(): void {
    this.conn.close();
    this.proc.kill();
  }
}
