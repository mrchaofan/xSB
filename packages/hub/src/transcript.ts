/**
 * What a session's transcript says, for a model that has to pick it up: the turns since the user last cleared the
 * context, read from the end of the transcript.
 *
 * A transcript (`agents/<id>/sessions/<sid>.jsonl`) is append-only and keeps everything that was said, also what the
 * model no longer sees. Where the model's view starts anew is a boundary record in it (`Boundaries` in
 * @xsb/protocol). So whatever decides what a model sees reads the transcript backward and stops at the first
 * boundary of the kind `cleared`: what lies before it is the user's to keep, not the model's to be given.
 */
import { Boundaries, OriginExt, RunExt } from "@xsb/protocol";
import type { BackendRun, Boundary, ContentBlock, OriginMeta } from "@xsb/protocol";
import type { Store } from "@xsb/store";
import { Paths } from "./paths.ts";

/** One turn as a handoff tells it: what came in, the tools that ran, and what the agent said last. */
export type PastTurn = {
  at: string;
  inputs: { origin: OriginMeta; text: string }[];
  tools: string[];
  reply: string;
  /** Backend output without a turn owner remains a separate piece of history. */
  run?: BackendRun;
};

/** The boundary a transcript record is, if it is one. */
export const boundaryOf = (update: any): Boundary | undefined =>
  update?.sessionUpdate === "session_info_update" ? (update._meta?.[Boundaries.key] as Boundary | undefined) : undefined;

const said = (content: ContentBlock | undefined): string =>
  !content ? "" : content.type === "text" ? (content.text ?? "") : `[${content.type}]`;

/**
 * The turns of a session since its context was last cleared, oldest first. A turn begins with input that is not
 * steered into a running one; the agent's reply is the text of its last message before the next turn.
 */
export function turnsSinceCleared(store: Store, agentId: string, sessionId: string, bounds?: { maxChars: number; stopAtRenewal: boolean }): PastTurn[] {
  const records: { ts: string; update: any }[] = [];
  let chars = 0;
  for (const rec of store.readBackward(Paths.transcript(agentId, sessionId))) {
    const boundary = boundaryOf(rec.update);
    if (boundary?.kind === "cleared" || (bounds?.stopAtRenewal && boundary?.handoff)) break;
    chars += JSON.stringify(rec).length;
    if (bounds && chars > bounds.maxChars) break;
    records.push(rec as { ts: string; update: any });
  }
  records.reverse();

  const turns: PastTurn[] = [];
  let input: { id: string; entry: PastTurn["inputs"][number] } | undefined;
  let message: { id: string; text: string } | undefined;
  // Backends may report a tool entirely through updates. Track it per turn so
  // lifecycle updates refine one entry, while ids reused in later turns stay separate.
  let tools = new Map<string, number>();
  const turn = (): PastTurn | undefined => turns.at(-1);
  for (const { ts, update } of records) {
    const run = update?._meta?.[RunExt.key] as BackendRun | undefined;
    if (run?.turnId === null && ["agent_message_chunk", "agent_message", "tool_call", "tool_call_update"].includes(update.sessionUpdate) && turn()?.run?.id !== run.id) {
      turns.push({ at: ts, inputs: [], tools: [], reply: "", run: { id: run.id, turnId: null } });
      tools = new Map();
      message = undefined;
    }
    switch (update?.sessionUpdate) {
      case "user_message_chunk": {
        const origin: OriginMeta = update._meta?.[OriginExt.key] ?? { kind: "user" };
        if (input && input.id === update.messageId) {
          input.entry.text += `\n${said(update.content)}`;
          break;
        }
        const entry = { origin, text: said(update.content) };
        input = { id: update.messageId, entry };
        if (origin.steered && turn() && !turn()!.run) turn()!.inputs.push(entry);
        else {
          turns.push({ at: ts, inputs: [entry], tools: [], reply: "" });
          tools = new Map();
        }
        message = undefined;
        break;
      }
      case "agent_message_chunk":
      case "agent_message": {
        const current = turn();
        const piece = update.sessionUpdate === "agent_message"
          ? (update.content ?? []).map(said).join("")
          : update.content?.type === "text" ? update.content.text : "";
        if (!current || !piece) break;
        if (!message || message.id !== update.messageId) message = { id: update.messageId, text: "" };
        message.text += piece;
        current.reply = message.text;
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const current = turn();
        if (current && update.title) {
          const id = String(update.toolCallId ?? "");
          const index = tools.get(id);
          if (index === undefined) {
            tools.set(id, current.tools.length);
            current.tools.push(String(update.title));
          } else current.tools[index] = String(update.title);
        }
        message = undefined;
        break;
      }
    }
  }
  return turns;
}

