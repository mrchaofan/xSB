/** The CLI's ACP v2 connection to the hub. The CLI is an ACP client like any other. */
import { hubSocket } from "@xsb/hub";
import type { Paths } from "@xsb/hub";
import { Agents, Workflow, Connection, LanguageExt, PROTOCOL_VERSION, RpcError } from "@xsb/protocol";
import type { ContentBlock, SessionUpdate, StopReason } from "@xsb/protocol";
import pkg from "../package.json" with { type: "json" };
import { language } from "./text.ts";

/**
 * A connection to the hub that knows when work ends. In ACP v2 a prompt is answered once it is inserted; the work it
 * went into ends with the session's `idle`. `turn` waits for that; `onUpdate` sees every update first.
 */
export type HubConnection = Connection & {
  onUpdate(listener: (sessionId: string, update: SessionUpdate) => void): void;
  turn(sessionId: string, prompt: ContentBlock[], target?: string): Promise<StopReason>;
};

export async function connectHub(paths: Paths, observer: boolean): Promise<HubConnection> {
  const socket = await hubSocket(paths);
  const conn = new Connection(socket, socket, "hub") as HubConnection;
  const listeners: ((sessionId: string, update: SessionUpdate) => void)[] = [];
  const idle = new Map<string, ((end: { stopReason: StopReason; error?: any }) => void)[]>();
  conn.onNotification("session/update", ({ sessionId, update }) => {
    for (const listen of listeners) listen(sessionId, update);
    if (update.sessionUpdate === "state_update" && update.state === "idle") {
      for (const done of idle.get(sessionId)?.splice(0) ?? []) done({ stopReason: update.stopReason ?? "end_turn", error: update.error });
    }
  });
  conn.onUpdate = (listener) => void listeners.push(listener);
  conn.turn = async (sessionId, prompt, target) => {
    // Waited for from before it is sent: the answer and the end may arrive together. The user's word goes into the
    // work under way, so the first idle after it is sent is the end of the work it went into.
    const ended = new Promise<{ stopReason: StopReason; error?: any }>((resolve) => idle.set(sessionId, [...(idle.get(sessionId) ?? []), resolve]));
    await conn.request("session/prompt", { sessionId, prompt, _meta:{[Workflow.target]:target} });
    const end = await ended;
    if (end.error) throw new RpcError(end.error.code, end.error.message, end.error.data);
    return end.stopReason;
  };
  await conn.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    info: { name: "xsb-cli", version: pkg.version },
    capabilities: { _meta: { [LanguageExt.key]: language, ...(observer ? { [Agents.capability]: {} } : {}) } },
  });
  return conn;
}
