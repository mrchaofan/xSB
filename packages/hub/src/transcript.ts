/**
 * What a session's transcript says, for a model that has to pick it up: the turns since the user last cleared the
 * context, read from the end of the transcript.
 *
 * A transcript (`agents/<id>/sessions/<sid>.jsonl`) is append-only and keeps everything that was said, also what the
 * model no longer sees. Where the model's view starts anew is a boundary record in it (`Boundaries` in
 * @xsb/protocol). So whatever decides what a model sees reads the transcript backward and stops at the first
 * boundary of the kind `cleared`: what lies before it is the user's to keep, not the model's to be given.
 */
import { Boundaries, OriginExt } from "@xsb/protocol";
import type { Boundary, ContentBlock, OriginMeta } from "@xsb/protocol";
import type { Store } from "@xsb/store";
import { Paths } from "./paths.ts";

/** One turn as a handoff tells it: what came in, the tools that ran, and what the agent said last. */
export type PastTurn = {
  at: string;
  inputs: { origin: OriginMeta; text: string }[];
  tools: string[];
  reply: string;
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
export function turnsSinceCleared(store: Store, agentId: string, sessionId: string): PastTurn[] {
  const records: { ts: string; update: any }[] = [];
  for (const rec of store.readBackward(Paths.transcript(agentId, sessionId))) {
    if (boundaryOf(rec.update)?.kind === "cleared") break;
    records.push(rec as { ts: string; update: any });
  }
  records.reverse();

  const turns: PastTurn[] = [];
  let input: { id: string; entry: PastTurn["inputs"][number] } | undefined;
  let message: { id: string; text: string } | undefined;
  const turn = (): PastTurn | undefined => turns.at(-1);
  for (const { ts, update } of records) {
    switch (update?.sessionUpdate) {
      case "user_message_chunk": {
        const origin: OriginMeta = update._meta?.[OriginExt.key] ?? { kind: "user" };
        if (input && input.id === update.messageId) {
          input.entry.text += `\n${said(update.content)}`;
          break;
        }
        const entry = { origin, text: said(update.content) };
        input = { id: update.messageId, entry };
        if (origin.steered && turn()) turn()!.inputs.push(entry);
        else turns.push({ at: ts, inputs: [entry], tools: [], reply: "" });
        message = undefined;
        break;
      }
      case "agent_message_chunk": {
        const current = turn();
        if (!current || update.content?.type !== "text") break;
        if (!message || message.id !== update.messageId) message = { id: update.messageId, text: "" };
        message.text += update.content.text;
        current.reply = message.text;
        break;
      }
      case "tool_call": {
        const current = turn();
        if (current && update.title) current.tools.push(String(update.title));
        message = undefined;
        break;
      }
    }
  }
  return turns;
}