/** How long the record of a task's work may be, in characters, before its messages are shortened. */
export const RECORD_LIMIT = 12_000;
/** How much is kept of a message that is shortened. */
const SHORT = 300;
/** How much is kept of an input other than the user's: its first line, at most this long. */
const LINE = 160;

type Entry =
  | { kind: "said"; id: string; text: string }
  | { kind: "user"; id: string; text: string }
  | { kind: "input"; id: string; source: string; text: string }
  | { kind: "tool"; id: string; title: string; status: string };

/** Who an input other than the user's came from, as a record names it. */
function sourceOf(origin: OriginMeta): string {
  const who = origin.kind === "agent" ? origin.agentId : origin.kind === "system" ? "xsb" : origin.kind;
  return origin.role === "task_result" ? `task results for ${who}` : origin.role === "task" ? `task from ${who}` : `message from ${who}`;
}

const firstLine = (s: string): string => {
  const line = s.trim().split("\n")[0];
  return line.length > LINE ? `${line.slice(0, LINE)}…` : line;
};

/**
 * The record of the work on a task (docs/DESIGN.md 3.1, 10): what happened in its executor's session from the moment
 * its input got into the conversation, in order. Everything the agent said, in full; what the user said in the
 * meantime, in full; every other input and every tool call, a line each. Thoughts and what the tools returned are
 * left out, and so is the task's own input. Past `limit`, the messages but the last are shortened, then the tool
 * calls left out, then only the end kept. A record that is one message and nothing else is that message.
 */
export function taskRecord(store: Store, agentId: string, sessionId: string, taskId: string, limit = RECORD_LIMIT): string {
  const updates: any[] = [];
  for (const rec of store.readBackward(Paths.transcript(agentId, sessionId))) {
    const update = (rec as { update?: any }).update;
    if (boundaryOf(update)?.kind === "cleared") break;
    const origin: OriginMeta | undefined = update?._meta?.[OriginExt.key];
    if (update?.sessionUpdate === "user_message_chunk" && origin?.taskId === taskId && origin.role === "task") break;
    updates.push(update);
  }
  updates.reverse();

  const entries: Entry[] = [];
  const tools = new Map<string, Extract<Entry, { kind: "tool" }>>();
  for (const update of updates) {
    // Autonomous backend output is history, not the delivery of the task whose input precedes it.
    if (update?._meta?.[RunExt.key]?.turnId === null) continue;
    const last = entries.at(-1);
    switch (update?.sessionUpdate) {
      case "user_message_chunk": {
        const origin: OriginMeta = update._meta?.[OriginExt.key] ?? { kind: "user" };
        const id = String(update.messageId);
        const piece = said(update.content);
        if (last && last.kind !== "tool" && last.kind !== "said" && last.id === id) last.text += `\n${piece}`;
        else if (origin.kind === "user") entries.push({ kind: "user", id, text: piece });
        else entries.push({ kind: "input", id, source: sourceOf(origin), text: piece });
        break;
      }
      case "agent_message_chunk":
      case "agent_message": {
        const piece = update.sessionUpdate === "agent_message" ? (update.content ?? []).map(said).join("") : update.content?.type === "text" ? update.content.text : "";
        const id = String(update.messageId ?? "");
        if (last?.kind === "said" && last.id === id) last.text += piece;
        else if (piece) entries.push({ kind: "said", id, text: piece });
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const id = String(update.toolCallId ?? "");
        let entry = tools.get(id);
        if (!entry) {
          entry = { kind: "tool", id, title: "", status: "" };
          tools.set(id, entry);
          entries.push(entry);
        }
        if (update.title) entry.title = String(update.title);
        if (update.status) entry.status = String(update.status);
        break;
      }
    }
  }

  const lastSaid = entries.findLast((e) => e.kind === "said");
  if (entries.length === 1 && lastSaid) return lastSaid.text.trim();
  const line = (e: Entry, shorten: boolean, withTools: boolean): string | undefined => {
    switch (e.kind) {
      case "said": {
        const text = e.text.trim();
        return shorten && e !== lastSaid && text.length > SHORT ? `${text.slice(0, SHORT)}…` : text;
      }
      case "user":
        return `[the user] ${e.text.trim()}`;
      case "input":
        return `[${e.source}] ${firstLine(e.text)}`;
      case "tool":
        return withTools ? `[tool] ${e.title || "(untitled)"}${e.status ? `: ${e.status}` : ""}` : undefined;
    }
  };
  const render = (shorten: boolean, withTools: boolean): string =>
    entries
      .map((e) => line(e, shorten, withTools))
      .filter((l) => l)
      .join("\n");
  for (const [shorten, withTools] of [[false, true], [true, true], [true, false]] as const) {
    const text = render(shorten, withTools);
    if (text.length <= limit) return text;
  }
  return `…${render(true, false).slice(-limit)}`;
}
